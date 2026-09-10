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
// Polling (the process spawning, the cadence and the watchdog) lives in
// BarWidget.qml; this file only decides WHAT to run (probe script), how to
// READ the probe output (lsof -F records or fuser -v table), how to diff one
// poll against the previous one (opened/closed events), what the whitelist /
// notification rules are and what to display. No shell, no Qt, no Node
// built-ins — the same code runs in both runtimes.

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

var DEFAULT_POLL_INTERVAL_MS = 1000;   // poll about once per second (default)
var MIN_POLL_INTERVAL_MS = 250;        // user-configurable floor (never faster)
var MAX_POLL_INTERVAL_MS = 5000;       // user-configurable ceiling (calm)
var ERROR_RECHECK_MS = 5000;           // calm re-check cadence in error state
var PROBE_WATCHDOG_MS = 5000;          // kill a probe that hangs this long
var WRITE_WATCHDOG_MS = 5000;          // kill a one-shot write (state/config/reset) that hangs
var NOTIF_WATCHDOG_MS = 10000;         // notification gate + send watchdog budget (ms)
var NOTIF_GATE_TTL_S = 25;             // twin-instance skip window for the gate (s)
var NOTIF_GATE_FLOCK_WAIT_S = 3;       // bounded flock wait in the gate (s)
var PROBE_ERROR_AFTER = 2;             // consecutive transient failures -> error
var MAX_OUTPUT_CHARS = 65536;          // parser cap (64 KiB), defensive

// Bounded fields (HANCORE security baseline, LG-7). Every value that comes
// from a process LensGuard does NOT control — its command name (lsof `c` /
// fuser COMMAND), the user id behind it, the device path, the
// /proc/<pid>/cmdline preview and any whitelist entry created from such a
// command — is truncated to a small, documented maximum BEFORE it enters the
// reducer, the panel, the bar, a notification or the state file. A local
// process picks its own name, so unbounded text could stretch a bar slot or a
// panel card, bloat state.json, and widen the blast radius of any rich-text
// interpretation of those values. MAX_OUTPUT_CHARS above remains what it is:
// a parse-safety bound for the whole probe stream, far too large to ever show.
var MAX_COMMAND_CHARS = 120;           // process name shown anywhere in the UI
var MAX_USER_CHARS = 32;               // user behind the camera
var MAX_DEVICE_CHARS = 64;             // device path (/dev/videoNN is ~12 chars)
var MAX_PID_CHARS = 16;                // pid as printed by the probe (<= 7 digits)
var MAX_INVESTIGATE_CHARS = 512;       // /proc/<pid>/cmdline preview in the panel
var MAX_WHITELIST_ENTRY_CHARS = 64;    // one whitelist entry (UI + config file)

var ERR_NO_TOOL = "__LG_ERR_NO_TOOL__";
var ERR_NO_DEVICE = "__LG_ERR_NO_DEVICE__";

var STATUS_LOADING = "loading";
var STATUS_IDLE = "idle";
var STATUS_ACTIVE = "active";
var STATUS_ERROR = "error";

// History is capped so the state file and the panel stay small and calm.
var HISTORY_LIMIT = 20;

// ---------------------------------------------------------------------------
// Whitelist (camera apps that are allowed to use the lens without an alert)
// ---------------------------------------------------------------------------
// Known camera apps that are allowed to use the lens without an alert. The
// list matches on the process COMMAND as reported by lsof/fuser (e.g. "zoom",
// "obs", "chrome", "ffmpeg"); see commandMatches(). Browsers are listed
// because PipeWire opens /dev/video* on their behalf — the process LensGuard
// sees for a browser call is often "pipewire", so it is whitelisted too.
// Users extend this via ~/.config/lensguard/config.json or the panel.
var DEFAULT_WHITELIST = [
  "zoom",
  "obs",
  "teams",
  "chrome",
  "chromium",
  "firefox",
  "brave",
  "msedge",
  "edge",
  "slack",
  "discord",
  "whatsapp",
  "skype",
  "webex",
  "pipewire",
  "v4l2-ctl"
];

var CONFIG_VERSION = 1;
var STATE_VERSION = 1;

// ---------------------------------------------------------------------------
// Display / classification helpers shared by QML and Node
// ---------------------------------------------------------------------------

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

// Truncate one value that came from an untrusted source (a process name, a
// user id, a device path, a /proc preview) to a documented maximum. Always
// returns a string, so parse callers need no extra null guards. Truncation
// only shortens — it never re-interprets, escapes or sanitizes the content;
// the UI renders these values as plain text (Text.PlainText, LG-7).
function boundedText(value, max) {
  var s = value == null ? "" : String(value);
  var limit = Number(max);
  if (!isFinite(limit) || limit < 0) return s;
  return s.length > limit ? s.substring(0, limit) : s;
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
//   p77000          process id
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
      // The pid is bounded like every other probe value: diffing/history key
      // off this string, so a spoofed or absurdly long pid can never grow the
      // state file or a display row.
      var pidKey = boundedText(value, MAX_PID_CHARS);
      if (!byPid[pidKey]) {
        byPid[pidKey] = { pid: pidKey, command: "", user: "", devices: {} };
        order.push(pidKey);
      }
      current = byPid[pidKey];
    } else if (current) {
      if (code === "c") {
        current.command = boundedText(value, MAX_COMMAND_CHARS);
      } else if (code === "u") {
        current.user = boundedText(value, MAX_USER_CHARS);
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
//   /dev/video0:         demo      77001 F.... bash
//                        demo      77002 F...m v4l2-ctl
//   /dev/video1:         demo      77001 F.... bash
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
      device = boundedText(headerMatch[1], MAX_DEVICE_CHARS);
      trimmed = headerMatch[2].trim();
      if (!trimmed) continue;
    }
    if (!device) continue; // column header or stray output before any device
    var tokens = trimmed.split(/\s+/);
    if (tokens[0] === "USER" && tokens[1] === "PID") continue;
    if (tokens.length < 3) continue; // not a data row
    users.push({
      device: device,
      pid: boundedText(tokens[1], MAX_PID_CHARS),
      user: boundedText(tokens[0], MAX_USER_CHARS),
      command: boundedText(tokens.slice(3).join(" ") || tokens[2], MAX_COMMAND_CHARS)
    });
  }
  return sortUsers(users);
}

function isVideoDevice(path) {
  // A real device path is /dev/videoN with a short number: the length bound
  // keeps a pathological "n" field out of the holder list and the state file.
  var s = path == null ? "" : String(path);
  return s.length <= MAX_DEVICE_CHARS && /^\/dev\/video\d+$/.test(s);
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
// Process-level grouping
// ---------------------------------------------------------------------------
// The live holder list is kept per (device, pid) so the panel can show which
// device each process holds. Events (opened/closed), history and alerts are
// per PROCESS: one process opening video0+video1 at once is ONE camera-open
// event, never two — the widget must not spam one notification per device.

// Group device-level user rows into process-level rows.
// Returns [{ pid, command, user, devices: [...] }] sorted by pid.
// This is the single point where probe rows become the process rows the whole
// UI (panel cards, bar label, tooltip, history, notifications) is built from,
// so every field is bounded here as well: parser bounds protect the view and
// the state file at the source, and this bound protects every consumer even if
// a row ever arrives from somewhere else (LG-7 defence in depth).
function groupByProcess(users) {
  var byPid = {};
  var order = [];
  var list = users || [];
  for (var i = 0; i < list.length; i++) {
    var u = list[i];
    if (!u || u.pid == null) continue;
    if (!byPid[u.pid]) {
      byPid[u.pid] = {
        pid: boundedText(u.pid, MAX_PID_CHARS),
        command: boundedText(u.command, MAX_COMMAND_CHARS),
        user: boundedText(u.user, MAX_USER_CHARS),
        devices: []
      };
      order.push(u.pid);
    }
    var p = byPid[u.pid];
    if (!p.command && u.command) p.command = boundedText(u.command, MAX_COMMAND_CHARS);
    if (!p.user && u.user) p.user = boundedText(u.user, MAX_USER_CHARS);
    if (u.device) {
      var dev = boundedText(u.device, MAX_DEVICE_CHARS);
      if (p.devices.indexOf(dev) === -1) p.devices.push(dev);
    }
  }
  var out = [];
  for (var oi = 0; oi < order.length; oi++) {
    var proc = byPid[order[oi]];
    proc.devices.sort();
    out.push(proc);
  }
  out.sort(function (a, b) {
    var pa = parseInt(a.pid, 10) || 0;
    var pb = parseInt(b.pid, 10) || 0;
    return pa - pb;
  });
  return out;
}

// Diff two holder sets at the PROCESS level. Returns
//   { opened: [process rows newly holding the camera],
//     closed: [process rows that stopped holding it] }
function diffProcesses(prevUsers, nextUsers) {
  var prevProcs = groupByProcess(prevUsers);
  var nextProcs = groupByProcess(nextUsers);
  var prevByPid = {};
  var nextByPid = {};
  for (var i = 0; i < prevProcs.length; i++) prevByPid[prevProcs[i].pid] = prevProcs[i];
  for (var j = 0; j < nextProcs.length; j++) nextByPid[nextProcs[j].pid] = nextProcs[j];
  var opened = [];
  var closed = [];
  var pid;
  for (pid in nextByPid) {
    if (!prevByPid[pid]) opened.push(nextByPid[pid]);
  }
  for (pid in prevByPid) {
    if (!nextByPid[pid]) closed.push(prevByPid[pid]);
  }
  return { opened: opened, closed: closed };
}

// Keep at most HISTORY_LIMIT entries, newest first.
function capHistory(history) {
  if (!history || history.length === 0) return [];
  return history.slice(0, HISTORY_LIMIT);
}

function entryForEvent(processRow) {
  // History entries are rendered in the panel and persisted to state.json, so
  // every field is bounded here as well (defence in depth, LG-7).
  return {
    pid: boundedText(processRow.pid, MAX_PID_CHARS),
    command: boundedText(processRow.command || "?", MAX_COMMAND_CHARS),
    user: boundedText(processRow.user, MAX_USER_CHARS),
    devices: processRow.devices || [],
    device: (processRow.devices && processRow.devices.length > 0)
      ? boundedText(processRow.devices[0], MAX_DEVICE_CHARS) : ""
  };
}

// ---------------------------------------------------------------------------
// Whitelist matching
// ---------------------------------------------------------------------------
// A whitelist entry matches the process COMMAND when the command starts with
// the entry and the next character is a package separator ("-" or "_") or the
// end of the string — so "zoom" matches "zoom", "teams" matches
// "teams-for-linux", "obs" matches "obs-studio", but "zoom" never matches
// "zoommalware" or "zoom.us" (a security tool errs on the side of alerting).
// "chromium" is listed separately because "chrome" must not match it.
function commandMatches(command, entry) {
  if (!command || !entry) return false;
  var c = String(command).toLowerCase().trim();
  var p = String(entry).toLowerCase().trim();
  if (!c || !p) return false;
  if (c === p) return true;
  if (c.indexOf(p) !== 0) return false;
  var next = c.charAt(p.length);
  return next === "-" || next === "_";
}

function isWhitelisted(command, whitelist) {
  var list = whitelist || [];
  for (var i = 0; i < list.length; i++) {
    if (commandMatches(command, list[i])) return true;
  }
  return false;
}

// Normalize ONE whitelist entry that came from a process command — both entries
// read from the config file and entries the panel adds via "Allow" are stored
// through this single function, so a process can never push an unbounded (or
// differently cased) string into the config, the state file or the panel list.
// Returns "" for an unusable entry (the caller decides whether that is a
// no-op).
function normalizeWhitelistEntry(value) {
  var s = boundedText(value, MAX_WHITELIST_ENTRY_CHARS);
  return s.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Config parsing (~/.config/lensguard/config.json)
// ---------------------------------------------------------------------------
// The config is optional. When it is missing, empty or broken the widget
// quietly uses defaults — the camera guard must never stop working because
// of a config typo. parseConfig returns
//   { ok: true,  config: {...}, source: "defaults"|"file" }
//   { ok: false, kind: "parse"|"shape"|"field", message, hint }
// and never leaks file content into user-facing strings.
//
// Supported keys (LG-3):
//   pollIntervalMs     number, clamped to [250, 5000]       (default 1000)
//   notifyOnOpen       boolean                              (default true)
//   notifyOnUnknown    boolean                              (default true)
//   showProcessInBar   boolean                              (default true)
//   compactMode        boolean                              (default false)
//   whitelist          array of command patterns
// Numbers are clamped into range; booleans are strict (a wrong type is a
// calm field error -> defaults). Unknown keys are preserved on write.

function defaultConfig() {
  return {
    whitelist: DEFAULT_WHITELIST.slice(),
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    notifyOnOpen: true,
    notifyOnUnknown: true,
    showProcessInBar: true,
    compactMode: false
  };
}

// Clamp a poll interval into the supported range. Used both while parsing
// the config and whenever the widget schedules a probe.
function clampPollInterval(ms) {
  var n = Number(ms);
  if (!isFinite(n)) return DEFAULT_POLL_INTERVAL_MS;
  n = Math.round(n);
  if (n < MIN_POLL_INTERVAL_MS) return MIN_POLL_INTERVAL_MS;
  if (n > MAX_POLL_INTERVAL_MS) return MAX_POLL_INTERVAL_MS;
  return n;
}

// Boolean config keys and their default value when the key is absent.
var CONFIG_BOOL_DEFAULTS = {
  notifyOnOpen: true,
  notifyOnUnknown: true,
  showProcessInBar: true,
  compactMode: false
};

function configFieldError(key, message) {
  return {
    ok: false,
    kind: "field",
    message: message,
    hint: "edit the config or reset it from the LensGuard panel"
  };
}

function parseConfig(raw) {
  var text = String(raw == null ? "" : raw);
  if (text.trim() === "") {
    return { ok: true, config: defaultConfig(), source: "defaults" };
  }
  var obj = null;
  try {
    obj = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      kind: "parse",
      message: "config.json is not valid JSON",
      hint: "reset it from the LensGuard panel or edit the file"
    };
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return {
      ok: false,
      kind: "shape",
      message: "config.json must contain a JSON object",
      hint: "reset it from the LensGuard panel or edit the file"
    };
  }
  var cfg = defaultConfig();
  var i;
  if (obj.whitelist !== undefined) {
    if (!Array.isArray(obj.whitelist)) {
      return configFieldError("whitelist",
        "config: \"whitelist\" must be a list of app names");
    }
    var clean = [];
    for (i = 0; i < obj.whitelist.length; i++) {
      var item = obj.whitelist[i];
      if (typeof item !== "string") continue;
      var name = normalizeWhitelistEntry(item);
      if (!name) continue;
      if (clean.indexOf(name) === -1) clean.push(name);
    }
    cfg.whitelist = clean;
  }
  if (obj.pollIntervalMs !== undefined) {
    if (typeof obj.pollIntervalMs !== "number" || !isFinite(obj.pollIntervalMs)) {
      return configFieldError("pollIntervalMs",
        "config: \"pollIntervalMs\" must be a number between 250 and 5000");
    }
    cfg.pollIntervalMs = clampPollInterval(obj.pollIntervalMs);
  }
  for (var key in CONFIG_BOOL_DEFAULTS) {
    if (!Object.prototype.hasOwnProperty.call(CONFIG_BOOL_DEFAULTS, key)) continue;
    var value = obj[key];
    if (value === undefined) {
      cfg[key] = CONFIG_BOOL_DEFAULTS[key];
    } else if (typeof value !== "boolean") {
      return configFieldError(key,
        "config: \"" + key + "\" must be true or false");
    } else {
      cfg[key] = value;
    }
  }
  return { ok: true, config: cfg, source: "file", raw: obj };
}

// Serialized config content. Only the known keys are written from config;
// everything else the user typed is preserved verbatim so editing via UI
// never destroys settings.
function configToText(config, raw) {
  var obj = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (var key in raw) {
      if (Object.prototype.hasOwnProperty.call(raw, key)) obj[key] = raw[key];
    }
  }
  var cfg = config || defaultConfig();
  obj.whitelist = cfg.whitelist || [];
  obj.pollIntervalMs = clampPollInterval(cfg.pollIntervalMs);
  obj.notifyOnOpen = cfg.notifyOnOpen !== false;
  obj.notifyOnUnknown = cfg.notifyOnUnknown !== false;
  obj.showProcessInBar = cfg.showProcessInBar !== false;
  obj.compactMode = cfg.compactMode === true;
  return JSON.stringify(obj, null, 2) + "\n";
}

function configTemplateText() {
  return configToText(defaultConfig(), null);
}

function configDir(configPath) {
  if (!configPath) return "";
  var idx = configPath.lastIndexOf("/");
  return idx > 0 ? configPath.substring(0, idx) : configPath;
}

// argv for the atomic config write (mode 600 from the first byte: umask 077,
// unique temp file + mv — never write-then-chmod). Keeps the user's unknown
// keys (raw object) and replaces whitelist.
function writeConfigCommandArgs(configPath, config, raw) {
  var dir = configDir(configPath);
  var file = "config.json";
  var text = configToText(config, raw);
  return writeFileCommandArgs(configPath, text, "lensguard-write-config", file);
}

// argv for the atomic config RESET (LG-3): keep the current file (even a
// broken one) as config.json.bak, then write fresh defaults the same atomic
// way (mode 600 from the first byte). The broken content only ever lands in
// the user's own .bak file on disk — never in a UI string or a log line.
function configResetCommandArgs(configPath) {
  var text = configTemplateText();
  var p = String(configPath == null ? "" : configPath);
  var idx = p.lastIndexOf("/");
  var dir = idx > 0 ? p.substring(0, idx) : ".";
  var base = idx > 0 ? p.substring(idx + 1) : "config.json";
  var script = "f=$1; c=$2;"
    + " if [ -e \"$f\" ] && [ ! -d \"$f\" ]; then cp -f -- \"$f\" \"$f.bak\" 2>/dev/null || true; fi;"
    + " umask 077; mkdir -p -- \"$3\" || exit 1;"
    + " tmp=\"$3/" + base + ".tmp.$$\";"
    + " printf '%s' \"$c\" > \"$tmp\" || exit 1;"
    + " mv -f -- \"$tmp\" \"$f\" || exit 1;"
    + " echo ok";
  return ["bash", "-c", script, "lensguard-reset-config",
    String(configPath == null ? "" : configPath), text, dir];
}

// argv for the atomic state write (mode 600 from the first byte: umask 077,
// unique temp file + mv). The exact path is passed as argv so a future caller
// can never write to the wrong basename.
function writeStateCommandArgs(statePath, text) {
  return writeFileCommandArgs(statePath, text, "lensguard-write-state", null);
}

// Generic atomic writer used for config.json and state.json. file is the
// basename to target (defaults to the basename of path).
function writeFileCommandArgs(path, text, name, file) {
  var p = String(path == null ? "" : path);
  var idx = p.lastIndexOf("/");
  var dir = idx > 0 ? p.substring(0, idx) : ".";
  var base = file || (idx > 0 ? p.substring(idx + 1) : p);
  var script = "umask 077; mkdir -p -- \"$1\" || exit 1;"
    + " tmp=\"$1/" + base + ".tmp.$$\";"
    + " printf '%s' \"$2\" > \"$tmp\" || exit 1;"
    + " mv -f -- \"$tmp\" \"$1/" + base + "\" || exit 1;"
    + " echo ok";
  return ["bash", "-c", script, name || "lensguard-write-file", dir, String(text == null ? "" : text)];
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
//   lastEvent: null | { kind: "opened"|"closed", at, entry: {pid, command, user, device, devices} },
//   history: [ event, ... ],           // newest first, capped at HISTORY_LIMIT
//   openedAt: { pid: ms }              // when each current process opened (live "since")
// }
//
// Events: opened/closed fire when the PROCESS holder set differs from the
// previous poll. The FIRST successful poll after the widget starts is a
// silent baseline (action.baseline = true) so a widget that starts while the
// camera is already in use does not ring a false "opened".

function initialView() {
  return {
    status: STATUS_LOADING,
    users: [],
    errorKind: "",
    message: "",
    at: 0,
    consecutiveFailures: 0,
    lastEvent: null,
    history: [],
    openedAt: {}
  };
}

function entryKey(entry) {
  return entry.device + "|" + entry.pid;
}

// Device-level diff, still exported for tests and the live holder set; the
// reducer uses diffProcesses() for events/history/alerts.
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

function addHistoryEvent(history, kind, at, processRow) {
  var entry = entryForEvent(processRow);
  var event = {
    kind: kind,
    at: at,
    pid: entry.pid,
    command: entry.command,
    user: entry.user,
    device: entry.device
  };
  var next = [event];
  if (history && history.length) next = next.concat(history);
  return capHistory(next);
}

// applyProbe handles one successful probe. Returns
//   { view, events: [{kind, at, process}] }  — events = transitions (opened/
// closed), EMPTY on a baseline poll so the caller never notifies on baseline.
function applyProbe(prevView, action) {
  var st = prevView || initialView();
  var at = action.at || 0;
  var users = sortUsers(action.users || []);
  var events = [];
  var openedAt = {};
  // Carry over known open timestamps for processes still holding the camera.
  var prevProcs = groupByProcess(st.users);
  for (var pi = 0; pi < prevProcs.length; pi++) {
    var prevPid = String(prevProcs[pi].pid);
    if (st.openedAt && st.openedAt[prevPid]) openedAt[prevPid] = st.openedAt[prevPid];
  }
  var history = st.history || [];
  var lastEvent = st.lastEvent;

  if (!action.baseline) {
    var diff = diffProcesses(st.users, users);
    var k;
    for (k = 0; k < diff.closed.length; k++) {
      var closedProc = diff.closed[k];
      delete openedAt[String(closedProc.pid)];
      history = addHistoryEvent(history, "closed", at, closedProc);
      events.push({ kind: "closed", at: at, process: closedProc });
      lastEvent = { kind: "closed", at: at, entry: entryForEvent(closedProc) };
    }
    for (k = 0; k < diff.opened.length; k++) {
      var openedProc = diff.opened[k];
      openedAt[String(openedProc.pid)] = at;
      history = addHistoryEvent(history, "opened", at, openedProc);
      events.push({ kind: "opened", at: at, process: openedProc });
      // An open wins over a close within the same poll (more interesting).
      lastEvent = { kind: "opened", at: at, entry: entryForEvent(openedProc) };
    }
  } else {
    // Silent baseline: the current holders become the reference, but the
    // widget records their open time so the panel can show "since" without
    // ringing a false opened event.
    var procs = groupByProcess(users);
    for (var bi = 0; bi < procs.length; bi++) {
      openedAt[String(procs[bi].pid)] = at;
    }
  }

  return {
    view: {
      status: users.length > 0 ? STATUS_ACTIVE : STATUS_IDLE,
      users: users,
      errorKind: "",
      message: "",
      at: at,
      consecutiveFailures: 0,
      lastEvent: lastEvent,
      history: history,
      openedAt: openedAt
    },
    events: events
  };
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
    return applyProbe(st, action).view;
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
        lastEvent: st.lastEvent,
        history: st.history || [],
        openedAt: st.openedAt || {}
      };
    }
    // One transient failure: stay calm on the last known state, but remember
    // the failure so the threshold can trip on the next one.
    var quiet = Object.assign({}, st);
    quiet.consecutiveFailures = consec;
    return quiet;
  }

  if (action.type === "restoreHistory") {
    // Called once at startup with events read from the state file. Restoring
    // is display-only: it never fires notifications and never re-alerts.
    var restored = action.history || [];
    if (restored.length === 0) return st;
    var merged = capHistory(restored.concat(st.history || []));
    var out = Object.assign({}, st);
    out.history = merged;
    return out;
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

// Process rows for the current holders with their open time ("since").
function processRows(view, whitelist) {
  if (!view || !isActive(view)) return [];
  var procs = groupByProcess(view.users);
  for (var i = 0; i < procs.length; i++) {
    var p = procs[i];
    p.known = isWhitelisted(p.command, whitelist);
    p.since = view.openedAt ? view.openedAt[String(p.pid)] || 0 : 0;
  }
  return procs;
}

function anyUnknown(view, whitelist) {
  var rows = processRows(view, whitelist);
  for (var i = 0; i < rows.length; i++) {
    if (!rows[i].known) return true;
  }
  return false;
}

function allKnown(view, whitelist) {
  var rows = processRows(view, whitelist);
  if (rows.length === 0) return false;
  for (var i = 0; i < rows.length; i++) {
    if (!rows[i].known) return false;
  }
  return true;
}

// One tooltip line per process holding the camera: "• v4l2-ctl (PID 77000)".
function activeProcessLines(view) {
  var lines = [];
  var procs = view && view.users ? groupByProcess(view.users) : [];
  for (var i = 0; i < procs.length; i++) {
    lines.push("\u2022 " + procs[i].command + " (PID " + procs[i].pid + ")");
  }
  return lines;
}

// Human time "HH:MM:SS" from a ms epoch (used by panel history/live rows).
function formatTime(ms) {
  if (!ms || ms <= 0) return "";
  var d = new Date(ms);
  function two(n) { return (n < 10 ? "0" : "") + n; }
  return two(d.getHours()) + ":" + two(d.getMinutes()) + ":" + two(d.getSeconds());
}

// Short human "since" for a process row: absolute time when it started today.
function sinceText(ms) {
  return formatTime(ms);
}

function tooltipText(view, now) {
  if (!view || isLoading(view)) return "LensGuard \u2014 checking the camera\u2026";
  if (isIdle(view)) {
    // A recent close gets a short, calm return note in the tooltip (LG-2).
    var base = "LensGuard \u2014 camera idle";
    var le = view.lastEvent;
    if (le && le.kind === "closed" && le.entry && le.entry.command) {
      var ts = now || 0;
      if (!ts || (ts - (le.at || 0)) < 15000) {
        return base + "\n" + le.entry.command + " released the camera";
      }
    }
    return base;
  }
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

// ---------------------------------------------------------------------------
// State file (~/.local/state/lensguard/state.json)
// ---------------------------------------------------------------------------
// Persists the short event history + the last known status so the panel shows
// context after a shell restart. Restoring is display-only (see
// reduce restoreHistory): the widget still takes a silent baseline on the
// first poll, so a restart while the camera is open never re-alarms (MyIP
// lesson).

function stateToText(view) {
  var history = (view && view.history) || [];
  var last = (view && view.lastEvent) || null;
  return JSON.stringify({
    version: STATE_VERSION,
    savedAt: Date.now ? Date.now() : 0,
    status: view ? view.status : "",
    history: history.map(function (e) {
      return {
        kind: e.kind,
        at: e.at,
        pid: e.pid,
        command: e.command,
        user: e.user,
        device: e.device
      };
    }),
    lastEvent: last ? {
      kind: last.kind,
      at: last.at,
      pid: last.entry ? last.entry.pid : "",
      command: last.entry ? last.entry.command : ""
    } : null
  }, null, 2) + "\n";
}

function historyFromStateText(text) {
  try {
    var obj = JSON.parse(String(text == null ? "" : text));
    if (!obj || typeof obj !== "object" || !Array.isArray(obj.history)) return [];
    var out = [];
    var hist = obj.history;
    for (var i = 0; i < hist.length && out.length < HISTORY_LIMIT; i++) {
      var e = hist[i];
      if (!e || typeof e !== "object") continue;
      if (e.kind !== "opened" && e.kind !== "closed") continue;
      out.push({
        kind: e.kind,
        at: Number(e.at) || 0,
        pid: boundedText(e.pid == null ? "" : e.pid, MAX_PID_CHARS),
        command: boundedText(e.command == null ? "?" : e.command, MAX_COMMAND_CHARS),
        user: boundedText(e.user == null ? "" : e.user, MAX_USER_CHARS),
        device: boundedText(e.device == null ? "" : e.device, MAX_DEVICE_CHARS)
      });
    }
    return out;
  } catch (error) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Notification decisions (popup + journal)
// ---------------------------------------------------------------------------
// The bar widget sends ONE Omarchy notification per process-opened event
// when the config allows it:
//   * notifyOnOpen (default true) is the master switch for camera-open
//     notifications;
//   * a whitelisted app is ALWAYS calm (yellow "known app") — the whitelist
//     is the trusted list, so it never pops up regardless of the toggles;
//   * an UNKNOWN (non-whitelisted) open pops up only when notifyOnUnknown is
//     true (default). With notifyOnUnknown off the open still turns the bar
//     red and shows an attention card, it just stays silent.
// Closed events never notify; the tooltip carries the calm return note.

function shouldNotifyOnOpen(processRow, whitelist, config) {
  if (!processRow) return false;
  var cfg = config || defaultConfig();
  if (cfg.notifyOnOpen !== true) return false;
  if (isWhitelisted(processRow.command, whitelist)) return false;
  return cfg.notifyOnUnknown !== false;
}

function notifySummary(processRow) {
  // The summary lands in a desktop notification: bound it like every other
  // process-controlled string (LG-7).
  return "LensGuard: camera opened by " + boundedText(processRow.command || "?", MAX_COMMAND_CHARS)
    + " (PID " + boundedText(processRow.pid, MAX_PID_CHARS) + ")";
}

// Short process label shown in the bar next to the icon while the camera is
// in use (LG-3 showProcessInBar / compactMode). One process -> its command;
// several -> the most relevant process (the unknown one wins, because that is
// the one the user must see) plus a "+N" count of the rest. Empty string when
// the camera is idle, so the bar stays icon-only.
function barProcessText(view, whitelist) {
  if (!view || !isActive(view)) return "";
  var procs = groupByProcess(view.users);
  if (procs.length === 0) return "";
  var chosen = null;
  for (var i = 0; i < procs.length; i++) {
    if (!isWhitelisted(procs[i].command, whitelist)) { chosen = procs[i]; break; }
  }
  if (!chosen) chosen = procs[0];
  var label = chosen.command || "?";
  if (procs.length > 1) label += " +" + (procs.length - 1);
  return label;
}

// Human label for a poll interval ("250 ms", "1 s", "1.5 s", "5 s").
function intervalLabel(ms) {
  var n = Number(ms);
  if (!isFinite(n) || n < 0) return "";
  if (n < 1000) return n + " ms";
  var s = n / 1000;
  if (s === Math.floor(s)) return s + " s";
  return (Math.round(s * 10) / 10) + " s";
}

// argv for the cross-instance notification gate (flock). Omarchy runs one
// widget instance per monitor; two instances can observe the SAME transition
// and both want to notify. Each instance atomically records "{key} {instance}
// {unixSeconds}" in a gate file (flock'd). An instance skips only when the
// same key was recorded by a DIFFERENT instance within the ttl window — its
// own earlier record never suppresses a genuinely later transition (a
// reopened process with the same pid+command still notifies).
function notifGateCommandArgs(stateFile, key, instanceId, ttlSeconds) {
  var ttl = Number(ttlSeconds);
  if (!isFinite(ttl) || ttl < 1) ttl = NOTIF_GATE_TTL_S;
  var script = "f=$1; key=$2; me=$3; ttl=$4;"
    + " dir=$(dirname -- \"$f\"); mkdir -p -- \"$dir\" 2>/dev/null || { echo skip; exit 0; };"
    + " lock=\"$f.lock\"; exec 9>\"$lock\" || { echo skip; exit 0; };"
    + " flock -w " + NOTIF_GATE_FLOCK_WAIT_S + " 9 2>/dev/null || { echo skip; exit 0; };"
    + " now=$(date +%s); prev=\"\"; prevme=\"\"; prevts=0;"
    + " if [ -f \"$f\" ]; then read -r prev prevme prevts < \"$f\" 2>/dev/null || true; fi;"
    + " if [ \"$prev\" = \"$key\" ] && [ -n \"$prevme\" ] && [ \"$prevme\" != \"$me\" ]"
    + "   && [ -n \"$prevts\" ] && [ \"$(( now - prevts ))\" -lt \"$ttl\" ]; then echo skip;"
    + " else printf '%s %s %s\\n' \"$key\" \"$me\" \"$now\" > \"$f\"; echo send; fi";
  return ["bash", "-c", script, "lensguard-notif-gate",
    String(stateFile == null ? "" : stateFile), String(key == null ? "" : key),
    String(instanceId == null ? "" : instanceId), String(ttl)];
}

// A process is only ever identified by its numeric pid (lsof/fuser output).
// Investigate reads /proc/<pid>/cmdline through a fixed argv so the panel can
// show the FULL command line of an unknown process (lsof's comm is trimmed).
// argv only, pid validated numeric — no shell interpolation.
function pidIsNumeric(pid) {
  return /^\d+$/.test(String(pid == null ? "" : pid));
}

function investigateCommand(pid) {
  if (!pidIsNumeric(pid)) return null;
  return ["bash", "-c",
    "tr '\\0' ' ' < /proc/$1/cmdline; echo;",
    "lensguard-investigate", String(pid)];
}

// The /proc/<pid>/cmdline preview the panel shows for an unknown process. A
// command line is fully process-controlled and can be arbitrarily long, so it
// is trimmed to MAX_INVESTIGATE_CHARS before it reaches the UI — the panel
// renders it as plain text (Text.PlainText), never as rich text.
function investigateOutputText(raw) {
  var s = String(raw == null ? "" : raw).trim();
  return boundedText(s, MAX_INVESTIGATE_CHARS);
}

if (typeof module !== "undefined") {
  module.exports = {
    DEFAULT_POLL_INTERVAL_MS: DEFAULT_POLL_INTERVAL_MS,
    MIN_POLL_INTERVAL_MS: MIN_POLL_INTERVAL_MS,
    MAX_POLL_INTERVAL_MS: MAX_POLL_INTERVAL_MS,
    ERROR_RECHECK_MS: ERROR_RECHECK_MS,
    PROBE_WATCHDOG_MS: PROBE_WATCHDOG_MS,
    WRITE_WATCHDOG_MS: WRITE_WATCHDOG_MS,
    NOTIF_WATCHDOG_MS: NOTIF_WATCHDOG_MS,
    NOTIF_GATE_TTL_S: NOTIF_GATE_TTL_S,
    NOTIF_GATE_FLOCK_WAIT_S: NOTIF_GATE_FLOCK_WAIT_S,
    PROBE_ERROR_AFTER: PROBE_ERROR_AFTER,
    MAX_OUTPUT_CHARS: MAX_OUTPUT_CHARS,
    MAX_COMMAND_CHARS: MAX_COMMAND_CHARS,
    MAX_USER_CHARS: MAX_USER_CHARS,
    MAX_DEVICE_CHARS: MAX_DEVICE_CHARS,
    MAX_PID_CHARS: MAX_PID_CHARS,
    MAX_INVESTIGATE_CHARS: MAX_INVESTIGATE_CHARS,
    MAX_WHITELIST_ENTRY_CHARS: MAX_WHITELIST_ENTRY_CHARS,
    ERR_NO_TOOL: ERR_NO_TOOL,
    ERR_NO_DEVICE: ERR_NO_DEVICE,
    HISTORY_LIMIT: HISTORY_LIMIT,
    DEFAULT_WHITELIST: DEFAULT_WHITELIST,
    CONFIG_VERSION: CONFIG_VERSION,
    STATE_VERSION: STATE_VERSION,
    CONFIG_BOOL_DEFAULTS: CONFIG_BOOL_DEFAULTS,
    probeScript: probeScript,
    probeCommand: probeCommand,
    isDeterministicErrorKind: isDeterministicErrorKind,
    errorMessageFor: errorMessageFor,
    isVideoDevice: isVideoDevice,
    boundedText: boundedText,
    normalizeWhitelistEntry: normalizeWhitelistEntry,
    investigateOutputText: investigateOutputText,
    parseLsofOutput: parseLsofOutput,
    parseFuserOutput: parseFuserOutput,
    parseProbeOutput: parseProbeOutput,
    groupByProcess: groupByProcess,
    diffProcesses: diffProcesses,
    capHistory: capHistory,
    entryForEvent: entryForEvent,
    commandMatches: commandMatches,
    isWhitelisted: isWhitelisted,
    defaultConfig: defaultConfig,
    clampPollInterval: clampPollInterval,
    parseConfig: parseConfig,
    configToText: configToText,
    configTemplateText: configTemplateText,
    configDir: configDir,
    configResetCommandArgs: configResetCommandArgs,
    writeConfigCommandArgs: writeConfigCommandArgs,
    writeStateCommandArgs: writeStateCommandArgs,
    writeFileCommandArgs: writeFileCommandArgs,
    initialView: initialView,
    entryKey: entryKey,
    diffUsers: diffUsers,
    addHistoryEvent: addHistoryEvent,
    applyProbe: applyProbe,
    reduce: reduce,
    sortUsers: sortUsers,
    isLoading: isLoading,
    isIdle: isIdle,
    isActive: isActive,
    isError: isError,
    statusLabel: statusLabel,
    errorText: errorText,
    processRows: processRows,
    anyUnknown: anyUnknown,
    allKnown: allKnown,
    activeProcessLines: activeProcessLines,
    formatTime: formatTime,
    sinceText: sinceText,
    tooltipText: tooltipText,
    lastEventText: lastEventText,
    stateToText: stateToText,
    historyFromStateText: historyFromStateText,
    writeStateCommandArgs: writeStateCommandArgs,
    shouldNotifyOnOpen: shouldNotifyOnOpen,
    notifySummary: notifySummary,
    barProcessText: barProcessText,
    intervalLabel: intervalLabel,
    notifGateCommandArgs: notifGateCommandArgs,
    pidIsNumeric: pidIsNumeric,
    investigateCommand: investigateCommand
  };
}
