import QtQuick
import qs.Commons
import qs.Ui
import "Model.js" as Model

// LensGuard details panel (minimal, LG-1).
//
// Mirrors the bar widget's live state (hostWidget.view) — one source of
// truth, so the panel and the bar can never disagree. Shows the current
// state, the process(es) holding the camera open (with PID, device and
// user), the last transition LensGuard observed, and a manual re-check.
// Panel content is expanded in a later LensGuard issue (settings, per-app
// allow list, notifications history).
Panel {
  id: root
  moduleName: "io.github.shirak-semonian.lensguard"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property color success: "#a3be8c"
  readonly property color warn: "#ebcb8b"
  readonly property color danger: "#bf616a"
  readonly property color surface: Color.popups.background
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  // NOTE: state fields are read inline from root.view (never cached into an
  // intermediate property between view updates): caching would let a guard
  // see a fresh status while the cached users list is still the old one,
  // producing transient "cannot read property" warnings.
  readonly property var view: hostWidget && hostWidget.view
    ? hostWidget.view : Model.initialView()

  readonly property color statusColor: Model.isActive(root.view)
    ? root.danger : (Model.isError(root.view) ? root.warn
      : (Model.isLoading(root.view) ? root.warn : root.success))

  readonly property string statusText: Model.statusLabel(root.view)

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

  KeyboardPanel {
    id: popup
    anchorItem: root.anchorItem
    owner: root.hostWidget || root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: popup.fittedContentWidth(Style.space(340))
    contentHeight: popup.fittedContentHeight(content.implicitHeight, Style.space(420))

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
          spacing: Style.space(10)

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
                source: Qt.resolvedUrl("assets/icon.png")
                sourceSize.width: 128
                sourceSize.height: 128
                fillMode: Image.PreserveAspectFit
                smooth: true
              }
            }
          }

          // ---- state line ------------------------------------------------
          Column {
            width: parent.width
            spacing: Style.space(2)

            Text {
              width: parent.width
              text: root.statusText
              color: root.statusColor
              font.family: root.fontFamily
              font.pixelSize: Style.font.title
              font.bold: true
              horizontalAlignment: Text.AlignHCenter
            }

            Text {
              width: parent.width
              visible: !Model.isError(root.view)
                && !Model.isLoading(root.view)
              text: Model.isActive(root.view)
                ? (root.view.users.length === 1
                    ? "1 process holds the camera open"
                    : root.view.users.length + " processes hold the camera open")
                : "The camera is not in use."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              wrapMode: Text.WordWrap
              horizontalAlignment: Text.AlignHCenter
            }

            Text {
              width: parent.width
              visible: Model.isError(root.view)
              text: Model.errorText(root.view)
              color: root.warn
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              wrapMode: Text.WordWrap
              horizontalAlignment: Text.AlignHCenter
            }

            Text {
              width: parent.width
              text: "LensGuard keeps watching and recovers automatically."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
              horizontalAlignment: Text.AlignHCenter
            }
          }

          // ---- last transition -------------------------------------------
          Text {
            width: parent.width
            visible: Model.lastEventText(root.view) !== ""
            text: "\u2190 " + Model.lastEventText(root.view)
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
            horizontalAlignment: Text.AlignHCenter
          }

          // ---- camera holders --------------------------------------------
          Column {
            width: parent.width
            spacing: Style.space(4)
            visible: root.view.users.length > 0

            Text {
              width: parent.width
              text: "Camera holders"
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
            }

            // Row height is fixed so the panel never jumps when a process
            // starts/stops; the list is short (only actual camera holders).
            Repeater {
              model: root.view.users

              Rectangle {
                required property var modelData
                width: parent.width
                height: Style.space(34)
                radius: Style.space(6)
                color: Qt.rgba(1, 1, 1, 0.04)

                Row {
                  anchors.fill: parent
                  anchors.leftMargin: Style.space(10)
                  anchors.rightMargin: Style.space(10)
                  spacing: Style.space(8)

                  Column {
                    width: parent.width * 0.55
                    anchors.verticalCenter: parent.verticalCenter
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
                      color: root.dim
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                      elide: Text.ElideRight
                    }
                  }

                  Column {
                    width: parent.width * 0.45
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: 0

                    Text {
                      width: parent.width
                      text: modelData.device
                      color: root.foreground
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.bodySmall
                      horizontalAlignment: Text.AlignRight
                      elide: Text.ElideRight
                    }

                    Text {
                      width: parent.width
                      text: modelData.user ? "user " + modelData.user : ""
                      color: root.dim
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                      horizontalAlignment: Text.AlignRight
                      elide: Text.ElideRight
                    }
                  }
                }
              }
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
            text: "Probes /dev/video* once per second."
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            horizontalAlignment: Text.AlignHCenter
          }
        }
      }
    }
  }
}
