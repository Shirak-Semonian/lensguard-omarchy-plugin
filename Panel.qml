import QtQuick
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// LensGuard details panel.
//
// Mirrors the bar widget's live state (hostWidget.view) — one source of
// truth, so the panel and the bar can never disagree. The panel shows:
//   * LIVE — the current camera state; each process holding the camera gets
//     a card with its name, PID, user, device(s) and when it opened the
//     camera. A KNOWN app (whitelisted) card is calm yellow; an UNKNOWN
//     process is a red attention card with "Allow" (add to the whitelist)
//     and "Investigate" (show its full command line) actions.
//   * HISTORY — the last camera opened/closed events (persisted across shell
//     restarts in the state file), newest first.
//   * WHITELIST — the apps that may use the camera without an alert; entries
//     can be removed here (Deny) and the config file can be opened for
//     direct editing. All changes are written atomically, mode 600.
//   * SETTINGS — poll interval, notification toggles, bar-text options and
//     the reset-to-defaults action (config.json.bak is kept). Written the
//     same atomic way, no JSON editing needed.
// Config problems never stop the guard: the widget keeps working on the
// defaults and the panel shows a calm note (never the file content) with a
// one-click reset.
Panel {
  id: root
  moduleName: "io.github.shirak-semonian.lensguard"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color dim: Qt.darker(foreground, 1.55)
  // Same calm state palette as the bar widget (LG-3): one hue per state so
  // the panel and the bar can never disagree about what a state means.
  readonly property color success: "#a3be8c"
  readonly property color warn: "#e6c384"
  readonly property color danger: "#bf616a"
  readonly property color notice: "#d08770"
  readonly property color surface: Color.popups.background
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  // NOTE: state fields are read inline from root.view (never cached into an
  // intermediate property between view updates): caching would let a guard
  // see a fresh status while the cached users list is still the old one,
  // producing transient "cannot read property" warnings.
  readonly property var view: hostWidget && hostWidget.view
    ? hostWidget.view : Model.initialView()
  readonly property var whitelist: hostWidget && hostWidget.whitelist
    ? hostWidget.whitelist : Model.DEFAULT_WHITELIST
  readonly property var config: hostWidget && hostWidget.config
    ? hostWidget.config : Model.defaultConfig()
  readonly property string configPath: hostWidget && hostWidget.configPath
    ? hostWidget.configPath : ""

  readonly property bool hasError: Model.isError(root.view)
  readonly property bool isLoading: Model.isLoading(root.view)
  readonly property bool isIdle: Model.isIdle(root.view)
  readonly property bool isActive: Model.isActive(root.view)
  readonly property bool hasUnknown: Model.anyUnknown(root.view, root.whitelist)

  readonly property color statusColor: root.isActive
    ? (root.hasUnknown ? root.danger : root.warn)
    : (root.hasError ? root.notice
      : (root.isLoading ? root.dim : root.success))
  readonly property string statusText: {
    if (root.isActive) {
      return root.hasUnknown
        ? "Unknown process using the camera"
        : "Camera in use by a known app"
    }
    if (root.hasError) return "Detection unavailable"
    if (root.isLoading) return "Checking the camera\u2026"
    return "Camera idle"
  }
  readonly property string statusSubText: {
    if (root.isActive) {
      return root.hasUnknown
        ? "A process not on your whitelist has the camera open."
        : "The camera is in use — no alert, it is a known app."
    }
    if (root.hasError) return Model.errorText(root.view)
    if (root.isLoading) return "First check runs automatically."
    return "No camera activity \u2014 your lens is safe."
  }

  // Investigate (full command line of an unknown process).
  property string _investigatePid: ""
  property string _investigateOutput: ""
  property bool _investigateRunning: false

  function open() {
    root.controller.show()
  }

  function close() {
    root.controller.hide()
  }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.hostWidget || root, direction)
    return false
  }

  function checkNow() {
    if (hostWidget && typeof hostWidget.refreshNow === "function") {
      hostWidget.refreshNow()
    }
  }

  function allow(command) {
    if (hostWidget && typeof hostWidget.allowCommand === "function") {
      hostWidget.allowCommand(command)
    }
  }

  function deny(entry) {
    if (hostWidget && typeof hostWidget.denyCommand === "function") {
      hostWidget.denyCommand(entry)
    }
  }

  // Generic settings change (LG-3): forwarded to the host widget, which
  // applies it in memory and writes the full config atomically.
  function setConfig(key, value) {
    if (hostWidget && typeof hostWidget.setConfigValue === "function") {
      hostWidget.setConfigValue(key, value)
    }
  }

  // Reset the settings to defaults (keeps config.json.bak on disk).
  function resetConfig() {
    if (hostWidget && typeof hostWidget.resetConfigToDefaults === "function") {
      hostWidget.resetConfigToDefaults()
    }
  }

  // Human interval label for the settings dropdown + footer caption.
  function intervalText(ms) {
    return Model.intervalLabel(Model.clampPollInterval(ms))
  }

  function openConfig() {
    if (hostWidget && typeof hostWidget.openConfigFile === "function") {
      hostWidget.openConfigFile()
    }
  }

  function investigate(pid) {
    var key = String(pid)
    if (root._investigatePid === key) {
      // Toggle: hide the details again.
      root._investigatePid = ""
      root._investigateOutput = ""
      return
    }
    if (root._investigateRunning) return // one probe at a time
    var cmd = Model.investigateCommand(pid)
    if (!cmd) return
    root._investigatePid = key
    root._investigateOutput = ""
    root._investigateRunning = true
    investigateProc.command = cmd
    investigateProc.running = true
  }

  KeyboardPanel {
    id: popup
    anchorItem: root.anchorItem
    owner: root.hostWidget || root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: popup.fittedContentWidth(Style.space(360))
    contentHeight: popup.fittedContentHeight(content.implicitHeight, Style.space(600))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Flickable {
        id: panelScroll
        anchors.fill: parent
        contentWidth: content.width
        contentHeight: content.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        interactive: contentHeight > height

        Column {
          id: content
          width: panelScroll.width
          spacing: Style.space(12)

          PanelHero {
            id: heroCard
            width: parent.width
            title: "LensGuard"
            meta: "Camera activity guard"
            detail: root.statusText.toUpperCase()
            foreground: root.foreground
            fontFamily: root.fontFamily
            iconComponent: Component {
              Image {
                width: heroCard.iconSize
                height: width
                source: Qt.resolvedUrl(root.isActive
                  ? (root.hasUnknown ? "assets/icon-active.png" : "assets/icon-known.png")
                  : (root.hasError ? "assets/icon-error.png" : "assets/icon.png"))
                sourceSize.width: 128
                sourceSize.height: 128
                fillMode: Image.PreserveAspectFit
                smooth: true
              }
            }
          }

          // ---- live status ----------------------------------------------
          Rectangle {
            width: parent.width
            height: liveColumn.implicitHeight + Style.space(16)
            radius: Style.space(8)
            color: Qt.rgba(root.statusColor.r, root.statusColor.g,
              root.statusColor.b, 0.10)
            border.color: Qt.rgba(root.statusColor.r, root.statusColor.g,
              root.statusColor.b, 0.35)
            border.width: 1

            Column {
              id: liveColumn
              anchors.fill: parent
              anchors.margins: Style.space(10)
              spacing: Style.space(2)

              Text {
                width: parent.width
                text: root.statusText
                color: root.statusColor
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
                font.bold: true
                wrapMode: Text.WordWrap
              }

              Text {
                width: parent.width
                text: root.statusSubText
                color: root.isIdle ? root.success : root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                wrapMode: Text.WordWrap
              }
            }
          }

          // ---- live camera holders ----------------------------------------
          PanelSectionHeader {
            text: "Live"
            foreground: root.foreground
            fontFamily: root.fontFamily
            visible: root.isActive || root.isLoading
          }

          Text {
            width: parent.width
            visible: root.isLoading
            text: "Waiting for the first camera check\u2026"
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
            horizontalAlignment: Text.AlignHCenter
          }

          Column {
            width: parent.width
            spacing: Style.space(8)
            visible: root.isActive

            Repeater {
              id: procRepeater
              model: Model.processRows(root.view, root.whitelist)

              Rectangle {
                required property var modelData
                width: parent.width
                height: procCard.height + Style.space(14)
                radius: Style.space(8)
                color: Qt.rgba(1, 1, 1, 0.04)
                border.color: modelData.known
                  ? Qt.rgba(root.warn.r, root.warn.g, root.warn.b, 0.30)
                  : Qt.rgba(root.danger.r, root.danger.g, root.danger.b, 0.45)
                border.width: 1

                Column {
                  id: procCard
                  width: parent.width - Style.space(20)
                  x: Style.space(10)
                  y: Style.space(7)
                  spacing: Style.space(6)

                  Row {
                    width: parent.width
                    spacing: Style.space(8)

                    Column {
                      width: parent.width - Style.space(86) - Style.space(8)
                      spacing: 0

                      Text {
                        width: parent.width
                        text: modelData.command || "?"
                        color: root.foreground
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.bodySmall
                        font.bold: true
                        elide: Text.ElideRight
                      }

                      Text {
                        width: parent.width
                        text: "PID " + modelData.pid
                          + (modelData.user ? "  \u00b7  user " + modelData.user : "")
                          + (modelData.since ? "  \u00b7  since " + Model.sinceText(modelData.since) : "")
                        color: root.dim
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.caption
                        elide: Text.ElideRight
                      }
                    }

                    Text {
                      width: Style.space(86)
                      anchors.verticalCenter: parent.verticalCenter
                      text: modelData.known ? "known app" : "unknown"
                      color: modelData.known ? root.warn : root.danger
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                      font.bold: true
                      horizontalAlignment: Text.AlignRight
                    }
                  }

                  Text {
                    width: parent.width
                    text: "devices: " + modelData.devices.join(", ")
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    elide: Text.ElideRight
                    visible: modelData.devices && modelData.devices.length > 0
                  }

                  // ---- attention state: unknown process -----------------
                  Rectangle {
                    width: parent.width
                    visible: !modelData.known
                    height: attentionCol.height + Style.space(10)
                    radius: Style.space(6)
                    color: Qt.rgba(root.danger.r, root.danger.g, root.danger.b, 0.12)

                    Column {
                      id: attentionCol
                      width: parent.width - Style.space(16)
                      x: Style.space(8)
                      y: Style.space(5)
                      spacing: Style.space(6)

                      Text {
                        width: parent.width
                        text: "Unknown process \u2014 not on your whitelist"
                        color: root.danger
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.caption
                        font.bold: true
                        wrapMode: Text.WordWrap
                      }

                      Text {
                        width: parent.width
                        text: "Allow it to use the camera without alerts, or investigate its full command line."
                        color: root.dim
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.caption
                        wrapMode: Text.WordWrap
                        visible: root._investigatePid !== String(modelData.pid)
                      }

                      Row {
                        width: parent.width
                        spacing: Style.space(8)

                        Button {
                          width: (parent.width - Style.space(8)) / 2
                          text: "Allow"
                          iconText: "\uf00c"
                          foreground: root.foreground
                          fontFamily: root.fontFamily
                          focusable: true
                          onClicked: root.allow(modelData.command)
                        }

                        Button {
                          width: (parent.width - Style.space(8)) / 2
                          text: root._investigatePid === String(modelData.pid)
                            ? "Hide details" : "Investigate"
                          iconText: "\uf05a"
                          foreground: root.foreground
                          fontFamily: root.fontFamily
                          focusable: true
                          onClicked: root.investigate(modelData.pid)
                        }
                      }

                      // Investigate result: the full command line of this pid
                      // (read from /proc/<pid>/cmdline, argv only).
                      Text {
                        width: parent.width
                        visible: root._investigatePid === String(modelData.pid)
                          && root._investigateOutput !== ""
                        text: root._investigateOutput
                        color: root.foreground
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.caption
                        font.italic: true
                        wrapMode: Text.WrapAnywhere
                      }

                      Text {
                        width: parent.width
                        visible: root._investigatePid === String(modelData.pid)
                          && root._investigateRunning
                        text: "Reading process details\u2026"
                        color: root.dim
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.caption
                      }

                      Text {
                        width: parent.width
                        visible: root._investigatePid === String(modelData.pid)
                          && !root._investigateRunning
                          && root._investigateOutput === ""
                        text: "Process details unavailable (it may have exited)."
                        color: root.dim
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.caption
                        wrapMode: Text.WordWrap
                      }
                    }
                  }
                }
              }
            }
          }

          // ---- config file needs attention -------------------------------
          Column {
            width: parent.width
            spacing: Style.space(6)
            visible: hostWidget && hostWidget.configErrorKind !== ""

            Text {
              width: parent.width
              text: "Whitelist config needs attention"
              color: root.warn
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              font.bold: true
              horizontalAlignment: Text.AlignHCenter
            }

            Text {
              width: parent.width
              text: "The config file is not readable or not valid JSON. "
                + "LensGuard keeps working with the default settings."
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
              horizontalAlignment: Text.AlignHCenter
            }

            Text {
              width: parent.width
              text: root.configPath
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
              wrapMode: Text.WordWrap
              horizontalAlignment: Text.AlignHCenter
            }

            // One click heals a broken file: defaults are written atomically
            // (mode 600) and the current file is kept as config.json.bak.
            // Nothing from the broken file is ever shown in the UI.
            Row {
              width: parent.width
              spacing: Style.space(8)

              Button {
                width: (parent.width - Style.space(8)) / 2
                text: "Open config file"
                iconText: "\uf044"
                foreground: root.foreground
                fontFamily: root.fontFamily
                focusable: true
                onClicked: root.openConfig()
              }

              Button {
                width: (parent.width - Style.space(8)) / 2
                text: "Reset to defaults"
                iconText: "\uf0e2"
                foreground: root.foreground
                fontFamily: root.fontFamily
                focusable: true
                onClicked: root.resetConfig()
              }
            }
          }

          PanelSeparator {
            foreground: root.foreground
          }

          // ---- history ----------------------------------------------------
          PanelSectionHeader {
            text: "Activity history"
            foreground: root.foreground
            fontFamily: root.fontFamily
          }

          Text {
            width: parent.width
            visible: root.view.history.length === 0
            text: "No camera activity yet \u2014 opened and closed events will appear here."
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
            horizontalAlignment: Text.AlignHCenter
          }

          Column {
            width: parent.width
            spacing: Style.space(2)
            visible: root.view.history.length > 0

            Repeater {
              model: root.view.history

              delegate: Row {
                required property var modelData
                width: content.width
                spacing: Style.space(6)
                height: Style.space(18)

                Text {
                  anchors.verticalCenter: parent.verticalCenter
                  width: Style.space(56)
                  text: Model.formatTime(modelData.at)
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                }

                Text {
                  anchors.verticalCenter: parent.verticalCenter
                  width: Style.space(64)
                  text: modelData.kind === "opened" ? "opened" : "closed"
                  color: modelData.kind === "opened" ? root.danger : root.success
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  font.bold: true
                }

                Text {
                  anchors.verticalCenter: parent.verticalCenter
                  width: content.width - Style.space(56) - Style.space(64) - Style.space(12)
                  text: modelData.command + "  (PID " + modelData.pid + ")"
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  elide: Text.ElideRight
                }
              }
            }
          }

          PanelSeparator {
            foreground: root.foreground
          }

          // ---- whitelist --------------------------------------------------
          PanelSectionHeader {
            text: "Whitelist"
            foreground: root.foreground
            fontFamily: root.fontFamily
          }

          Text {
            width: parent.width
            text: "Apps listed here may use the camera without an alert "
              + "(calm yellow \"known app\" status). Everything else is "
              + "unknown (red) and alerts you unless you turn alerts off in "
              + "Settings. Add apps from an unknown-process card or remove "
              + "them here."
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
          }

          Column {
            width: parent.width
            spacing: Style.space(4)

            Repeater {
              model: root.whitelist

              delegate: Row {
                required property var modelData
                width: content.width
                spacing: Style.space(8)
                height: Style.space(24)

                Text {
                  anchors.verticalCenter: parent.verticalCenter
                  width: content.width - Style.space(90)
                  text: "• " + modelData
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.bodySmall
                  elide: Text.ElideRight
                }

                Button {
                  width: Style.space(82)
                  anchors.verticalCenter: parent.verticalCenter
                  text: "Deny"
                  iconText: "\uf05e"
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  fontSize: Style.font.caption
                  focusable: true
                  onClicked: root.deny(modelData)
                }
              }
            }
          }

          Button {
            width: parent.width
            text: "Open whitelist config file"
            iconText: "\uf044"
            foreground: root.foreground
            fontFamily: root.fontFamily
            focusable: true
            onClicked: root.openConfig()
          }

          PanelSeparator {
            foreground: root.foreground
          }

          // ---- settings (LG-3) ---------------------------------------------
          // All settings live in ~/.config/lensguard/config.json; changing a
          // control writes the full config atomically (mode 600) — no JSON
          // editing needed. Defaults are automatic for any missing key.
          PanelSectionHeader {
            text: "Settings"
            foreground: root.foreground
            fontFamily: root.fontFamily
          }

          Column {
            width: parent.width
            spacing: Style.space(8)

            Toggle {
              width: parent.width
              label: "Notify when the camera opens"
              description: "Desktop notification when a new app opens the camera."
              checked: root.config.notifyOnOpen !== false
              foreground: root.foreground
              fontFamily: root.fontFamily
              hasCursor: false
              onClicked: root.setConfig("notifyOnOpen", root.config.notifyOnOpen === false)
            }

            Toggle {
              width: parent.width
              label: "Alert on unknown apps"
              description: "When off, unknown opens stay red in the bar without a popup."
              checked: root.config.notifyOnUnknown !== false
              foreground: root.foreground
              fontFamily: root.fontFamily
              hasCursor: false
              onClicked: root.setConfig("notifyOnUnknown", root.config.notifyOnUnknown === false)
            }

            Toggle {
              width: parent.width
              label: "Show process name in the bar"
              description: "While the camera is in use, name the process next to the icon."
              checked: root.config.showProcessInBar !== false
              foreground: root.foreground
              fontFamily: root.fontFamily
              hasCursor: false
              onClicked: root.setConfig("showProcessInBar", root.config.showProcessInBar === false)
            }

            Toggle {
              width: parent.width
              label: "Compact mode"
              description: "Icon only — never show text in the bar."
              checked: root.config.compactMode === true
              foreground: root.foreground
              fontFamily: root.fontFamily
              hasCursor: false
              onClicked: root.setConfig("compactMode", root.config.compactMode !== true)
            }

            Dropdown {
              id: intervalDropdown
              width: parent.width
              label: "Poll interval"
              value: String(Model.clampPollInterval(root.config.pollIntervalMs))
              options: [
                { value: "250", label: "250 ms" },
                { value: "500", label: "500 ms" },
                { value: "1000", label: "1 second" },
                { value: "2000", label: "2 seconds" },
                { value: "5000", label: "5 seconds" }
              ]
              foreground: root.foreground
              fontFamily: root.fontFamily
              onChanged: function(value) {
                root.setConfig("pollIntervalMs", parseInt(value, 10))
              }
            }

            Text {
              width: parent.width
              text: "Stored in " + root.configPath + " (mode 600). "
                + "Reset restores defaults and keeps config.json.bak."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }
          }

          // ---- actions ----------------------------------------------------
          Button {
            width: parent.width
            text: "Check now"
            iconText: "\uf021"
            foreground: root.foreground
            fontFamily: root.fontFamily
            focusable: true
            onClicked: root.checkNow()
          }

          Text {
            width: parent.width
            text: "Probes /dev/video* every "
              + root.intervalText(root.config.pollIntervalMs) + ". "
              + "State and history are stored locally."
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
            horizontalAlignment: Text.AlignHCenter
          }
        }
      }
    }
  }

  Process {
    id: investigateProc
    command: []
    stdout: StdioCollector {
      id: investigateStdout
      waitForEnd: true
      onStreamFinished: root._investigateOutput = text.trim()
    }
    onExited: function(exitCode) {
      root._investigateRunning = false
    }
  }
}
