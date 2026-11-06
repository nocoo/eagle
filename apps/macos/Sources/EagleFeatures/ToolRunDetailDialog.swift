import EagleDesign
import SwiftUI

/// One tool run's details, read from the transcript that owns it for as long as the dialog is
/// open: a call still running keeps updating instead of freezing at the moment of the click.
/// Only this view observes the deltas; the shell is not asked to.
struct BotToolRunDetailDialog: View {
  @ObservedObject var transcript: BotsTranscriptViewModel
  let id: String
  let onClose: () -> Void

  var body: some View {
    ToolRunDetailView(rows: transcript.entries.toolRunRows(id: id) ?? [], onClose: onClose)
  }
}

/// The same dialog over the sample transcript, which is owned by the sample chat model.
struct SampleToolRunDetailDialog: View {
  @ObservedObject var chat: BotChatViewModel
  let id: String
  let onClose: () -> Void

  var body: some View {
    ToolRunDetailView(rows: chat.entries.toolRunRows(id: id) ?? [], onClose: onClose)
  }
}
