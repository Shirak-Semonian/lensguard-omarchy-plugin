// Node test suite for Model.js — plain assert, no framework.
// Run: node test-model.js
const assert = require("assert")
const M = require("./Model.js")

const eq = (a, b, msg) => assert.strictEqual(a, b, msg)
const ok = (v, msg) => assert.ok(v, msg)
const has = (haystack, needle, msg) => assert.ok(String(haystack).includes(needle), msg)

// ---------------------------------------------------------------------------
// Example probe captures — synthetic fixtures, fictional values only
// ---------------------------------------------------------------------------
// Two processes held /dev/video0 + /dev/video1 open at once: a `bash` fd
// holder and a streaming `v4l2-ctl`. lsof prints one group per process;
// v4l2-ctl opened video0 twice (mmap + fd) and also holds the video1
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
  "/dev/video0:         demo    77001 F.... bash",
  "                     demo    77002 F...m v4l2-ctl",
  "/dev/video1:         demo    77001 F.... bash",
  "                     demo    77002 F.... v4l2-ctl",
  ""
].join("\n")

// --- constants / defaults ------------------------------------------------
eq(M.DEFAULT_POLL_INTERVAL_MS, 1000, "calm 1 s default poll")
eq(M.PROBE_WATCHDOG_MS, 5000, "watchdog kills a hung probe after 5 s")
eq(M.PROBE_ERROR_AFTER, 2, "error after two consecutive transient failures")
eq(M.ERROR_RECHECK_MS, 5000, "calm 5 s re-check in the error state")
eq(M.ERR_NO_TOOL, "__LG_ERR_NO_TOOL__", "no-tool marker")
eq(M.ERR_NO_DEVICE, "__LG_ERR_NO_DEVICE__", "no-device marker")

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

// --- state reducer: baseline is silent ----------------------------------
let v = M.initialView()
eq(v.status, "loading", "starts loading")
eq(M.isLoading(v), true, "loading helper")
v = M.reduce(v, { type: "probeStart", at: 1 })
eq(v.status, "loading", "probeStart keeps loading (no flicker)")
// First successful poll while the camera is ALREADY in use: active, but the
// baseline must not ring a false "opened" event.
const holderA = [{ device: "/dev/video0", pid: "4102", user: "demo", command: "example-cam" }]
v = M.reduce(v, { type: "probeOk", users: holderA, at: 1000, baseline: true })
eq(v.status, "active", "baseline with a holder -> active")
eq(v.lastEvent, null, "baseline emits no opened event")
eq(M.isActive(v), true, "active helper")
eq(M.statusLabel(v), "Camera in use", "status label active")

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

// --- opened event (holder swap) ------------------------------------------
v = M.reduce(v, { type: "probeOk", users: holderA, at: 2000 }) // same state
eq(v.lastEvent, null, "no event when nothing changed")
const holderB = [{ device: "/dev/video0", pid: "4242", user: "demo", command: "ffmpeg" }]
v = M.reduce(v, { type: "probeOk", users: holderB, at: 3000 })
eq(v.status, "active", "new holder stays active")
eq(v.lastEvent.kind, "opened", "opened event fired")
eq(v.lastEvent.entry.pid, "4242", "opened event names the process")
eq(v.lastEvent.entry.command, "ffmpeg", "opened event command")
eq(v.consecutiveFailures, 0, "success resets the failure counter")

// --- closed event --------------------------------------------------------
v = M.reduce(v, { type: "probeOk", users: [], at: 4000 })
eq(v.status, "idle", "no holders -> idle")
eq(v.lastEvent.kind, "closed", "closed event fired when the camera is released")
eq(v.lastEvent.entry.pid, "4242", "closed event names the released process")
eq(M.isIdle(v), true, "idle helper")
eq(M.statusLabel(v), "Camera idle", "status label idle")

// --- multi-device diff ---------------------------------------------------
// Process 7 opens video0 + video1 at once -> two opened events (per device),
// but the process appears once in the tooltip lines.
let multi = M.reduce(M.initialView(), {
  type: "probeOk", users: [
    { device: "/dev/video0", pid: "7", user: "demo", command: "zoomish" },
    { device: "/dev/video1", pid: "7", user: "demo", command: "zoomish" }
  ], at: 100, baseline: true })
multi = M.reduce(multi, {
  type: "probeOk", users: [
    { device: "/dev/video0", pid: "7", user: "demo", command: "zoomish" }
  ], at: 200 })
eq(multi.lastEvent.kind, "closed", "closing one of two devices fires closed")
eq(multi.users.length, 1, "one device left")
eq(M.activeProcessLines(multi).length, 1, "tooltip lists the process once")

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

// --- display strings -----------------------------------------------------
eq(M.tooltipText(M.initialView()), "LensGuard \u2014 checking the camera\u2026", "loading tooltip")
const idleView = { status: "idle", users: [], errorKind: "", message: "", at: 1, consecutiveFailures: 0, lastEvent: null }
eq(M.tooltipText(idleView), "LensGuard \u2014 camera idle", "idle tooltip")
const actView = { status: "active", users: holderA, errorKind: "", message: "", at: 1, consecutiveFailures: 0, lastEvent: null }
has(M.tooltipText(actView), "example-cam (PID 4102)", "active tooltip names the process")
has(M.tooltipText(actView), "Camera in use", "active tooltip states camera in use")
eq(M.lastEventText(idleView), "", "no last event -> empty line")
eq(M.lastEventText({ status: "idle", users: [], errorKind: "", message: "", at: 1, consecutiveFailures: 0,
  lastEvent: { kind: "opened", at: 1, entry: holderA[0] } }),
  "example-cam (PID 4102) opened the camera", "last event text")

// --- entryKey / diffUsers direct -----------------------------------------
eq(M.entryKey(holderA[0]), "/dev/video0|4102", "entry key device|pid")
const d1 = M.diffUsers([holderA[0]], [])
eq(d1.opened.length, 0, "diff: nothing opened")
eq(d1.closed.length, 1, "diff: one closed")
const d2 = M.diffUsers([], holderB)
eq(d2.opened.length, 1, "diff: one opened")
eq(d2.closed.length, 0, "diff: nothing closed")

// =========================================================================
console.log("LensGuard test-model.js — all assertions passed (" + Object.keys(M).length + " exports)")
