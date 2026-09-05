import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// LensGuard — camera (webcam) activity guard.
//
// The bar shows only a compact camera+shield glyph whose colour carries the
// state: calm steel when the camera is idle, yellow when a KNOWN app
// (whitelisted) holds /dev/video* open, red when an UNKNOWN process opens it,
// soft orange when detection cannot run (tools missing / no camera device).
// The process name appears next to the icon only while the camera is in use
// (LG-3: showProcessInBar, disabled by compactMode). Hovering gives a tooltip
// that names the process(es) using the camera. Left/right click toggles the
// small panel; middle click forces an immediate re-check.
//
// LG-2 behaviour:
//   * Whitelist lives in ~/.config/lensguard/config.json (mode 600 from the
//     first byte, atomic write). Missing/broken config -> calm defaults; the
//     panel can Allow/Deny processes and the change is written atomically.
//   * Camera opened by a process NOT on the whitelist -> exactly ONE Omarchy
//     notification ("LensGuard: camera opened by <command> (PID x)") plus a
//     journal line. Whitelisted apps stay calm (yellow "known app").
//   * Camera closed -> no popup; the tooltip briefly says who released it.
//   * Short event history is kept in memory AND in
//     ~/.local/state/lensguard/state.json (mode 600) so the panel shows
//     context after a shell restart. Restoring is display-only: the first
//     poll after startup is a silent baseline, so a restart while the camera
//     is open never re-alarms (MyIP lesson).
//
// LG-3 behaviour (config, settings, UX polish):
//   * The same config file now carries pollIntervalMs (clamped 250..5000 ms),
//     notifyOnOpen / notifyOnUnknown / showProcessInBar / compactMode plus the
//     whitelist. Missing keys -> defaults; a broken file -> calm defaults, a
//     calm panel note and a one-click Reset that restores defaults (mode 600)
//     and keeps the broken file as config.json.bak. Reset is also exposed
//     over shell IPC (resetConfig).
//   * The poll cadence honours pollIntervalMs; the heartbeat only ever runs
//     at most once per interval tick and never polls below the 250 ms floor.
//   * Notifications honour notifyOnOpen/notifyOnUnknown; a whitelisted app is
//     always calm.
//   * Definitive state icon set (camera lens + shield on a calm tile) with a
//     smooth cross-fade between states; bar text only when the camera is in
//     use.
//
// Detection: one cheap probe per second asks lsof (fallback fuser) which
// processes hold /dev/video* open. No polling spam by construction:
//   * at most ONE probe in flight, at most one per configured interval
//     (Model.clampPollInterval(config.pollIntervalMs), default 1000 ms) — the
//     tick gate + _activePoll guard;
//   * every probe runs on a *fresh* Process object (created per probe,
//     destroyed on exit). A single long-lived Quickshell Process reused many
//     times can lose an exit event and then report running forever, silently
//     stopping the widget (MI-5 lesson, MyIP); a fresh object keeps the
//     failure surface to one probe;
//   * _dueAt is a `double` epoch (Date.now() ~1.7e12) — an `int` would wrap
//     at 2^31 and turn the dueAt guard into polling-spam (DS-7 lesson);
//   * after every probe (success OR error) the next one is scheduled a full
//     interval away; in the calm error state the re-check cadence slows to
//     Model.ERROR_RECHECK_MS, so a missing device never hammers the system;
//   * a probe result that belongs to an older run (stale-result guard,
//     epoch check) is dropped.
//
// Probe self-heal (watchdog): a healthy probe finishes in milliseconds. The
// heartbeat checks that a running probe never exceeds
// Model.PROBE_WATCHDOG_MS (5 s). If it does, the exit event was lost or the
// child hung: the watchdog SIGKILLs the child, and if the Process still does
// not report an exit shortly after, the wedged Process object is dropped and
// the next probe starts on a fresh one — a single lost exit can never stall
// the widget again.
//
// The same MI-5 rule applies to every one-shot task the widget starts (the
// atomic state/config writes, the config reset and the two notification
// phases): each send/write runs on a FRESH Process object created per task
// and destroyed when the task ends, and the heartbeat watchdog applies the
// same kill-then-rebuild recovery (see "one-shot IO tasks" below) so a
// wedged writer can never stall persistence or the notification queue.
//
// The first successful poll after startup is a silent baseline: when the
// widget starts while the camera is already in use it shows `active`
// immediately but does not ring a false "opened" event (the panel only
// reports transitions that happen while LensGuard is watching).
BarWidget {
  id: root
  moduleName: "io.github.shirak-semonian.lensguard"

  // ---- config & state paths (user-controlled, no service) ---------------
  readonly property string configPath: {
    var base = Quickshell.env("XDG_CONFIG_HOME")
    if (!base) base = (Quickshell.env("HOME") || "") + "/.config"
    return base + "/lensguard/config.json"
  }
  readonly property string stateFile: {
    var base = Quickshell.env("XDG_STATE_HOME")
    if (!base) base = (Quickshell.env("HOME") || "") + "/.local/state"
    return base + "/lensguard/state.json"
  }
  readonly property string notifGateFile: {
    var base = Quickshell.env("XDG_STATE_HOME")
    if (!base) base = (Quickshell.env("HOME") || "") + "/.local/state"
    return base + "/lensguard/notifications.gate"
  }

  // ---- state -------------------------------------------------------------
  property var view: Model.initialView()
  property bool _primed: false
  // Whitelist config; defaults until a config file is read.
  property var config: Model.defaultConfig()
  property var _configRaw: null
  property string configErrorKind: ""
  property string _lastConfigRaw: ""
  property bool _configSeen: false
  property bool _configLoadFailed: false
  property double _configRetryAt: 0
  // Persisted history was restored (display-only) when the state file loaded.
  property bool _stateLoaded: false
  property string _lastStateText: ""
  property string _lastStateFp: ""
  property string _stateWritePending: ""
  property string _instanceId: ""
  // Millisecond epoch (Date.now() ~1.7e12): must be double, never int.
  property double _dueAt: 0
  property int _epoch: 0
  // Active probe (a fresh Process object per check) + watchdog state.
  property var _activePoll: null
  property double _pollDeadlineAt: 0
  property bool _pollKillSent: false
  property int _pollRecoveries: 0
  property string _logKey: ""
  // One-shot IO tasks (state/config/reset writes, notification phases) also
  // run on FRESH Process objects + the heartbeat watchdog (MI-5 rule).
  property var _stateWriter: null
  property string _stateWriteText: ""
  property bool _stateRecovered: false
  property var _configWriter: null
  property bool _configWriteQueued: false
  property bool _configRecovered: false
  property var _resetWriter: null
  property bool _resetRecovered: false
  property var _notifTask: null
  property string _notifPhase: ""

  // Icon cross-fade state (two stacked layers, see advanceIcon()).
  property bool _iconReady: false
  property int _iconLayer: 0
  property string _lastIconSource: ""
  // UI children (timer etc.) exist and live config changes may touch them.
  property bool _uiReady: false

  // ---- notification queue (serialized + cross-instance gate) -------------
  property var _notifQueue: []
  property var _notifPending: null
  property int _notifRecoveries: 0

  readonly property var whitelist: root.config.whitelist || Model.DEFAULT_WHITELIST

  // ---- display helpers ---------------------------------------------------
  readonly property color foreground: bar ? bar.barForeground : Color.foreground
  readonly property color dim: Qt.darker(foreground, 1.55)
  // Calm state palette (LG-3): the bar glyph, the process label and the
  // panel share these hues so a state reads identically everywhere.
  readonly property color calm: "#a3be8c"   // calm/ok accents (panel)
  readonly property color danger: "#bf616a" // unknown process / camera in use
  readonly property color warn: "#e6c384"   // known app / calm
  readonly property color notice: "#d08770" // detection unavailable (error)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  readonly property bool isLoading: Model.isLoading(root.view)
  readonly property bool isIdle: Model.isIdle(root.view)
  readonly property bool isActive: Model.isActive(root.view)
  readonly property bool isError: Model.isError(root.view)
  readonly property bool hasUnknown: Model.anyUnknown(root.view, root.whitelist)

  // Effective poll interval from the config (clamped 250..5000 ms). Changing
  // the config value live re-schedules the polling heartbeat (applyConfig).
  readonly property int pollIntervalMs: Model.clampPollInterval(
    root.config.pollIntervalMs)

  // Bar glyph per state: steel idle, yellow known-app, red unknown, soft
  // orange detection problem (see assets/icon-*.png).
  readonly property string statusIcon: root.isActive
    ? (root.hasUnknown ? "assets/icon-active.png" : "assets/icon-known.png")
    : (root.isError ? "assets/icon-error.png" : "assets/icon.png")
  readonly property real iconOpacity: root.isLoading ? 0.55 : 1.0

  // Bar text policy (LG-3): only while the camera is in use, only when the
  // user enabled it, never in compact mode (icon only). The label names the
  // process that matters most (unknown wins) + a count of the rest.
  readonly property bool processTextEnabled: root.config.showProcessInBar !== false
    && root.config.compactMode !== true
  readonly property string processBarText: root.isActive
    ? Model.barProcessText(root.view, root.whitelist) : ""

  readonly property string widgetTooltip: {
    var text = Model.tooltipText(root.view, Date.now())
    if (root.isActive && root.hasUnknown) {
      text += "\nUnknown process — not on your whitelist"
    }
    return text
  }

  // A state flip changes the glyph; cross-fade it instead of popping it.
  onStatusIconChanged: root.advanceIcon()

  // ---- panel popup -------------------------------------------------------
  // Shape contract for shell summon/hide/toggle routing:
  // Bar.findPanelWidget requires open/close/opened on the bar-widget root.
  readonly property bool opened: panelLoader.item
    ? panelLoader.item.opened === true
    : false

  function open() {
    if (panelLoader.item) panelLoader.item.open()
  }

  function close() {
    if (panelLoader.item) panelLoader.item.close()
  }

  function togglePanel() {
    if (panelLoader.item) panelLoader.item.toggle()
  }

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
  }

  function handlePressed(buttonCode) {
    if (buttonCode === Qt.MiddleButton) root.refreshNow()
    else root.togglePanel()
  }

  // Force an immediate re-check (middle click / panel button).
  function refreshNow() {
    root._dueAt = 0
    root.tick()
  }

  // Cross-fade the state glyph between two stacked image layers whenever the
  // state icon changes: the previously hidden layer loads the new icon and
  // fades in while the old one fades out (both have a Behavior on opacity),
  // so a status flip reads as a smooth transition, never a hard pop.
  function advanceIcon() {
    if (!root._iconReady) return
    var next = root.statusIcon
    if (!next || next === root._lastIconSource) return
    root._lastIconSource = next
    var showLayer = (root._iconLayer === 0) ? iconLayerB : iconLayerA
    var hideLayer = (root._iconLayer === 0) ? iconLayerA : iconLayerB
    showLayer.source = Qt.resolvedUrl(next)
    showLayer.opacity = 1
    hideLayer.opacity = 0
    root._iconLayer = (root._iconLayer === 0) ? 1 : 0
  }

  // ---- config handling ---------------------------------------------------
  // The config file is optional. Missing or broken -> calm defaults; the
  // camera guard never stops working because of a config typo.
  function applyConfig(raw) {
    if (raw === root._lastConfigRaw) return
    root._lastConfigRaw = raw
    root._configSeen = true
    root._configLoadFailed = false
    var parsed = Model.parseConfig(raw)
    if (!parsed.ok) {
      root.configErrorKind = parsed.kind
      root.config = Model.defaultConfig()
      root._configRaw = null
      console.warn("LensGuard: config problem (" + parsed.kind + ") — using defaults")
      root.applyPollIntervalChange()
      return
    }
    root.configErrorKind = ""
    root.config = parsed.config
    root._configRaw = parsed.raw || null
    root.applyPollIntervalChange()
  }

  // Keep the heartbeat cadence in sync with the configured poll interval.
  // The heartbeat interval is min(pollInterval, 1 s) so fast settings are
  // honoured promptly; the tick gate + _dueAt still prevent any polling
  // below the configured floor. Called whenever the config changes and once
  // at startup (Component.onCompleted) for configs read before the UI ready.
  function applyPollIntervalChange() {
    if (!root._uiReady) return
    var target = Math.max(100, Math.min(1000, root.pollIntervalMs))
    if (pollTimer.interval === target) return
    pollTimer.interval = target
    root._dueAt = 0
    pollTimer.restart()
  }

  function refreshConfig() {
    configFile.reload()
  }

  // Generic config patch from the UI (panel Allow/Deny + settings). Merges
  // the patch into the current in-memory config, then writes the FULL config
  // atomically (mode 600 from the first byte) so no key is ever dropped. The
  // user's unknown keys (raw) are preserved on write.
  function setConfigPatch(patch) {
    if (!patch || typeof patch !== "object") return
    var base = root.config || Model.defaultConfig()
    var cfg = {}
    var key
    for (key in base) {
      if (Object.prototype.hasOwnProperty.call(base, key)) cfg[key] = base[key]
    }
    for (key in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) cfg[key] = patch[key]
    }
    root._lastConfigRaw = ""
    root.config = cfg
    root.startConfigWrite()
  }

  function setConfigValue(key, value) {
    var patch = {}
    patch[key] = value
    root.setConfigPatch(patch)
  }

  // Add/remove a whitelist entry from the UI (panel Allow/Deny). Writes the
  // full config atomically, mode 600 from the first byte.
  function setWhitelistEntry(command, allowed) {
    if (!command) return
    var name = String(command).trim().toLowerCase()
    if (!name) return
    var list = (root.config.whitelist || []).slice()
    var idx = list.indexOf(name)
    if (allowed) {
      if (idx === -1) list.push(name)
    } else {
      if (idx !== -1) list.splice(idx, 1)
    }
    root.setConfigPatch({ whitelist: list })
  }

  function allowCommand(command) { root.setWhitelistEntry(command, true) }
  function denyCommand(command) { root.setWhitelistEntry(command, false) }

  // Reset the config to defaults (LG-3). The current file — even a broken
  // one — is kept as config.json.bak by the reset script; fresh defaults are
  // then written atomically, mode 600. Never echoes file content anywhere.
  function resetConfigToDefaults() {
    if (root._resetWriter) return
    var ok = root.startIoWrite("reset",
      Model.configResetCommandArgs(root.configPath))
    if (!ok) console.warn("LensGuard: could not start the config reset")
  }

  // Open the whitelist config in the user's editor (Omarchy fixed helper;
  // argv only, no shell).
  function openConfigFile() {
    var omarchyPath = Quickshell.env("OMARCHY_PATH")
    var launcher = omarchyPath
      ? omarchyPath + "/bin/omarchy-launch-config-editor"
      : "/usr/bin/omarchy-launch-config-editor"
    Quickshell.execDetached([launcher, root.configPath])
  }

  // ---- polling -----------------------------------------------------------
  // One heartbeat tick. Starts a probe only when none is in flight AND the
  // poll interval has elapsed — the actual polling cadence.
  function tick() {
    if (root._activePoll) return
    if (Date.now() < root._dueAt) return
    root.startProbe()
  }

  function startProbe() {
    if (root._activePoll) return
    var cmd = Model.probeCommand()
    if (!cmd || cmd.length === 0) return
    root.view = Model.reduce(root.view, { type: "probeStart", at: Date.now() })
    var poll = probeProcessComponent.createObject(root, {
      command: cmd,
      runEpoch: ++root._epoch
    })
    if (!poll) {
      console.warn("LensGuard: could not create the probe process")
      return
    }
    root._activePoll = poll
    root._pollKillSent = false
    root._pollDeadlineAt = Date.now() + Model.PROBE_WATCHDOG_MS
    poll.running = true
  }

  // Drop a probe Process object exactly once (createObject/destroy pair).
  function releasePoll(poll) {
    if (!poll || poll.released) return
    poll.released = true
    if (root._activePoll === poll) root._activePoll = null
    poll.destroy()
  }

  // Probe watchdog (called from the heartbeat). A healthy probe finishes
  // in milliseconds, so a probe still "running" past Model.PROBE_WATCHDOG_MS
  // has lost its exit event or its child hung. First strike: SIGKILL the
  // child and wait briefly for the exit event. Second strike: the Process
  // object itself is wedged — drop it and schedule a recovery probe on a
  // fresh object. Repeated recoveries back off to the normal interval so a
  // pathological environment can never turn into a retry loop.
  function checkPollWatchdog() {
    var poll = root._activePoll
    if (!poll) return
    if (Date.now() < root._pollDeadlineAt) return
    var intervalMs = root.pollIntervalMs
    if (!root._pollKillSent) {
      root._pollKillSent = true
      console.warn("LensGuard: probe watchdog — probe did not finish within "
        + Math.round(Model.PROBE_WATCHDOG_MS / 1000)
        + " s; killing the probe process")
      // Any late result from this run is now stale.
      ++root._epoch
      poll.runEpoch = -1
      try { poll.signal(9) } catch (error) { /* object may be gone */ }
      try { poll.running = false } catch (error) { /* ditto */ }
      root._pollDeadlineAt = Date.now() + 3000
      return
    }
    console.warn("LensGuard: probe watchdog — probe process did not recover; "
      + "rebuilding the probe process")
    ++root._epoch
    root._pollRecoveries++
    root.releasePoll(poll)
    root._dueAt = Date.now()
      + (root._pollRecoveries >= 3 ? intervalMs : 3000)
  }

  function handleProbeExited(poll, exitCode) {
    if (!poll) return
    var intervalMs = root.pollIntervalMs
    var killed = root._pollKillSent
    if (root._activePoll !== poll || poll.runEpoch !== root._epoch) {
      // Stale result: the watchdog already took over this run (killed +
      // epoch bumped), or a newer probe replaced it. Drop it.
      root.releasePoll(poll)
      if (killed && root._activePoll === null) {
        root._pollRecoveries++
        root._dueAt = Date.now()
          + (root._pollRecoveries >= 3 ? intervalMs : 10000)
      }
      return
    }
    root._pollRecoveries = 0
    root.releasePoll(poll)
    var output = String(poll.probeOutput || "")
    var parsed = Model.parseProbeOutput(exitCode, output)
    var at = Date.now()
    var next = null
    var events = []
    if (parsed.ok) {
      if (!root._primed) {
        // First successful probe: silent baseline, whatever is open right
        // now becomes the reference (no false "opened" after startup).
        root._primed = true
        var base = Model.applyProbe(root.view, {
          users: parsed.users, at: at, baseline: true
        })
        next = base.view
        events = []
      } else {
        var res = Model.applyProbe(root.view, {
          users: parsed.users, at: at, baseline: false
        })
        next = res.view
        events = res.events
      }
    } else {
      next = Model.reduce(root.view, {
        type: "probeError", kind: parsed.kind,
        message: parsed.message, at: at
      })
    }
    var key = next.status + "|" + (next.errorKind || "") + "|" + (next.lastEvent
      ? next.lastEvent.kind + "|" + (next.lastEvent.entry ? next.lastEvent.entry.pid : "")
      : "")
    if (key !== root._logKey) {
      root._logKey = key
      console.log("LensGuard: " + Model.statusLabel(next)
        + (Model.isActive(next) ? " (" + next.users.length + ")" : ""))
    }
    root.view = next
    root.persistState(next)
    // One notification per real open by a non-whitelisted process — gated by
    // the user's notifyOnOpen / notifyOnUnknown settings; closed events never
    // notify (the tooltip carries the calm return note).
    for (var i = 0; i < events.length; i++) {
      var ev = events[i]
      if (ev.kind !== "opened") continue
      if (!Model.shouldNotifyOnOpen(ev.process, root.whitelist, root.config)) continue
      root.enqueueNotification(ev.process)
    }
    // Whatever the outcome, the next probe is a full interval away; in the
    // calm error state the re-check cadence slows down. A failing probe can
    // never turn this into a tight retry loop.
    var delayMs = Model.isError(next) ? Model.ERROR_RECHECK_MS : intervalMs
    root._dueAt = Date.now() + delayMs
  }

  // ---- state file (history survives shell restarts) ----------------------
  // Persist only when something meaningful changed (status, history or the
  // last event) — never on every poll. savedAt inside the file may change,
  // so the write gate compares a stable fingerprint, not the full text.
  function stateFingerprint(next) {
    if (!next) return ""
    return next.status + "|"
      + JSON.stringify(next.history || []) + "|"
      + JSON.stringify(next.lastEvent || null)
  }

  function persistState(next) {
    if (!next) return
    var fp = root.stateFingerprint(next)
    if (fp === root._lastStateFp) return
    root._lastStateFp = fp
    // Nothing meaningful happened yet (fresh install, camera idle): do not
    // create an empty state file just because the first poll completed.
    if (next.status === "idle" && !next.lastEvent
      && (!next.history || next.history.length === 0)) return
    var text = Model.stateToText(next)
    root._lastStateText = text
    if (root._stateWriter) {
      // The writer is busy with an older snapshot; it will re-kick on exit
      // so the latest text always wins (coalescing, no lost updates).
      root._stateWritePending = text
      return
    }
    root.writeStateText(text)
  }

  // ---- notifications -----------------------------------------------------
  function enqueueNotification(processRow) {
    var summary = Model.notifySummary(processRow)
    var args = []
    var omarchyPath = Quickshell.env("OMARCHY_PATH")
    if (omarchyPath) args.push(omarchyPath + "/bin/omarchy-notification-send")
    else args.push("/usr/bin/omarchy-notification-send")
    args = args.concat(["--app-name", "LensGuard", "-u", "critical",
      "-g", "\uf030", summary,
      "An unknown process opened your camera. Allow it in the LensGuard panel if you trust it."])
    root._notifQueue.push({ key: "opened|" + processRow.pid + "|"
      + (processRow.command || ""), args: args, summary: summary })
    root.runNextNotification()
  }

  function runNextNotification() {
    if (root._notifTask) return
    if (root._notifQueue.length === 0) return
    var entry = root._notifQueue[0]
    root._notifQueue = root._notifQueue.slice(1)
    root._notifPending = entry
    root.startNotifPhase("notifGate", Model.notifGateCommandArgs(
      root.notifGateFile, entry.key, root._instanceId, Model.NOTIF_GATE_TTL_S))
  }

  // ---- one-shot IO tasks -------------------------------------------------
  // Every send/write the widget performs (the atomic state/config writes,
  // the config reset and the two notification phases) runs on a FRESH
  // Process object created per task and destroyed when the task ends — never
  // on a long-lived reused Process. A single Quickshell Process reused many
  // times can lose an exit event and then report running forever (MI-5
  // lesson, MyIP), silently stalling the state file, the config or the
  // notification queue. The heartbeat watchdog below applies the same
  // kill-then-rebuild recovery as the camera probe: first strike SIGKILLs
  // the child, second strike drops the wedged object and recovers the task
  // (writes are idempotent full-file writes, so a retry is always safe).

  function ioTaskSlot(kind) {
    if (kind === "state") return root._stateWriter
    if (kind === "config") return root._configWriter
    if (kind === "reset") return root._resetWriter
    if (kind === "notif") return root._notifTask
    return null
  }

  function clearIoTaskSlot(kind, task) {
    if (kind === "state" && root._stateWriter === task) root._stateWriter = null
    else if (kind === "config" && root._configWriter === task) root._configWriter = null
    else if (kind === "reset" && root._resetWriter === task) root._resetWriter = null
    else if (kind === "notif" && root._notifTask === task) root._notifTask = null
  }

  function releaseIoTask(task, kind) {
    if (!task || task.released) return
    task.released = true
    root.clearIoTaskSlot(kind, task)
    task.destroy()
  }

  // Fresh Process for a state/config/reset write (one-shot). Returns false
  // when the object could not be created; the caller reports it.
  function startIoWrite(kind, command) {
    var t = ioTaskComponent.createObject(root, { taskKind: kind, command: command })
    if (!t) return false
    t.taskDeadlineAt = Date.now() + Model.WRITE_WATCHDOG_MS
    if (kind === "state") root._stateWriter = t
    else if (kind === "config") root._configWriter = t
    else root._resetWriter = t
    t.running = true
    return true
  }

  // ---- state writes ------------------------------------------------------
  function writeStateText(text) {
    if (root._stateWriter) {
      // A writer is already running; it re-kicks on exit, latest text wins.
      root._stateWritePending = text
      return
    }
    root._stateWriteText = text
    var ok = root.startIoWrite("state",
      Model.writeStateCommandArgs(root.stateFile, text))
    if (!ok) console.warn("LensGuard: could not start the state write")
  }

  // ---- config writes / reset ---------------------------------------------
  function startConfigWrite() {
    if (root._configWriter) {
      // Busy: one more write after the current one finishes, always with the
      // latest in-memory config (last write wins, never a dropped change).
      root._configWriteQueued = true
      return
    }
    var ok = root.startIoWrite("config",
      Model.writeConfigCommandArgs(root.configPath, root.config, root._configRaw))
    if (!ok) console.warn("LensGuard: could not start the settings write")
  }

  // ---- notifications (gate phase, then send phase) -----------------------
  function startNotifPhase(kind, command) {
    if (root._notifTask) return
    if (!command || command.length === 0) {
      root._notifPending = null
      Qt.callLater(root.runNextNotification)
      return
    }
    root._notifPhase = (kind === "notifSend") ? "send" : "gate"
    var t = ioTaskComponent.createObject(root, { taskKind: kind, command: command })
    if (!t) {
      console.warn("LensGuard: could not create the notification process")
      root._notifPending = null
      Qt.callLater(root.runNextNotification)
      return
    }
    root._notifTask = t
    // The gate waits on a bounded flock (Model.NOTIF_GATE_FLOCK_WAIT_S), so
    // this budget comfortably covers both phases without ever stalling the
    // queue forever when an exit event is lost.
    t.taskDeadlineAt = Date.now() + Model.NOTIF_WATCHDOG_MS
    t.running = true
  }

  // Exit dispatcher for every one-shot task (writes and notification
  // phases). A task killed by the watchdog is NOT treated as a normal
  // completion; it goes through recoverIoTask() instead so a wedged writer
  // can never fake a successful write.
  function handleIoTaskExited(task, exitCode) {
    if (!task || task.released) return
    var kind = String(task.taskKind || "")
    if (root.ioTaskSlot(kind) !== task) {
      // Stale runner: the watchdog already dropped it.
      root.releaseIoTask(task, kind)
      return
    }
    // Read the output before the runner is destroyed (deleteLater).
    var gate = (kind === "notifGate")
      ? String(task.taskOutput || "").trim() : ""
    if (task.taskKillSent) {
      root.releaseIoTask(task, kind)
      console.warn("LensGuard: " + kind + " task was killed by the watchdog")
      root.recoverIoTask(kind)
      return
    }
    root.releaseIoTask(task, kind)
    if (kind === "state") {
      if (exitCode !== 0) console.warn("LensGuard: could not persist the event history")
      root._stateRecovered = false
      if (root._stateWritePending !== "") {
        var pending = root._stateWritePending
        root._stateWritePending = ""
        root.writeStateText(pending)
      }
    } else if (kind === "config") {
      if (exitCode !== 0) console.warn("LensGuard: could not write the settings config")
      else root.refreshConfig()
      root._configRecovered = false
      if (root._configWriteQueued) {
        root._configWriteQueued = false
        root.startConfigWrite()
      }
    } else if (kind === "reset") {
      if (exitCode !== 0) console.warn("LensGuard: could not reset the settings config")
      else {
        console.log("LensGuard: settings reset to defaults (previous file kept as config.json.bak)")
        root.refreshConfig()
      }
      root._resetRecovered = false
    } else if (kind === "notifGate") {
      root._notifRecoveries = 0
      var entry = root._notifPending
      if (gate === "send" && entry && entry.args) {
        console.log("LensGuard: notification — " + entry.summary)
        root.startNotifPhase("notifSend", entry.args)
        return
      }
      root._notifPending = null
      Qt.callLater(root.runNextNotification)
    } else if (kind === "notifSend") {
      if (exitCode !== 0) console.warn("LensGuard: could not send the camera notification")
      root._notifRecoveries = 0
      root._notifPending = null
      Qt.callLater(root.runNextNotification)
    }
  }

  // Heartbeat watchdog for the one-shot IO tasks (mirrors the probe
  // watchdog). A healthy task finishes in milliseconds, so a task still
  // running past its deadline has lost its exit event or its child hung.
  function checkTaskWatchdog() {
    root.checkOneTaskWatchdog("state")
    root.checkOneTaskWatchdog("config")
    root.checkOneTaskWatchdog("reset")
    root.checkOneTaskWatchdog("notif")
  }

  function checkOneTaskWatchdog(kind) {
    var t = root.ioTaskSlot(kind)
    if (!t) return
    if (Date.now() < t.taskDeadlineAt) return
    if (!t.taskKillSent) {
      t.taskKillSent = true
      console.warn("LensGuard: " + kind + " task did not finish in time; killing it")
      try { t.signal(9) } catch (error) { /* object may be gone */ }
      try { t.running = false } catch (error) { /* ditto */ }
      t.taskDeadlineAt = Date.now() + 3000
      return
    }
    console.warn("LensGuard: " + kind + " task did not recover; dropping the wedged process")
    root.releaseIoTask(t, kind)
    root.recoverIoTask(kind)
  }

  // Recovery after the watchdog dropped a wedged Process. Writes retry once
  // (idempotent full-file writes); a second consecutive failure gives up
  // with a warning instead of looping. Notifications re-run the gate for
  // the same entry (the gate is instance-aware: its own earlier record never
  // suppresses the retry, so exactly one notification is sent), but a wedged
  // SEND phase is treated as delivered — never resent — to preserve the
  // "exactly one notification" guarantee.
  function recoverIoTask(kind) {
    if (kind === "state") {
      if (root._stateRecovered) {
        console.warn("LensGuard: event history write keeps failing; the next camera event will write the full history again")
        root._stateWritePending = ""
        return
      }
      root._stateRecovered = true
      var text = root._stateWritePending !== ""
        ? root._stateWritePending : root._stateWriteText
      root._stateWritePending = ""
      if (text === "") return
      console.warn("LensGuard: retrying the event history write")
      root.writeStateText(text)
    } else if (kind === "config") {
      if (root._configRecovered) {
        console.warn("LensGuard: settings write keeps failing; it will be written on the next settings change")
        root._configWriteQueued = false
        return
      }
      root._configRecovered = true
      console.warn("LensGuard: retrying the settings write")
      // The retry IS the queued write when one is pending; clear the flag so
      // the retry's natural exit does not start a duplicate write.
      root._configWriteQueued = false
      root.startConfigWrite()
    } else if (kind === "reset") {
      if (root._resetRecovered) {
        console.warn("LensGuard: config reset keeps failing; the previous config was kept")
        return
      }
      root._resetRecovered = true
      console.warn("LensGuard: retrying the config reset")
      root.resetConfigToDefaults()
    } else if (kind === "notif") {
      var entry = root._notifPending
      if (root._notifPhase === "send" || !entry) {
        // Send exit event lost: at-most-once — move on without resending.
        root._notifPending = null
        Qt.callLater(root.runNextNotification)
        return
      }
      root._notifRecoveries++
      if (root._notifRecoveries >= 3) {
        console.warn("LensGuard: camera notification gate keeps failing; dropping this notification")
        root._notifPending = null
        Qt.callLater(root.runNextNotification)
        return
      }
      console.warn("LensGuard: notification gate did not recover; re-running it")
      root._notifQueue = [entry].concat(root._notifQueue)
      root._notifPending = null
      Qt.callLater(root.runNextNotification)
    }
  }

  // ---- layout ------------------------------------------------------------
  // Reserve only the visible content + the clickable margins: a compact
  // glyph (with optional process name while the camera is in use) — never
  // empty reserved space.
  implicitWidth: barContent.implicitWidth + Style.space(12)
  implicitHeight: root.barSize

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()

  // Heartbeat. Runs the tick gate at min(pollInterval, 1 s); tick() itself
  // decides when a probe may actually start (idle process + interval
  // elapsed), so the cadence always honours pollIntervalMs without ever
  // polling below the 250 ms floor.
  Timer {
    id: pollTimer
    interval: 1000
    repeat: true
    running: true
    triggeredOnStart: true
    onTriggered: {
      // Probe self-heal first: a probe that overruns its deadline is killed /
      // rebuilt regardless of the gate below. The one-shot IO tasks
      // (state/config writes, notification phases) get the same watchdog.
      root.checkPollWatchdog()
      root.checkTaskWatchdog()
      // Wait for the initial state-file read so a restored history can never
      // race the first live event (display ordering stays newest-first).
      if (!root._stateLoaded) {
        stateFileView.reload()
        return
      }
      // Initial config attempt first; a missing config retries calmly at a
      // 10 s cadence without ever blocking the camera probe.
      if (!root._configSeen) {
        configFile.reload()
        return
      }
      if (root._configLoadFailed && Date.now() >= root._configRetryAt) {
        root._configRetryAt = Date.now() + 10000
        configFile.reload()
      }
      root.tick()
    }
  }

  // Probe Process factory. Every poll runs on a fresh Process object so a
  // wedged Process (lost exit event, MI-5) can never stall polling forever:
  // the object is created per request and destroyed on exit / watchdog
  // recovery. See startProbe()/handleProbeExited()/checkPollWatchdog().
  Component {
    id: probeProcessComponent
    Process {
      id: probePoll
      property int runEpoch: 0
      property string probeOutput: ""
      property bool released: false
      command: []
      stdout: StdioCollector {
        waitForEnd: true
        onStreamFinished: probePoll.probeOutput = text
      }
      onExited: function(exitCode) {
        root.handleProbeExited(probePoll, exitCode)
      }
    }
  }

  // Optional whitelist config (~/.config/lensguard/config.json). Watched so
  // an external edit is applied live. Missing/broken -> calm defaults.
  FileView {
    id: configFile
    path: root.configPath
    watchChanges: true
    atomicWrites: true
    printErrors: false
    onLoaded: root.applyConfig(text())
    onFileChanged: reload()
    onLoadFailed: {
      // File does not exist (yet) or is unreadable: defaults keep working.
      root._lastConfigRaw = null
      root._configSeen = true
      root._configLoadFailed = true
      root._configRetryAt = Date.now() + 10000
      root.configErrorKind = ""
      root.config = Model.defaultConfig()
      root._configRaw = null
    }
  }

  // Persisted history (display-only restore). Watch is off on purpose: the
  // file is only read once at startup; every write goes through the atomic
  // writer above, never through this view. A missing file is fine.
  FileView {
    id: stateFileView
    path: root.stateFile
    watchChanges: false
    atomicWrites: true
    printErrors: false
    onLoaded: {
      var history = Model.historyFromStateText(text())
      root._stateLoaded = true
      if (history.length > 0) {
        root.view = Model.reduce(root.view, { type: "restoreHistory", history: history })
      }
    }
    onLoadFailed: {
      root._stateLoaded = true
    }
  }

  // One-shot IO task factory. State/config/reset writes and the two
  // notification phases run on a FRESH Process object per task (created on
  // demand, destroyed on exit / watchdog recovery) — the same MI-5 rule as
  // the probe factory above, so a wedged writer can never silently stall the
  // state file, the config or the notification queue. The task object
  // carries its kind + deadline for the heartbeat watchdog; the per-kind
  // completion logic lives in handleIoTaskExited()/recoverIoTask().
  Component {
    id: ioTaskComponent
    Process {
      id: ioTaskProcess
      property string taskKind: ""
      property string taskOutput: ""
      property bool released: false
      property double taskDeadlineAt: 0
      property bool taskKillSent: false
      command: []
      stdout: StdioCollector {
        waitForEnd: true
        onStreamFinished: ioTaskProcess.taskOutput = text
      }
      onExited: function(exitCode) {
        root.handleIoTaskExited(ioTaskProcess, exitCode)
      }
    }
  }

  Component.onCompleted: {
    root._instanceId = String(Math.floor(Math.random() * 0x7fffffff))
      + "-" + String(Date.now())
    // Start the icon cross-fade with the current state already in place.
    root._lastIconSource = root.statusIcon
    iconLayerA.source = Qt.resolvedUrl(root.statusIcon)
    root._iconLayer = 0
    root._iconReady = true
    // The config may already have been read before the timer existed; sync
    // the heartbeat cadence to the configured poll interval now.
    root._uiReady = true
    root.applyPollIntervalChange()
  }

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  // Shell IPC: `omarchy-shell shell summon|hide|toggle <id>` routes here.
  IpcHandler {
    target: root.moduleName
    function refresh(): void { root.refreshNow() }
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.togglePanel() }
    function allow(command) { root.allowCommand(command) }
    function deny(command) { root.denyCommand(command) }
    function resetConfig() { root.resetConfigToDefaults() }
  }

  // Full-size interaction layer with a hidden label; the content below (plain
  // visuals — they do not consume mouse events) sits on top, so
  // hover/press/tooltip all still land on this button.
  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: " "
    labelVisible: false
    tooltipText: root.widgetTooltip
    onPressed: function(buttonCode) {
      root.handlePressed(buttonCode)
    }
  }

  // Visible bar content: state glyph + (only while the camera is in use and
  // the user allowed it) the process name. Both are plain visuals above the
  // WidgetButton, so every mouse interaction stays on the button.
  Row {
    id: barContent
    anchors.centerIn: parent
    spacing: Style.space(5)

    // State glyph with a two-layer cross-fade (see advanceIcon()).
    Item {
      id: iconBox
      width: 18
      height: 18
      opacity: root.iconOpacity

      Behavior on opacity {
        NumberAnimation { duration: 180; easing.type: Easing.OutCubic }
      }

      Image {
        id: iconLayerA
        anchors.fill: parent
        source: ""
        sourceSize.width: 128
        sourceSize.height: 128
        fillMode: Image.PreserveAspectFit
        smooth: true
        opacity: 1

        Behavior on opacity {
          NumberAnimation { duration: 200; easing.type: Easing.OutCubic }
        }
      }

      Image {
        id: iconLayerB
        anchors.fill: parent
        source: ""
        sourceSize.width: 128
        sourceSize.height: 128
        fillMode: Image.PreserveAspectFit
        smooth: true
        opacity: 0

        Behavior on opacity {
          NumberAnimation { duration: 200; easing.type: Easing.OutCubic }
        }
      }
    }

    Text {
      id: barProcessLabel
      anchors.verticalCenter: parent.verticalCenter
      visible: root.processTextEnabled && root.processBarText !== ""
      text: root.processBarText
      color: root.hasUnknown ? root.danger : root.warn
      font.family: root.fontFamily
      font.pixelSize: Style.font.body
      verticalAlignment: Text.AlignVCenter
      elide: Text.ElideRight
      maximumLineCount: 1
      // A long command line must never stretch the bar slot; elide past a
      // calm max width.
      width: Math.min(implicitWidth, 150)

      Behavior on color {
        enabled: !root.bar || root.bar.foregroundAnimationEnabled
        ColorAnimation { duration: 160 }
      }
    }
  }
}
