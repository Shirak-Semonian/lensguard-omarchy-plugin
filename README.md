# LensGuard

Camera activity guard for the Omarchy bar. LensGuard watches which process
holds the webcam (`/dev/video*`) open and shows it clearly in the bar:
calm when the camera is idle, unmistakable when it is in use, with a tooltip
that names the process. Built for people who want to *know* when their
webcam is being used.

> **Privacy first:** LensGuard never opens the camera, records nothing, sends
> nothing over the network, stores no state and needs no account or API key.
> It only lists which processes hold the video device node open — the same
> information `lsof` exposes locally.

![LensGuard preview](assets/preview.png)

## Why this works

An application that uses the camera keeps the video device node (`/dev/video0`,
`/dev/video1`, …) open for as long as it is in use. That is also true for
browsers: the browser delegates capture to PipeWire, and PipeWire opens the
device on the app's behalf — so LensGuard sees the real camera user, not just
the browser process.

Detection is done with the tools that are already on every Arch system:
`lsof -F` (machine readable, primary) or `fuser -v` (fallback). No kernel
module, no service, no privileged daemon.

## Statuses

| Bar glyph | State | Meaning |
| --- | --- | --- |
| Grey camera | idle | No process holds the camera open. |
| Red camera | active | At least one process holds the camera open; the tooltip names it (command + PID). |
| Amber camera | detection unavailable | Tools missing (`lsof`/`fuser`) or no camera device found. LensGuard re-checks calmly every 5 s and recovers automatically. |

Click (left/right) toggles the panel, which shows the current state and the
processes holding the camera (command, PID, device, user) plus the last
transition LensGuard observed. Middle click forces an immediate re-check.

The first poll after a shell start is a silent baseline: when LensGuard
starts while the camera is already in use it shows `active` immediately but
does not ring a false “opened” event. Only transitions that happen while
LensGuard is watching are reported.

## Install

```sh
omarchy plugin add https://github.com/Shirak-Semonian/lensguard-omarchy-plugin --enable --yes
omarchy restart shell
```

Manual / development install: copy the folder to the plugins directory, then
enable it and restart the shell:

```sh
cp -r lensguard-omarchy-plugin ~/.config/omarchy/plugins/io.github.shirak-semonian.lensguard
omarchy-shell shell rescanPlugins
omarchy plugin enable io.github.shirak-semonian.lensguard --section right
omarchy restart shell
```

## Requirements

- Omarchy shell (Quickshell-based bar)
- `lsof` or `fuser` (`coreutils`/`lsof` — both ship with Arch by default;
  LensGuard falls back automatically when one is missing)
- A V4L camera device (`/dev/video0` etc.)
- No network, no keys, no configuration file needed

## Polling behaviour

- One probe per second at most, one probe in flight at a time.
- Every probe runs on a fresh process object; nothing is left behind.
- Every probe is bounded by a 5 s watchdog (kill + rebuild if a probe ever
  hangs), so one wedged probe can never stall the widget.
- In the calm error state (no device / tools missing) the re-check cadence
  drops to once per 5 s.

## Development

```sh
node test-model.js        # unit tests for the detection engine (no deps)
omarchy plugin validate . # plugin manifest validation (exit 0)
```

Layout (same architecture as the other Omarchy widgets by the same author):

- `Model.js` — pure detection logic shared by the QML and the Node tests:
  probe script, `lsof -F`/`fuser -v` parsers, state reducer with
  opened/closed events, display strings. No shell, no Qt, no Node built-ins.
- `BarWidget.qml` — the compact bar widget: 1 s heartbeat, probe lifecycle,
  watchdog, state → glyph/tooltip mapping, panel routing.
- `Panel.qml` — minimal details panel (state + camera holders).
- `test-model.js` — plain-`assert` Node tests, including real probe captures.
- `assets/` — icons (idle/active/error) and the dummy preview.
- `icon-source.svg`, `preview-source.svg` — editable artwork sources.

User-facing text is English. Comments in the code may be Dutch.

## License

MIT © 2026 Shirak Semonian
