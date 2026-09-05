import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// LensGuard — camera (webcam) activity guard.
//
// The bar shows only a compact camera glyph whose colour carries the state:
// calm grey when the camera is idle, yellow when a KNOWN app (whitelisted)
// holds /dev/video* open, red when an UNKNOWN process opens it, amber when
// detection cannot run (tools missing / no camera device). Hovering gives a
// tooltip that names the process(es) using the camera. Left/right click
// toggles the small panel; middle click forces an immediate re-check.
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
// Detection: one cheap probe per second asks lsof (fallback fuser) which
// processes hold /dev/video* open. No polling spam by construction:
//   * at most ONE probe in flight, at most one per second
//     (Model.DEFAULT_POLL_INTERVAL_MS) — the tick gate + _activePoll guard;
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
// 1 s heartbeat checks that a running probe never exceeds
// Model.PROBE_WATCHDOG_MS (5 s). If it does, the exit event was lost or the
// child hung: the watchdog SIGKILLs the child, and if the Process still does
// not report an exit shortly after, the wedged Process object is dropped and
// the next probe starts on a fresh one — a single lost exit can never stall
// the widget again.
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

  // ---- notification queue (serialized + cross-instance gate) -------------
  property var _notifQueue: []
  property var _notifPending: null
  property bool _notifGateMode: false
  property string _notifOut: ""

  readonly property var whitelist: root.config.whitelist || Model.DEFAULT_WHITELIST

  // ---- display helpers ---------------------------------------------------
  readonly property color foreground: bar ? bar.barForeground : Color.foreground
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property color danger: "#bf616a" // unknown process / camera in use
  readonly property color warn: "#ebcb8b"   // known app / calm
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  readonly property bool isLoading: Model.isLoading(root.view)
  readonly property bool isIdle: Model.isIdle(root.view)
  readonly property bool isActive: Model.isActive(root.view)
  readonly property bool isError: Model.isError(root.view)
  readonly property bool hasUnknown: Model.anyUnknown(root.view, root.whitelist)

  // Bar glyph per state: grey idle, yellow known-app, red unknown, amber
  // detection problem.
  readonly property string statusIcon: root.isActive
    ? (root.hasUnknown ? "assets/icon-active.png" : "assets/icon-known.png")
    : (root.isError ? "assets/icon-error.png" : "assets/icon.png")
  readonly property real iconOpacity: root.isLoading ? 0.55 : 1.0

  readonly property string widgetTooltip: {
    var text = Model.tooltipText(root.view, Date.now())
    if (root.isActive && root.hasUnknown) {
      text += "\nUnknown process — not on your whitelist"
    }
    return text
  }

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
      return
    }
    root.configErrorKind = ""
    root.config = parsed.config
    root._configRaw = parsed.raw || null
  }

  function refreshConfig() {
    configFile.reload()
  }

  // Add/remove a whitelist entry from the UI (panel Allow/Deny). Writes the
  // config atomically, mode 600 from the first byte.
  function setWhitelistEntry(command, allowed) {
    if (!command) return
    var name = String(command).trim().toLowerCase()
    if (!name) return
    var list = root.whitelist.slice()
    var idx = list.indexOf(name)
    if (allowed) {
      if (idx === -1) list.push(name)
    } else {
      if (idx !== -1) list.splice(idx, 1)
    }
    var cfg = { whitelist: list }
    root._lastConfigRaw = ""
    root.config = cfg
    configWriteProc.command = Model.writeConfigCommandArgs(
      root.configPath, cfg, root._configRaw)
    configWriteProc.running = true
  }

  function allowCommand(command) { root.setWhitelistEntry(command, true) }
  function denyCommand(command) { root.setWhitelistEntry(command, false) }

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

  // Probe watchdog (called from the 1 s heartbeat). A healthy probe finishes
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
    var intervalMs = Model.DEFAULT_POLL_INTERVAL_MS
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
    var intervalMs = Model.DEFAULT_POLL_INTERVAL_MS
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
    // One notification per real open by a non-whitelisted process; closed
    // never notifies (tooltip carries the calm return note).
    for (var i = 0; i < events.length; i++) {
      var ev = events[i]
      if (ev.kind !== "opened") continue
      if (!Model.shouldNotifyOnOpen(ev.process, root.whitelist)) continue
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
    if (stateWriteProc.running) {
      // The writer is busy with an older snapshot; it will re-kick on exit
      // so the latest text always wins (coalescing, no lost updates).
      root._stateWritePending = text
      return
    }
    stateWriteProc.command = Model.writeStateCommandArgs(root.stateFile, text)
    stateWriteProc.running = true
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
    if (notifProc.running) return
    if (root._notifQueue.length === 0) return
    var entry = root._notifQueue[0]
    root._notifQueue = root._notifQueue.slice(1)
    root._notifPending = entry
    root._notifGateMode = true
    root._notifOut = ""
    notifProc.command = Model.notifGateCommandArgs(root.notifGateFile,
      entry.key, root._instanceId, 25)
    notifProc.running = true
  }

  function finishNotification(exitCode, output) {
    if (root._notifGateMode) {
      root._notifGateMode = false
      var gate = String(output == null ? "" : output).trim()
      var entry = root._notifPending
      root._notifPending = null
      if (gate === "send" && entry && entry.args) {
        console.log("LensGuard: notification — " + entry.summary)
        notifProc.command = entry.args
        notifProc.running = true
        return
      }
      Qt.callLater(root.runNextNotification)
      return
    }
    root._notifPending = null
    Qt.callLater(root.runNextNotification)
  }

  // ---- layout ------------------------------------------------------------
  // Reserve only the icon + the clickable margins; the bar slot matches the
  // visible content (a compact glyph — no text in the bar).
  implicitWidth: iconImage.width + Style.space(12)
  implicitHeight: root.barSize

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()

  // Heartbeat. Runs the tick gate once per second; tick() itself decides
  // when a probe may actually start (idle process + interval elapsed).
  Timer {
    id: pollTimer
    interval: 1000
    repeat: true
    running: true
    triggeredOnStart: true
    onTriggered: {
      // Probe self-heal first: a probe that overruns its deadline is killed /
      // rebuilt regardless of the gate below.
      root.checkPollWatchdog()
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

  Process {
    id: configWriteProc
    command: []
    onExited: function(exitCode) {
      if (exitCode !== 0) {
        console.warn("LensGuard: could not write the whitelist config")
        return
      }
      root.refreshConfig()
    }
  }

  Process {
    id: stateWriteProc
    command: []
    onExited: function(exitCode) {
      if (exitCode !== 0) {
        console.warn("LensGuard: could not persist the event history")
      }
      // Coalescing: if a newer snapshot arrived while this write ran, write
      // it now (the latest state always wins; no lost history updates).
      if (root._stateWritePending !== "") {
        var pending = root._stateWritePending
        root._stateWritePending = ""
        root._lastStateText = pending
        stateWriteProc.command = Model.writeStateCommandArgs(root.stateFile, pending)
        stateWriteProc.running = true
      }
    }
  }

  Process {
    id: notifProc
    command: []
    stdout: StdioCollector {
      id: notifStdout
      waitForEnd: true
      onStreamFinished: root._notifOut = text
    }
    onExited: function(exitCode) {
      var output = String(notifStdout.text || root._notifOut || "")
      root._notifOut = ""
      root.finishNotification(exitCode, output)
    }
  }

  Component.onCompleted: {
    root._instanceId = String(Math.floor(Math.random() * 0x7fffffff))
      + "-" + String(Date.now())
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
  }

  // Full-size interaction layer with a hidden label; the camera glyph below
  // (a plain visual — it does not consume mouse events) sits on top, so
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

  Image {
    id: iconImage
    anchors.centerIn: parent
    width: 16
    height: 16
    source: Qt.resolvedUrl(root.statusIcon)
    sourceSize.width: 128
    sourceSize.height: 128
    fillMode: Image.PreserveAspectFit
    smooth: true
    opacity: root.iconOpacity

    Behavior on opacity {
      NumberAnimation { duration: 180; easing.type: Easing.OutCubic }
    }
  }
}
