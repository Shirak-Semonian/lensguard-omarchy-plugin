// Pure logic for the LensGuard bar widget: camera (webcam) activity detection.
//
// LensGuard watches which processes hold /dev/video* open. Any app that uses
// the camera keeps the video device node open for the whole session — also
// browsers, because PipeWire opens the device on their behalf — so a listing
// of openers is an exact "camera in use right now" signal.
//
// This file is plain ECMAScript shared by two runtimes:
//   - BarWidget.qml / Panel.qml import it as a QML JS module;
//   - test-model.js requires it from Node (see the module.exports guard at
//     the bottom).
//
// Polling (the process spawning, the 1 s cadence and the watchdog) lives in
// BarWidget.qml; this file only decides WHAT to run (probe script), how to
// READ the probe output (lsof -F records or fuser -v table), how to diff one
// poll against the previous one (opened/closed events) and what to display.
// No shell, no Qt, no Node built-ins — the same code runs in both runtimes.

// ---------------------------------------------------------------------------
// Detection method (verified live during development)
// ---------------------------------------------------------------------------
// Primary probe: `lsof -F pcun /dev/video*` — machine readable, exact per
// process: p<PID>, c<command>, u<user-id>, n<device path>. Exit codes are NOT
// reliable for lsof (it returns 1 both when nothing is open AND when it could
// not stat unrelated mounts), so the parser works on stdout only.
// Fallback probe: `fuser -v /dev/video*` — human table (USER PID ACCESS
// COMMAND) grouped under `/dev/videoN:` headers; used only when lsof is
// missing (both tools are verified present on the reference system).
// When neither tool exists or no /dev/video* device exists the probe prints a
// stable marker line and the widget shows a calm error state instead of
// spamming.

var DEFAULT_POLL_INTERVAL_MS = 1000;   // poll about once per second (max)
var MIN_POLL_INTERVAL_MS = 1000;       // never probe faster than this
var ERROR_RECHECK_MS = 5000;           // calm re-check cadence in error state
var PROBE_WATCHDOG_MS = 5000;          // kill a probe that hangs this long
var PROBE_ERROR_AFTER = 2;             // consecutive transient failures -> error
var MAX_OUTPUT_CHARS = 65536;          // parser cap (64 KiB), defensive

var ERR_NO_TOOL = "__LG_ERR_NO_TOOL__";
var ERR_NO_DEVICE = "__LG_ERR_NO_DEVICE__";

var STATUS_LOADING = "loading";
var STATUS_IDLE = "idle";
var STATUS_ACTIVE = "active";
var STATUS_ERROR = "error";

// Deterministic probe failures (no tool / no device). They describe the
// environment, not a transient glitch, so one observation is enough to enter
// the error state and the widget re-checks at a calm cadence.
function isDeterministicErrorKind(kind) {
  return kind === "no-tool" || kind === "no-device";
}

// Static, user-facing sentences. Never raw tool output (lsof/fuser can echo
// arbitrary process state); the parser turns output into structured entries
// and only these fixed sentences reach the UI.
function errorMessageFor(kind) {
  if (kind === "no-tool") {
    return "camera detection tools are missing (needs lsof or fuser)";
  }
  if (kind === "no-device") {
    return "no camera device found (/dev/video*)";
  }
  if (kind === "parse") {
    return "unexpected camera probe output";
  }
  return "camera check failed";
}

// ---------------------------------------------------------------------------
// Probe command (pure argv construction — the widget spawns exactly this)
// ---------------------------------------------------------------------------
// One `bash -c` wrapper is used only for the /dev/video* glob (Quickshell's
// Process has no shell). The script prefers lsof, falls back to fuser, prints
// a stable marker when neither tool nor any device exists, and never leaves a
// process behind (exec replaces the shell; plain lsof/fuser calls exit).
function probeScript() {
  return ""
    + "if command -v lsof >/dev/null 2>&1; then\n"
    + "  set -- /dev/video* 2>/dev/null\n"
    + "  [ -e \"$1\" ] || { echo '" + ERR_NO_DEVICE + "'; exit 0; }\n"
    + "  exec lsof -F pcun \"$@\" 2>/dev/null\n"
    + "fi\n"
    + "if command -v fuser >/dev/null 2>&1; then\n"
    + "  set -- /dev/video* 2>/dev/null\n"
    + "  [ -e \"$1\" ] || { echo '" + ERR_NO_DEVICE + "'; exit 0; }\n"
    + "  exec fuser -v \"$@\" 2>&1\n"
    + "fi\n"
    + "echo '" + ERR_NO_TOOL + "'\n";
}

function probeCommand() {
  return ["bash", "-c", probeScript()];
}

// ---------------------------------------------------------------------------
// Parsing: lsof -F pcun
// ---------------------------------------------------------------------------
// Record format (one group per process, fields can repeat/order freely):
//   p77000        process id
//   cv4l2-ctl       command name
//   u1000           user id
//   n/dev/video0    open file path (repeatable; dedupe per process)
// A process can hold the same device twice (mmap + fd) and can hold several
// devices at once (video0 capture + video1 metadata), so output is flattened
// to one entry per (pid, device) pair.

function parseLsofOutput(text) {
  var users = [];
  if (!text) return users;
  var capped = String(text);
  if (capped.length > MAX_OUTPUT_CHARS) capped = capped.substring(0, MAX_OUTPUT_CHARS);
  var lines = capped.split("\n");
  var byPid = {};
  var order = [];
  var current = null;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line) continue;
    var code = line.charAt(0);
    var value = line.substring(1);
    if (code === "p") {
      if (!byPid[value]) {
        byPid[value] = { pid: value, command: "", user: "", devices: {} };
        order.push(value);
      }
      current = byPid[value];
    } else if (current) {
      if (code === "c") {
        current.command = value;
      } else if (code === "u") {
        current.user = value;
      } else if (code === "n" && isVideoDevice(value)) {
        current.devices[value] = true;
      }
    }
  }
  for (var oi = 0; oi < order.length; oi++) {
    var entry = byPid[order[oi]];
    var devs = Object.keys(entry.devices);
    if (devs.length === 0) continue; // process without a matching open device
    devs.sort();
    for (var di = 0; di < devs.length; di++) {
      users.push({
        device: devs[di],
        pid: entry.pid,
        user: entry.user,
        command: entry.command
      });
    }
  }
  return sortUsers(users);
}

// ---------------------------------------------------------------------------
// Parsing: fuser -v (fallback when lsof is missing)
// ---------------------------------------------------------------------------
// Table format:
//                      USER        PID ACCESS COMMAND
//   /dev/video0:         demo    77001 F.... bash
//                        demo    77002 F...m v4l2-ctl
//   /dev/video1:         demo    77001 F.... bash
// The first row of a device sits on the `/dev/videoN:` header line; the
// column header row is skipped.

function parseFuserOutput(text) {
  var users = [];
  if (!text) return users;
  var capped = String(text);
  if (capped.length > MAX_OUTPUT_CHARS) capped = capped.substring(0, MAX_OUTPUT_CHARS);
  var lines = capped.split("\n");
  var device = "";
  for (var i = 0; i < lines.length; i++) {
    var raw = lines[i];
    if (!raw) continue;
    var trimmed = raw.trim();
    if (!trimmed) continue;
    var headerMatch = /^(\/dev\/video\d+):\s*(.*)$/.exec(trimmed);
    if (headerMatch) {
      device = headerMatch[1];
      trimmed = headerMatch[2].trim();
      if (!trimmed) continue;
    }
    if (!device) continue; // column header or stray output before any device
    var tokens = trimmed.split(/\s+/);
    if (tokens[0] === "USER" && tokens[1] === "PID") continue;
    if (tokens.length < 3) continue; // not a data row
    users.push({
      device: device,
      pid: tokens[1],
      user: tokens[0],
      command: tokens.slice(3).join(" ") || tokens[2]
    });
  }
  return sortUsers(users);
}

function isVideoDevice(path) {
  return /^\/dev\/video\d+$/.test(path);
}

// Entries are comparable/diffable and stable for display: sorted by pid, then
// by device.
function sortUsers(users) {
  if (!users || users.length === 0) return [];
  var copy = users.slice(0);
  copy.sort(function (a, b) {
    var pa = parseInt(a.pid, 10) || 0;
    var pb = parseInt(b.pid, 10) || 0;
    if (pa !== pb) return pa - pb;
    return a.device < b.device ? -1 : (a.device > b.device ? 1 : 0);
  });
  return copy;
}

// ---------------------------------------------------------------------------
// Probe output dispatch
// ---------------------------------------------------------------------------
// Returns
//   { ok: true,  users: [...] }                 — idle ([]) or active (list)
//   { ok: false, kind: "no-tool"|"no-device"|"parse", message } — calm error
// The widget maps an ok result onto the reducer; the reducer turns
// deterministic kinds into the error state immediately and transient
// failures into the error state only after PROBE_ERROR_AFTER in a row.

function parseProbeOutput(exitCode, raw) {
  var text = String(raw == null ? "" : raw);
  if (text.length > MAX_OUTPUT_CHARS) text = text.substring(0, MAX_OUTPUT_CHARS);
  var lines = text.split("\n");
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (line === ERR_NO_TOOL) {
      return { ok: false, kind: "no-tool", message: errorMessageFor("no-tool") };
    }
    if (line === ERR_NO_DEVICE) {
      return { ok: false, kind: "no-device", message: errorMessageFor("no-device") };
    }
  }
  var first = "";
  for (var j = 0; j < lines.length; j++) {
    if (lines[j].trim() !== "") { first = lines[j].trim(); break; }
  }
  if (first === "") {
    // Both tools print nothing when nothing holds the camera open.
    return { ok: true, users: [] };
  }
  if (/^p\d+$/.test(first)) {
    return { ok: true, users: parseLsofOutput(text) };
  }
  if (first.indexOf("USER") !== -1 && first.indexOf("PID") !== -1) {
    return { ok: true, users: parseFuserOutput(text) };
  }
  // Unknown output shape (a tool behaving unexpectedly). Calm parse error;
  // after PROBE_ERROR_AFTER consecutive ones the widget shows the error state.
  return { ok: false, kind: "parse", message: errorMessageFor("parse") };
}

// ---------------------------------------------------------------------------
// State reducer
// ---------------------------------------------------------------------------
// view = {
//   status: "loading"|"idle"|"active"|"error",
//   users:  [{device, pid, user, command}, ...] — current camera holders,
//   errorKind: ""|"no-tool"|"no-device"|"probe"|"parse",
//   message: "",                       // fixed sentence for error display
//   at: 0,                             // last probe timestamp (ms)
//   consecutiveFailures: 0,            // transient failures in a row
//   lastEvent: null | { kind: "opened"|"closed", at, entry }
// }
//
// Events: opened/closed fire when the holder set differs from the previous
// poll. The FIRST successful poll after the widget starts is a silent
// baseline (action.baseline = true) so a widget that starts while the camera
// is already in use does not ring a false "opened".

function initialView() {
  return {
    status: STATUS_LOADING,
    users: [],
    errorKind: "",
    message: "",
    at: 0,
    consecutiveFailures: 0,
    lastEvent: null
  };
}

function entryKey(entry) {
  return entry.device + "|" + entry.pid;
}

// Diff two holder sets (each a list of {device,pid,user,command}). Keyed by
// device+pid: a process that opens a second device while already listed
// counts as opened for that device; a process that closes one of two devices
// counts as closed for that device.
function diffUsers(prev, next) {
  var prevKeys = {};
  var nextKeys = {};
  var opened = [];
  var closed = [];
  for (var i = 0; i < prev.length; i++) prevKeys[entryKey(prev[i])] = prev[i];
  for (var j = 0; j < next.length; j++) nextKeys[entryKey(next[j])] = next[j];
  var key;
  for (key in prevKeys) {
    if (!nextKeys[key]) closed.push(prevKeys[key]);
  }
  for (key in nextKeys) {
    if (!prevKeys[key]) opened.push(nextKeys[key]);
  }
  return { opened: opened, closed: closed };
}

function reduce(view, action) {
  var st = view || initialView();
  if (!action) return st;
  var at = action.at || 0;

  if (action.type === "probeStart") {
    // Never flicker: a poll starting does not change what we show. The next
    // probeOk/probeError decides.
    return st;
  }

  if (action.type === "probeOk") {
    var users = sortUsers(action.users || []);
    var events = [];
    var lastEvent = null;
    // Diff whenever this poll is not the startup baseline: opening the
    // camera from idle (previous set empty) must still fire `opened`.
    if (!action.baseline) {
      var diff = diffUsers(st.users, users);
      var k;
      for (k = 0; k < diff.closed.length; k++) {
        events.push({ kind: "closed", at: at, entry: diff.closed[k] });
      }
      for (k = 0; k < diff.opened.length; k++) {
        events.push({ kind: "opened", at: at, entry: diff.opened[k] });
      }
      // One last-event for the panel/activity line; an open wins over a
      // close within the same poll (the more interesting transition).
      if (diff.opened.length > 0) {
        lastEvent = { kind: "opened", at: at, entry: diff.opened[diff.opened.length - 1] };
      } else if (diff.closed.length > 0) {
        lastEvent = { kind: "closed", at: at, entry: diff.closed[diff.closed.length - 1] };
      } else {
        lastEvent = st.lastEvent;
      }
    }
    return {
      status: users.length > 0 ? STATUS_ACTIVE : STATUS_IDLE,
      users: users,
      errorKind: "",
      message: "",
      at: at,
      consecutiveFailures: 0,
      lastEvent: lastEvent
    };
  }

  if (action.type === "probeError") {
    var kind = action.kind || "probe";
    var message = action.message || errorMessageFor(kind);
    var deterministic = isDeterministicErrorKind(kind);
    var consec = deterministic ? st.consecutiveFailures : st.consecutiveFailures + 1;
    if (deterministic || consec >= PROBE_ERROR_AFTER) {
      return {
        status: STATUS_ERROR,
        users: st.users || [],
        errorKind: kind,
        message: message,
        at: at,
        consecutiveFailures: consec,
        lastEvent: st.lastEvent
      };
    }
    // One transient failure: stay calm on the last known state, but remember
    // the failure so the threshold can trip on the next one.
    var quiet = Object.assign({}, st);
    quiet.consecutiveFailures = consec;
    return quiet;
  }

  return st;
}

// ---------------------------------------------------------------------------
// Display helpers (bar + panel)
// ---------------------------------------------------------------------------

function isLoading(view) { return view && view.status === STATUS_LOADING; }
function isIdle(view) { return view && view.status === STATUS_IDLE; }
function isActive(view) { return view && view.status === STATUS_ACTIVE; }
function isError(view) { return view && view.status === STATUS_ERROR; }

function statusLabel(view) {
  if (isLoading(view)) return "Checking\u2026";
  if (isActive(view)) return "Camera in use";
  if (isError(view)) return "Detection unavailable";
  return "Camera idle";
}

function errorText(view) {
  if (view && isError(view) && view.message) return view.message;
  return "";
}

// One tooltip line per process holding the camera: "• v4l2-ctl (PID 77000)".
function activeProcessLines(view) {
  var lines = [];
  var seen = {};
  var users = view && view.users ? view.users : [];
  for (var i = 0; i < users.length; i++) {
    var pid = users[i].pid;
    if (seen[pid]) continue;
    seen[pid] = true;
    lines.push("\u2022 " + users[i].command + " (PID " + pid + ")");
  }
  return lines;
}

function tooltipText(view) {
  if (!view || isLoading(view)) return "LensGuard \u2014 checking the camera\u2026";
  if (isIdle(view)) return "LensGuard \u2014 camera idle";
  if (isActive(view)) {
    var lines = activeProcessLines(view);
    var body = "Camera in use by:";
    for (var i = 0; i < lines.length; i++) body += "\n" + lines[i];
    return body;
  }
  if (isError(view)) {
    return "LensGuard \u2014 " + (view.message || "camera check failed");
  }
  return "LensGuard";
}

// Panel activity line: what happened last (or a calm "no activity yet").
function lastEventText(view) {
  if (!view || !view.lastEvent) return "";
  var e = view.lastEvent;
  var who = e.entry ? e.entry.command + " (PID " + e.entry.pid + ")" : "a process";
  if (e.kind === "opened") return who + " opened the camera";
  if (e.kind === "closed") return who + " released the camera";
  return "";
}

if (typeof module !== "undefined") {
  module.exports = {
    DEFAULT_POLL_INTERVAL_MS: DEFAULT_POLL_INTERVAL_MS,
    MIN_POLL_INTERVAL_MS: MIN_POLL_INTERVAL_MS,
    ERROR_RECHECK_MS: ERROR_RECHECK_MS,
    PROBE_WATCHDOG_MS: PROBE_WATCHDOG_MS,
    PROBE_ERROR_AFTER: PROBE_ERROR_AFTER,
    MAX_OUTPUT_CHARS: MAX_OUTPUT_CHARS,
    ERR_NO_TOOL: ERR_NO_TOOL,
    ERR_NO_DEVICE: ERR_NO_DEVICE,
    probeScript: probeScript,
    probeCommand: probeCommand,
    isDeterministicErrorKind: isDeterministicErrorKind,
    errorMessageFor: errorMessageFor,
    isVideoDevice: isVideoDevice,
    parseLsofOutput: parseLsofOutput,
    parseFuserOutput: parseFuserOutput,
    parseProbeOutput: parseProbeOutput,
    initialView: initialView,
    entryKey: entryKey,
    diffUsers: diffUsers,
    reduce: reduce,
    sortUsers: sortUsers,
    isLoading: isLoading,
    isIdle: isIdle,
    isActive: isActive,
    isError: isError,
    statusLabel: statusLabel,
    errorText: errorText,
    activeProcessLines: activeProcessLines,
    tooltipText: tooltipText,
    lastEventText: lastEventText
  };
}
