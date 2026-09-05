import QtQuick
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// LensGuard — camera (webcam) activity guard.
//
// The bar shows only a compact camera glyph whose colour carries the state:
// calm grey when the camera is idle, red when a process holds /dev/video*
// open, amber when detection cannot run (tools missing / no camera device).
// Hovering gives a tooltip that names the process(es) using the camera.
// Left/right click toggles the small panel; middle click forces an
// immediate re-check.
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

  // ---- state -------------------------------------------------------------
  property var view: Model.initialView()
  property bool _primed: false
  // Millisecond epoch (Date.now() ~1.7e12): must be double, never int.
  property double _dueAt: 0
  property int _epoch: 0
  // Active probe (a fresh Process object per check) + watchdog state.
  property var _activePoll: null
  property double _pollDeadlineAt: 0
  property bool _pollKillSent: false
  property int _pollRecoveries: 0
  property string _logKey: ""

  // ---- display helpers ---------------------------------------------------
  readonly property color foreground: bar ? bar.barForeground : Color.foreground
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property color danger: "#bf616a" // camera in use
  readonly property color warn: "#ebcb8b"   // detection problem
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  readonly property bool isLoading: Model.isLoading(root.view)
  readonly property bool isIdle: Model.isIdle(root.view)
  readonly property bool isActive: Model.isActive(root.view)
  readonly property bool isError: Model.isError(root.view)

  // One camera glyph per state: calm grey, attention red, problem amber.
  readonly property string statusIcon: root.isActive
    ? "assets/icon-active.png"
    : (root.isError ? "assets/icon-error.png" : "assets/icon.png")
  readonly property real iconOpacity: root.isLoading ? 0.55 : 1.0

  readonly property string widgetTooltip: Model.tooltipText(root.view)

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
    if (parsed.ok) {
      if (!root._primed) {
        // First successful probe: silent baseline, whatever is open right
        // now becomes the reference (no false "opened" after startup).
        root._primed = true
        next = Model.reduce(root.view, {
          type: "probeOk", users: parsed.users, at: at, baseline: true
        })
      } else {
        next = Model.reduce(root.view, {
          type: "probeOk", users: parsed.users, at: at, baseline: false
        })
      }
    } else {
      next = Model.reduce(root.view, {
        type: "probeError", kind: parsed.kind,
        message: parsed.message, at: at
      })
    }
    var key = next.status + "|" + (next.errorKind || "")
    if (key !== root._logKey) {
      root._logKey = key
      console.log("LensGuard: " + Model.statusLabel(next)
        + (Model.isActive(next) ? " (" + next.users.length + ")" : ""))
    }
    root.view = next
    // Whatever the outcome, the next probe is a full interval away; in the
    // calm error state the re-check cadence slows down. A failing probe can
    // never turn this into a tight retry loop.
    var delayMs = Model.isError(next) ? Model.ERROR_RECHECK_MS : intervalMs
    root._dueAt = Date.now() + delayMs
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
