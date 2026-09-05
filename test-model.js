// Node test suite for Model.js — plain assert, no framework.
// Run: node test-model.js
const assert = require("assert")
const M = require("./Model.js")

const eq = (a, b, msg) => assert.strictEqual(a, b, msg)
const ok = (v, msg) => assert.ok(v, msg)
const has = (haystack, needle, msg) => assert.ok(String(haystack).includes(needle), msg)

// ---------------------------------------------------------------------------
// Example probe captures — synthetic fixtures, fictional values only.
// ---------------------------------------------------------------------------
// Two fictional processes hold /dev/video0 + /dev/video1 open at once: a
// `bash` fd holder and a streaming `v4l2-ctl`. lsof prints one group per
// process; v4l2-ctl opened video0 twice (mmap + fd) and also holds the video1
// metadata device, so both parsers must dedupe to one entry per (pid, device).

const LSOF_FIXTURE = [
  "p77001",
  "cbash",
  "u1000",
  "n/dev/video0",
  "n/dev/video1",
  "p77002",
  "cv4l2-ctl",
  "u1000",
  "n/dev/video0",
  "n/dev/video0",
  "n/dev/video1",
  "n/dev/video0",
  ""
].join("\n")

const FUSER_FIXTURE = [
  "                     USER        PID ACCESS COMMAND",
  "/dev/video0:         demo      77001 F.... bash",
  "                     demo      77002 F...m v4l2-ctl",
  "/dev/video1:         demo      77001 F.... bash",
  "                     demo      77002 F.... v4l2-ctl",
  ""
].join("\n")

// --- constants / defaults ------------------------------------------------
eq(M.DEFAULT_POLL_INTERVAL_MS, 1000, "calm 1 s default poll")
eq(M.PROBE_WATCHDOG_MS, 5000, "watchdog kills a hung probe after 5 s")
eq(M.PROBE_ERROR_AFTER, 2, "error after two consecutive transient failures")
eq(M.ERROR_RECHECK_MS, 5000, "calm 5 s re-check in the error state")
eq(M.ERR_NO_TOOL, "__LG_ERR_NO_TOOL__", "no-tool marker")
eq(M.ERR_NO_DEVICE, "__LG_ERR_NO_DEVICE__", "no-device marker")
eq(M.HISTORY_LIMIT, 20, "history is capped at 20 entries")
ok(Array.isArray(M.DEFAULT_WHITELIST), "default whitelist is an array")
has(M.DEFAULT_WHITELIST.join(","), "zoom", "default whitelist contains zoom")
has(M.DEFAULT_WHITELIST.join(","), "obs", "default whitelist contains obs")

// --- probe command -------------------------------------------------------
const cmd = M.probeCommand()
eq(cmd[0], "bash", "probe runs through bash (for the /dev/video* glob)")
eq(cmd[1], "-c", "bash -c wrapper")
has(cmd[2], "lsof -F pcun", "primary probe uses machine-readable lsof")
has(cmd[2], "fuser -v", "fallback probe uses fuser")
has(cmd[2], M.ERR_NO_TOOL, "missing-tool marker in the script")
has(cmd[2], M.ERR_NO_DEVICE, "no-device marker in the script")
ok(!cmd[2].includes("sleep"), "probe never leaves a lingering process behind")
ok(!cmd[2].includes("while "), "probe has no loop (no polling spam)")

// --- lsof parser ---------------------------------------------------------
let users = M.parseLsofOutput(LSOF_FIXTURE)
eq(users.length, 4, "lsof: one entry per (pid, device), duplicates removed")
const keyOf = (u) => u.device + "|" + u.pid
const keys = users.map(keyOf)
has(keys, "/dev/video0|77001", "lsof: bash holds video0")
has(keys, "/dev/video1|77001", "lsof: bash holds video1")
has(keys, "/dev/video0|77002", "lsof: v4l2-ctl holds video0")
has(keys, "/dev/video1|77002", "lsof: v4l2-ctl holds the video1 metadata device too")
const v4l = users.find((u) => u.pid === "77002" && u.device === "/dev/video0")
eq(v4l.command, "v4l2-ctl", "lsof: command parsed")
eq(v4l.user, "1000", "lsof: user id parsed (numeric uid field)")
eq(users.length, new Set(users.map(keyOf)).size, "lsof: no duplicate keys")
eq(M.parseLsofOutput("").length, 0, "lsof: empty output -> no users")
eq(M.parseLsofOutput("p1\nn/dev/video0\n").length, 1, "lsof: single process minimal")
eq(M.parseLsofOutput("n/dev/video0\n").length, 0, "lsof: stray device without pid ignored")

// --- fuser parser (fallback) --------------------------------------------
let fused = M.parseFuserOutput(FUSER_FIXTURE)
eq(fused.length, 4, "fuser: one row per holder across devices")
has(fused.map(keyOf), "/dev/video0|77002", "fuser: v4l2-ctl under video0")
has(fused.map(keyOf), "/dev/video1|77001", "fuser: bash under video1")
const bashRow = fused.find((u) => u.pid === "77001" && u.device === "/dev/video0")
eq(bashRow.user, "demo", "fuser: user name parsed")
eq(bashRow.command, "bash", "fuser: command parsed")
eq(M.parseFuserOutput("").length, 0, "fuser: empty -> no users")
// fuser table without any device line (column header only) stays empty
eq(M.parseFuserOutput("                     USER        PID ACCESS COMMAND\n").length, 0,
  "fuser: header row alone -> no users")

// --- probe output dispatch ----------------------------------------------
let r = M.parseProbeOutput(0, "")
eq(r.ok, true, "empty output is a healthy idle poll")
eq(r.users.length, 0, "idle has no users")
r = M.parseProbeOutput(1, LSOF_FIXTURE)
eq(r.ok, true, "lsof output parsed (exit code 1 is normal for lsof)")
eq(r.users.length, 4, "lsof poll result")
r = M.parseProbeOutput(0, FUSER_FIXTURE)
eq(r.ok, true, "fuser output parsed")
eq(r.users.length, 4, "fuser poll result")
r = M.parseProbeOutput(0, M.ERR_NO_DEVICE + "\n")
eq(r.ok, false, "no-device marker -> error")
eq(r.kind, "no-device", "no-device kind")
r = M.parseProbeOutput(0, "some noise\n" + M.ERR_NO_TOOL)
eq(r.kind, "no-tool", "no-tool marker found on any line")
r = M.parseProbeOutput(0, "totally unexpected garbage")
eq(r.ok, false, "unexpected output -> error")
eq(r.kind, "parse", "unexpected output kind")
eq(M.parseProbeOutput(0, "x".repeat(M.MAX_OUTPUT_CHARS + 50)).ok, false,
  "oversized output is capped before parsing (no memory blow-up)")

// --- process grouping ----------------------------------------------------
const procs = M.groupByProcess(users)
eq(procs.length, 2, "groupByProcess: 4 device rows collapse to 2 processes")
eq(procs[1].pid, "77002", "process rows sorted by pid")
eq(procs[1].devices.length, 2, "v4l2-ctl holds video0+video1")
const dproc = M.diffProcesses([], users)
eq(dproc.opened.length, 2, "diffProcesses from empty -> both processes opened")
eq(dproc.closed.length, 0, "diffProcesses: nothing closed")
const dproc2 = M.diffProcesses(users, [])
eq(dproc2.opened.length, 0, "diffProcesses: nothing opened")
eq(dproc2.closed.length, 2, "diffProcesses -> both processes closed")

// --- whitelist matching --------------------------------------------------
eq(M.commandMatches("zoom", "zoom"), true, "exact command matches")
eq(M.commandMatches("zoom.us", "zoom"), false, "zoom does not match zoom.us (boundary)")
eq(M.commandMatches("teams-for-linux", "teams"), true, "prefix at '-' boundary matches")
eq(M.commandMatches("chrome", "chromium"), false, "chrome != chromium")
eq(M.commandMatches("chromium", "chromium"), true, "chromium exact")
eq(M.commandMatches("obs", "obs"), true, "obs exact")
eq(M.commandMatches("obs-studio", "obs"), true, "obs matches obs-studio")
eq(M.commandMatches("zoommalware", "zoom"), false, "no prefix-match past alnum (security)")
eq(M.commandMatches("ZOOM", "zoom"), true, "case-insensitive")
eq(M.isWhitelisted("ffmpeg", M.DEFAULT_WHITELIST), false, "ffmpeg not whitelisted by default")
eq(M.isWhitelisted("zoom", M.DEFAULT_WHITELIST), true, "zoom whitelisted by default")
eq(M.isWhitelisted("v4l2-ctl", M.DEFAULT_WHITELIST), true, "v4l2-ctl listed as known test tool")
eq(M.isWhitelisted("firefox", M.DEFAULT_WHITELIST), true, "firefox whitelisted")
eq(M.isWhitelisted("unknown-cam", []), false, "empty whitelist -> everything unknown")

// --- config parsing ------------------------------------------------------
let cfg = M.parseConfig("")
eq(cfg.ok, true, "empty config is fine (defaults)")
eq(cfg.source, "defaults", "empty config -> defaults")
eq(cfg.config.whitelist.length, M.DEFAULT_WHITELIST.length, "defaults whitelist")
cfg = M.parseConfig("   \n ")
eq(cfg.ok, true, "whitespace config is fine (defaults)")
cfg = M.parseConfig("{ not json")
eq(cfg.ok, false, "broken json -> parse error")
eq(cfg.kind, "parse", "parse error kind")
cfg = M.parseConfig("[1,2]")
eq(cfg.ok, false, "array is not a config object")
eq(cfg.kind, "shape", "shape error kind")
cfg = M.parseConfig('{"whitelist": "zoom"}')
eq(cfg.ok, false, "whitelist must be an array")
eq(cfg.kind, "field", "field error kind")
cfg = M.parseConfig('{"whitelist": ["zoom", "OBS", "", 42, "teams", "teams"]}')
eq(cfg.ok, true, "mixed whitelist is tolerated")
eq(cfg.config.whitelist.length, 3, "non-strings/duplicates/empty removed")
eq(cfg.config.whitelist[0], "zoom", "first entry preserved")
eq(cfg.config.whitelist[1], "obs", "lowercased")
cfg = M.parseConfig('{"pollIntervalSeconds": 60, "whitelist": ["zoom"]}')
eq(cfg.ok, true, "unknown keys are preserved, not an error")
eq(cfg.config.whitelist.length, 1, "whitelist parsed from object with extra keys")
const ctext = M.configToText({ whitelist: ["zoom"] }, { pollIntervalSeconds: 60 })
has(ctext, "pollIntervalSeconds", "configToText preserves unknown keys")
has(ctext, '"zoom"', "configToText writes whitelist")
const template = M.configTemplateText()
has(template, "zoom", "template has defaults")
eq(M.configDir("/home/u/.config/lensguard/config.json"), "/home/u/.config/lensguard", "configDir")
const wc = M.writeConfigCommandArgs("/x/lensguard/config.json", { whitelist: [] }, null)
eq(wc[0], "bash", "config write via bash")
has(wc[2], "umask 077", "config written mode 600 from the first byte")
has(wc[2], "config.json.tmp.$$", "config write uses a temp file")
has(wc[2], "mv -f", "config write is atomic")
has(wc[2], "printf '%s' \"$2\"", "content travels as argv, never shell text")

// --- LG-3 config keys: defaults -------------------------------------------
const defCfg = M.defaultConfig()
eq(defCfg.pollIntervalMs, 1000, "default poll interval is 1000 ms")
eq(defCfg.notifyOnOpen, true, "default notifyOnOpen true")
eq(defCfg.notifyOnUnknown, true, "default notifyOnUnknown true")
eq(defCfg.showProcessInBar, true, "default showProcessInBar true")
eq(defCfg.compactMode, false, "default compactMode false")
eq(M.MIN_POLL_INTERVAL_MS, 250, "poll floor is 250 ms")
eq(M.MAX_POLL_INTERVAL_MS, 5000, "poll ceiling is 5000 ms")
eq(M.clampPollInterval(250), 250, "clamp keeps 250")
eq(M.clampPollInterval(5000), 5000, "clamp keeps 5000")
eq(M.clampPollInterval(1000), 1000, "clamp keeps the default")
eq(M.clampPollInterval(10), 250, "clamp lifts below-min to the floor")
eq(M.clampPollInterval(99999), 5000, "clamp drops above-max to the ceiling")
eq(M.clampPollInterval(333.6), 334, "clamp rounds to whole ms")
eq(M.clampPollInterval("junk"), 1000, "clamp falls back to the default")

// --- LG-3 config keys: parsing + strict validation ------------------------
cfg = M.parseConfig('{"pollIntervalMs": 250}')
eq(cfg.ok, true, "fast interval accepted")
eq(cfg.config.pollIntervalMs, 250, "fast interval parsed")
cfg = M.parseConfig('{"pollIntervalMs": 25}')
eq(cfg.ok, true, "below-min interval is tolerated (clamped, not an error)")
eq(cfg.config.pollIntervalMs, 250, "below-min interval clamps to the floor")
cfg = M.parseConfig('{"pollIntervalMs": 60000}')
eq(cfg.config.pollIntervalMs, 5000, "above-max interval clamps to the ceiling")
cfg = M.parseConfig('{"pollIntervalMs": "1000"}')
eq(cfg.ok, false, "string interval is a field error")
eq(cfg.kind, "field", "string interval kind")
cfg = M.parseConfig('{"notifyOnUnknown": false}')
eq(cfg.ok, true, "boolean false accepted")
eq(cfg.config.notifyOnUnknown, false, "notifyOnUnknown false parsed")
cfg = M.parseConfig('{"compactMode": true}')
eq(cfg.config.compactMode, true, "compactMode true parsed")
cfg = M.parseConfig('{"notifyOnOpen": "yes"}')
eq(cfg.ok, false, "non-boolean notifyOnOpen is a field error")
eq(cfg.kind, "field", "notifyOnOpen kind")
has(cfg.message, "true or false", "field error is static and descriptive")
cfg = M.parseConfig('{"compactMode": 1}')
eq(cfg.ok, false, "non-boolean compactMode is a field error")
cfg = M.parseConfig('{}')
eq(cfg.ok, true, "empty object -> defaults")
eq(cfg.config.pollIntervalMs, 1000, "empty object keeps default interval")
eq(cfg.config.notifyOnOpen, true, "empty object keeps default notifyOnOpen")
// A minimal old-format whitelist-only file stays valid and fills defaults.
cfg = M.parseConfig('{"whitelist": ["zoom"]}')
eq(cfg.ok, true, "old whitelist-only file is still valid")
eq(cfg.config.pollIntervalMs, 1000, "old file gets the default interval")
eq(cfg.config.notifyOnUnknown, true, "old file gets the default notify flag")
eq(cfg.config.compactMode, false, "old file gets the default compact mode")
// Full round-trip: every known key survives a parse -> text -> parse cycle.
const fullCfg = { whitelist: ["zoom", "obs"], pollIntervalMs: 2000,
  notifyOnOpen: false, notifyOnUnknown: true, showProcessInBar: false, compactMode: true }
const fullText = M.configToText(fullCfg, { customNote: 7 })
const fullParsed = M.parseConfig(fullText)
eq(fullParsed.ok, true, "round-tripped config parses")
eq(fullParsed.config.pollIntervalMs, 2000, "interval survives round-trip")
eq(fullParsed.config.notifyOnOpen, false, "notifyOnOpen survives round-trip")
eq(fullParsed.config.compactMode, true, "compactMode survives round-trip")
has(fullText, "customNote", "unknown keys survive a settings write")
const tmpl = M.configTemplateText()
has(tmpl, "pollIntervalMs", "template includes pollIntervalMs")
has(tmpl, "notifyOnUnknown", "template includes notifyOnUnknown")
has(tmpl, "showProcessInBar", "template includes showProcessInBar")
has(tmpl, "compactMode", "template includes compactMode")

// --- LG-3 config reset: .bak + defaults -----------------------------------
const rc = M.configResetCommandArgs("/x/lensguard/config.json")
eq(rc[0], "bash", "reset via bash")
has(rc[2], "cp -f", "reset keeps a .bak backup of the current file")
has(rc[2], "$f.bak", "backup path is config.json.bak")
has(rc[2], "umask 077", "reset writes mode 600 from the first byte")
has(rc[2], "mv -f", "reset write is atomic")
has(rc[2], "echo ok", "reset reports success")

// --- interval label --------------------------------------------------------
eq(M.intervalLabel(250), "250 ms", "interval label ms")
eq(M.intervalLabel(1000), "1 s", "interval label seconds")
eq(M.intervalLabel(1500), "1.5 s", "interval label fractional")
eq(M.intervalLabel(5000), "5 s", "interval label 5 s")

// --- state reducer: baseline is silent ----------------------------------
let v = M.initialView()
eq(v.status, "loading", "starts loading")
eq(M.isLoading(v), true, "loading helper")
v = M.reduce(v, { type: "probeStart", at: 1 })
eq(v.status, "loading", "probeStart keeps loading (no flicker)")
eq(v.history.length, 0, "no history yet")
// First successful poll while the camera is ALREADY in use: active, but the
// baseline must not ring a false "opened" event.
const holderA = [{ device: "/dev/video0", pid: "4102", user: "demo", command: "example-cam" }]
v = M.reduce(v, { type: "probeOk", users: holderA, at: 1000, baseline: true })
eq(v.status, "active", "baseline with a holder -> active")
eq(v.lastEvent, null, "baseline emits no opened event")
eq(v.history.length, 0, "baseline adds no history")
eq(M.isActive(v), true, "active helper")
eq(M.statusLabel(v), "Camera in use", "status label active")
eq(v.openedAt["4102"], 1000, "baseline records the open time for live 'since'")

// --- opened event (from idle) --------------------------------------------
// Opening the camera while LensGuard watches idle must fire `opened` — the
// live camera transition check caught this path regressing.
let idleV = M.initialView()
idleV = M.reduce(idleV, { type: "probeOk", users: [], at: 500, baseline: true })
eq(idleV.status, "idle", "baseline without holders -> idle")
idleV = M.reduce(idleV, { type: "probeOk", users: holderA, at: 1500 })
eq(idleV.status, "active", "holder appears -> active")
eq(idleV.lastEvent && idleV.lastEvent.kind, "opened", "idle -> active fires opened")
eq(idleV.lastEvent.entry.pid, "4102", "opened event names the new process")
eq(idleV.history.length, 1, "history has one event")
eq(idleV.history[0].kind, "opened", "history entry is opened")
eq(idleV.history[0].pid, "4102", "history entry carries the pid")
eq(idleV.openedAt["4102"], 1500, "openedAt set when the process opens")

// --- multi-device open is ONE process event ------------------------------
// One process opening video0+video1 at once must fire exactly one opened
// event and one history row (no notification spam per device).
let multiV = M.initialView()
multiV = M.reduce(multiV, { type: "probeOk", users: [], at: 100, baseline: true })
multiV = M.reduce(multiV, {
  type: "probeOk", users: [
    { device: "/dev/video0", pid: "7", user: "demo", command: "zoomish" },
    { device: "/dev/video1", pid: "7", user: "demo", command: "zoomish" }
  ], at: 200 })
eq(multiV.lastEvent.kind, "opened", "multi-device open fires opened once")
eq(multiV.history.length, 1, "multi-device open -> one history entry")
eq(multiV.history[0].command, "zoomish", "history process name")
eq(multiV.users.length, 2, "live holder rows still list both devices")
eq(M.activeProcessLines(multiV).length, 1, "tooltip lists the process once")

// --- closed event (whole process released) -------------------------------
v = M.reduce(v, { type: "probeOk", users: holderA, at: 2000 }) // same state
eq(v.lastEvent, null, "no event when nothing changed")
const holderB = [{ device: "/dev/video0", pid: "4242", user: "demo", command: "ffmpeg" }]
v = M.reduce(v, { type: "probeOk", users: holderB, at: 3000 })
eq(v.status, "active", "new holder stays active")
eq(v.lastEvent.kind, "opened", "opened event fired")
eq(v.lastEvent.entry.pid, "4242", "opened event names the process")
eq(v.lastEvent.entry.command, "ffmpeg", "opened event command")
eq(v.consecutiveFailures, 0, "success resets the failure counter")
eq(v.openedAt["4242"], 3000, "new process since time recorded")
eq(v.openedAt["4102"], undefined, "old process since removed")

// Releasing one of two devices while the process still holds another is NOT
// a close (the camera is still in use) — no spam, no history entry.
v = M.reduce(v, {
  type: "probeOk", users: [
    { device: "/dev/video0", pid: "4242", user: "demo", command: "ffmpeg" },
    { device: "/dev/video1", pid: "4242", user: "demo", command: "ffmpeg" }
  ], at: 3100 })
const histBefore = v.history.length
v = M.reduce(v, {
  type: "probeOk", users: [
    { device: "/dev/video0", pid: "4242", user: "demo", command: "ffmpeg" }
  ], at: 3200 })
eq(v.status, "active", "still active while one device remains")
eq(v.history.length, histBefore, "closing one of two devices adds no history")
eq(v.lastEvent.kind, "opened", "last event stays the open (no false close)")

// Real close (all devices released) fires exactly one closed event.
v = M.reduce(v, { type: "probeOk", users: [], at: 4000 })
eq(v.status, "idle", "no holders -> idle")
eq(v.lastEvent.kind, "closed", "closed event fired when the camera is released")
eq(v.lastEvent.entry.pid, "4242", "closed event names the released process")
eq(v.history[0].kind, "closed", "history newest-first has the closed event")
eq(M.isIdle(v), true, "idle helper")
eq(M.statusLabel(v), "Camera idle", "status label idle")

// --- history cap ---------------------------------------------------------
let capV = M.initialView()
capV = M.reduce(capV, { type: "probeOk", users: [], at: 1, baseline: true })
for (let i = 0; i < 30; i++) {
  capV = M.reduce(capV, {
    type: "probeOk", users: [{ device: "/dev/video0", pid: String(100 + i), user: "demo", command: "p" + i }], at: 2 + i })
  capV = M.reduce(capV, { type: "probeOk", users: [], at: 1000 + i })
}
eq(capV.history.length, M.HISTORY_LIMIT, "history stays capped at HISTORY_LIMIT")
eq(capV.history[0].pid, "129", "newest event first (last iteration 100+29)")

// --- transient failure handling ------------------------------------------
v = M.initialView()
v = M.reduce(v, { type: "probeOk", users: [], at: 1, baseline: true })
eq(v.status, "idle", "baseline idle")
v = M.reduce(v, { type: "probeError", kind: "parse", message: "unexpected camera probe output", at: 2000 })
eq(v.status, "idle", "first transient failure keeps the calm idle state")
eq(v.consecutiveFailures, 1, "failure counted")
v = M.reduce(v, { type: "probeError", kind: "parse", message: "unexpected camera probe output", at: 3000 })
eq(v.status, "error", "second consecutive transient failure -> error")
eq(M.isError(v), true, "error helper")
has(M.tooltipText(v), "unexpected camera probe output", "error tooltip is calm and static")

// --- deterministic failures are immediate --------------------------------
v = M.reduce(M.initialView(), { type: "probeError", kind: "no-device", at: 1 })
eq(v.status, "error", "no camera device -> error right away")
eq(v.errorKind, "no-device", "error kind kept")
eq(M.statusLabel(v), "Detection unavailable", "status label error")
ok(M.isDeterministicErrorKind("no-device") && M.isDeterministicErrorKind("no-tool"),
  "no-tool/no-device are deterministic")
v = M.reduce(M.initialView(), { type: "probeError", kind: "no-tool", at: 1 })
eq(v.errorKind, "no-tool", "missing tool kind")
has(M.errorText(v), "lsof or fuser", "error text explains the missing tools")

// --- recovery ------------------------------------------------------------
v = M.reduce(v, { type: "probeOk", users: holderA, at: 4000 })
eq(v.status, "active", "success recovers from error")
eq(v.consecutiveFailures, 0, "recovery resets the counter")
eq(v.errorKind, "", "error kind cleared")

// --- restoreHistory is display-only --------------------------------------
let restored = M.initialView()
restored = M.reduce(restored, { type: "restoreHistory", history: [
  { kind: "opened", at: 1000, pid: "55", command: "oldcam", user: "", device: "/dev/video0" },
  { kind: "closed", at: 2000, pid: "55", command: "oldcam", user: "", device: "/dev/video0" }
] })
eq(restored.history.length, 2, "restored history is kept for the panel")
eq(restored.lastEvent, null, "restoring history never fabricates a lastEvent")
eq(restored.status, "loading", "restoring history never changes live status")
restored = M.reduce(restored, { type: "probeOk", users: holderA, at: 5000, baseline: true })
eq(restored.history.length, 2, "baseline after restore adds no new history")
eq(restored.lastEvent, null, "baseline after restore is still silent")
restored = M.reduce(restored, { type: "probeOk", users: [], at: 6000 })
eq(restored.lastEvent.kind, "closed", "live close after restore fires normally")
eq(restored.history[0].kind, "closed", "live event is newest-first on top")

// --- process rows / known classification ---------------------------------
const cfgKnown = { whitelist: ["zoom", "obs"] }
const actV = { status: "active", users: [
  { device: "/dev/video0", pid: "10", user: "demo", command: "zoom" },
  { device: "/dev/video0", pid: "11", user: "demo", command: "ffmpeg" }
], errorKind: "", message: "", at: 1, consecutiveFailures: 0, lastEvent: null,
  history: [], openedAt: { "10": 100, "11": 200 } }
const rows = M.processRows(actV, cfgKnown.whitelist)
eq(rows.length, 2, "processRows returns one row per process")
eq(rows[0].known, true, "zoom row known")
eq(rows[1].known, false, "ffmpeg row unknown")
eq(M.anyUnknown(actV, cfgKnown.whitelist), true, "anyUnknown true when a holder is unknown")
eq(M.allKnown(actV, cfgKnown.whitelist), false, "allKnown false with an unknown holder")
const onlyKnownV = { status: "active", users: [{ device: "/dev/video0", pid: "10", user: "demo", command: "zoom" }],
  openedAt: { "10": 100 }, history: [], lastEvent: null }
eq(M.anyUnknown(onlyKnownV, cfgKnown.whitelist), false, "no unknown with only zoom")
eq(M.allKnown(onlyKnownV, cfgKnown.whitelist), true, "allKnown true with only zoom")

// --- display strings -----------------------------------------------------
eq(M.tooltipText(M.initialView()), "LensGuard \u2014 checking the camera\u2026", "loading tooltip")
const idleView = { status: "idle", users: [], errorKind: "", message: "", at: 1, consecutiveFailures: 0, lastEvent: null, history: [], openedAt: {} }
eq(M.tooltipText(idleView, 100000), "LensGuard \u2014 camera idle", "idle tooltip")
const idleAfterClose = { status: "idle", users: [], errorKind: "", message: "", at: 9000,
  lastEvent: { kind: "closed", at: 8000, entry: { pid: "5", command: "ffmpeg", device: "/dev/video0" } },
  history: [], openedAt: {} }
has(M.tooltipText(idleAfterClose, 10000), "ffmpeg released the camera",
  "recent close gets a calm tooltip return note")
eq(M.tooltipText(idleAfterClose, 100000), "LensGuard \u2014 camera idle",
  "old close note is not shown forever")
const actView = { status: "active", users: holderA, errorKind: "", message: "", at: 1, consecutiveFailures: 0, lastEvent: null, history: [], openedAt: {} }
has(M.tooltipText(actView), "example-cam (PID 4102)", "active tooltip names the process")
has(M.tooltipText(actView), "Camera in use", "active tooltip states camera in use")
eq(M.lastEventText(idleView), "", "no last event -> empty line")
eq(M.lastEventText({ status: "idle", users: [], errorKind: "", message: "", at: 1, consecutiveFailures: 0,
  lastEvent: { kind: "opened", at: 1, entry: holderA[0] }, history: [], openedAt: {} }),
  "example-cam (PID 4102) opened the camera", "last event text")
eq(M.formatTime(0), "", "formatTime(0) is empty")
has(M.formatTime(Date.now()), ":", "formatTime renders a time")
eq(M.sinceText(0), "", "sinceText(0) is empty")

// --- state file ----------------------------------------------------------
const stText = M.stateToText({ status: "active", users: holderA, errorKind: "", message: "", at: 5000,
  consecutiveFailures: 0,
  lastEvent: { kind: "opened", at: 5000, entry: holderA[0] },
  history: [{ kind: "opened", at: 5000, pid: "4102", command: "example-cam", user: "demo", device: "/dev/video0" }],
  openedAt: { "4102": 5000 } })
has(stText, "version", "state text has a version")
has(stText, "example-cam", "state text includes the history")
has(stText, "opened", "state text includes the event kind")
const restoredHist = M.historyFromStateText(stText)
eq(restoredHist.length, 1, "history round-trips from the state file")
eq(restoredHist[0].command, "example-cam", "history entry survives")
eq(M.historyFromStateText("garbage").length, 0, "broken state file -> empty history")
eq(M.historyFromStateText("").length, 0, "empty state file -> empty history")
const sc = M.writeStateCommandArgs("/home/u/.local/state/lensguard/state.json", "{}")
eq(sc[0], "bash", "state write via bash")
has(sc[2], "umask 077", "state file written mode 600 from the first byte")
has(sc[2], "state.json.tmp.$$", "state write uses a temp file")
has(sc[2], "mv -f", "state write is atomic")

// --- notifications -------------------------------------------------------
const notifProc = { pid: "9001", command: "ffmpeg", user: "demo", devices: ["/dev/video0"] }
eq(M.shouldNotifyOnOpen(notifProc, M.DEFAULT_WHITELIST), true, "unknown process should notify")
eq(M.shouldNotifyOnOpen({ pid: "1", command: "zoom" }, M.DEFAULT_WHITELIST), false,
  "whitelisted process stays calm")
eq(M.shouldNotifyOnOpen(notifProc, M.DEFAULT_WHITELIST, { notifyOnOpen: true, notifyOnUnknown: true }),
  true, "config defaults keep unknown notifications on")
eq(M.shouldNotifyOnOpen(notifProc, M.DEFAULT_WHITELIST, { notifyOnOpen: false, notifyOnUnknown: true }),
  false, "notifyOnOpen false silences camera-open notifications")
eq(M.shouldNotifyOnOpen(notifProc, M.DEFAULT_WHITELIST, { notifyOnOpen: true, notifyOnUnknown: false }),
  false, "notifyOnUnknown false silences only the unknown alert")
eq(M.shouldNotifyOnOpen({ pid: "1", command: "zoom" }, M.DEFAULT_WHITELIST,
  { notifyOnOpen: true, notifyOnUnknown: false }), false,
  "whitelisted app stays calm even when unknown alerts are off")
has(M.notifySummary(notifProc), "ffmpeg", "summary names the command")
has(M.notifySummary(notifProc), "9001", "summary names the PID")
const ng = M.notifGateCommandArgs("/tmp/lg.gate", "opened|9001", "inst-A", 25)
eq(ng[0], "bash", "gate via bash")
has(ng[2], "flock", "gate uses flock")
has(ng[2], "prevme", "gate is instance-aware (a twin is skipped, self is not)")
has(ng[2], "echo skip", "gate can skip (twin instance)")

// --- one-shot IO task watchdog (MI-5 class fix, LG-5) ----------------------
eq(M.WRITE_WATCHDOG_MS, 5000, "one-shot writes are killed after 5 s")
eq(M.NOTIF_WATCHDOG_MS, 10000, "notification phases have a 10 s watchdog budget")
ok(M.NOTIF_WATCHDOG_MS >= M.WRITE_WATCHDOG_MS * 2,
  "notification budget leaves room over the bounded gate flock wait")
eq(M.NOTIF_GATE_TTL_S, 25, "twin-instance skip window is 25 s")
eq(M.NOTIF_GATE_FLOCK_WAIT_S, 3, "gate flock is bounded to 3 s")
has(ng[2], "flock -w " + M.NOTIF_GATE_FLOCK_WAIT_S,
  "gate script uses the bounded flock wait (a wedged twin can never block the gate forever)")
const ngDef = M.notifGateCommandArgs("/tmp/lg.gate", "opened|9001", "inst-A")
has(ngDef[2], "flock -w", "gate default-ttl path also builds a bounded flock")

// --- regression: no long-lived reusable Process objects --------------------
// Every Process must live inside a Component factory and be created fresh
// per run (probe, one-shot writes/notifications, investigate). A top-level
// reusable Process reused many times can lose its exit event and report
// running forever — the exact class that silently stalled MyIP's polling and
// that LG-5 removes from LensGuard's write/notification paths.
const fs = require("fs")
const path = require("path")
const srcBar = fs.readFileSync(path.join(__dirname, "BarWidget.qml"), "utf8")
ok(!/^  Process \{/m.test(srcBar),
  "BarWidget: no top-level reusable Process (each lives in a Component factory)")
ok(/id: ioTaskComponent/.test(srcBar), "BarWidget: one-shot IO task factory present")
ok(/id: probeProcessComponent/.test(srcBar), "BarWidget: probe factory present")
const srcPanel = fs.readFileSync(path.join(__dirname, "Panel.qml"), "utf8")
ok(!/^  Process \{/m.test(srcPanel),
  "Panel: no top-level reusable Process (investigate runs on a fresh object)")
ok(/id: investigateTaskComponent/.test(srcPanel), "Panel: investigate factory present")

// --- regression: notification phase kinds map onto the _notifTask slot ----
// LG-5 live doorloop on 2c1026d caught a silent notification death:
// startNotifPhase() runs tasks with taskKind "notifGate"/"notifSend", but
// ioTaskSlot()/clearIoTaskSlot() only mapped the watchdog key "notif" — so
// handleIoTaskExited() saw ioTaskSlot(kind) === null for EVERY notification
// task, treated it as a stale runner (releaseIoTask) and dropped it before
// the gate output was read. The send phase was unreachable, _notifTask was
// never cleared and the queue died silently. This guard fails whenever a
// notification phase kind is added (or renamed) without being mapped to the
// SAME slot as "notif" in both functions — the exact stale-drop class.
const sliceFn = (name) => {
  const i = srcBar.indexOf("function " + name)
  ok(i >= 0, "BarWidget defines " + name + " (source guard target)")
  const j = srcBar.indexOf("\n  }\n", i)
  return srcBar.slice(i, j < 0 ? srcBar.length : j)
}
const ioSlotSrc = sliceFn("ioTaskSlot")
const clearSlotSrc = sliceFn("clearIoTaskSlot")
const recSrc = sliceFn("recoverIoTask")
for (const nk of ["notif", "notifGate", "notifSend"]) {
  ok(ioSlotSrc.includes('"' + nk + '"') && ioSlotSrc.includes("root._notifTask"),
    "ioTaskSlot maps \"" + nk + "\" onto _notifTask (notification tasks are never stale)")
  ok(clearSlotSrc.includes('"' + nk + '"') && clearSlotSrc.includes("root._notifTask"),
    "clearIoTaskSlot maps \"" + nk + "\" onto _notifTask (queue slot clears on exit)")
}
ok(recSrc.includes('kind = "notif"'),
  "recoverIoTask normalizes the raw phase kinds to \"notif\" (watchdog kill path recovers)")


// --- bar process text (showProcessInBar / compactMode) --------------------
const idleView2 = { status: "idle", users: [], errorKind: "", message: "", at: 1, consecutiveFailures: 0, lastEvent: null, history: [], openedAt: {} }
eq(M.barProcessText(idleView2, M.DEFAULT_WHITELIST), "", "idle -> no bar text")
eq(M.barProcessText(M.initialView(), M.DEFAULT_WHITELIST), "", "loading -> no bar text")
const oneProcView = { status: "active", users: [{ device: "/dev/video0", pid: "10", user: "demo", command: "zoom" }],
  openedAt: { "10": 1 }, history: [], lastEvent: null }
eq(M.barProcessText(oneProcView, M.DEFAULT_WHITELIST), "zoom", "one known process -> its name")
const unknownView = { status: "active", users: [
  { device: "/dev/video0", pid: "10", user: "demo", command: "zoom" },
  { device: "/dev/video0", pid: "11", user: "demo", command: "ffmpeg" }],
  openedAt: { "10": 1, "11": 2 }, history: [], lastEvent: null }
eq(M.barProcessText(unknownView, M.DEFAULT_WHITELIST), "ffmpeg +1",
  "unknown process wins the bar label and the rest become a count")
const allKnownView = { status: "active", users: [
  { device: "/dev/video0", pid: "10", user: "demo", command: "zoom" },
  { device: "/dev/video0", pid: "12", user: "demo", command: "obs" }],
  openedAt: { "10": 1, "12": 2 }, history: [], lastEvent: null }
eq(M.barProcessText(allKnownView, M.DEFAULT_WHITELIST), "zoom +1",
  "all-known multi-process label shows the first plus the count")

// --- entryKey / diffUsers direct (device-level helper retained) ----------
eq(M.entryKey(holderA[0]), "/dev/video0|4102", "entry key device|pid")
const d1 = M.diffUsers([holderA[0]], [])
eq(d1.opened.length, 0, "device diff: nothing opened")
eq(d1.closed.length, 1, "device diff: one closed")
const d2 = M.diffUsers([], holderB)
eq(d2.opened.length, 1, "device diff: one opened")
eq(d2.closed.length, 0, "device diff: nothing closed")

// =========================================================================
console.log("LensGuard test-model.js — all assertions passed (" + Object.keys(M).length + " exports)")
