import BotsCore
import EagleDesign
import SwiftUI

/// One dialog's content at the shell's root. Every case goes through the shared modal host,
/// so the backdrop, the card chrome and the way clicks and Escape are stopped are the same
/// everywhere the shell opens something.
struct WorkspaceDialogHost: View {
  let dialog: WorkspaceDialog
  let available: CGSize
  let peerInsets: EdgeInsets
  let settings: SettingsViewModel
  let daemon: BotsDaemonSupervisor?
  let devices: DeviceSettingsViewModel
  let transcript: BotsTranscriptViewModel
  let sampleTranscript: BotChatViewModel
  let onCreate: (String, String?, BotCreationAppearance) -> Void
  let onSaveFace: (BotAppearance) -> Void
  let onDismiss: () -> Void

  var body: some View {
    ModalHost(insets: insets, onDismiss: onDismiss) {
      content
    }
  }

  /// Only the peer panel keeps clear of the columns; every other dialog is centred.
  private var insets: EdgeInsets {
    switch dialog {
    case .peer: peerInsets
    default: EdgeInsets()
    }
  }

  private var settingsSize: CGSize {
    Theme.Metric.settingsSize(in: available)
  }

  @ViewBuilder private var content: some View {
    switch dialog {
    case .createBot:
      BotCreateSheet(onCreate: onCreate, onCancel: onDismiss)
    case .editFace(let face):
      BotFaceEditorSheet(initial: face, onSave: onSaveFace, onCancel: onDismiss)
    case .peer(let exchange):
      PeerConversationDialog(exchange: exchange, onClose: onDismiss)
    case .toolRun(let id, let owner):
      switch owner {
      case .bot:
        BotToolRunDetailDialog(transcript: transcript, id: id, onClose: onDismiss)
      case .sample:
        SampleToolRunDetailDialog(chat: sampleTranscript, id: id, onClose: onDismiss)
      }
    case .settings:
      SettingsView(model: settings, onClose: onDismiss, daemon: daemon, devices: devices)
        .frame(width: settingsSize.width, height: settingsSize.height)
    }
  }
}
