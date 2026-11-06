import EagleDesign
import SwiftUI

struct BotsConversationContent: View {
  @ObservedObject var bots: BotsWorkspaceViewModel
  @ObservedObject var layout: ShellLayoutViewModel
  @ObservedObject private var transcript: BotsTranscriptViewModel
  @ObservedObject private var composer: BotsComposerViewModel
  /// Bumped by the shell when a dialog closes, so the composer takes the keyboard back.
  let focusRestore: Int
  let onOpenPeerExchange: (String) -> Void
  let onOpenToolRun: (String) -> Void
  @AppStorage("eagle.hideToolCalls") private var hideToolCalls = false

  init(
    bots: BotsWorkspaceViewModel,
    layout: ShellLayoutViewModel,
    focusRestore: Int,
    onOpenPeerExchange: @escaping (String) -> Void,
    onOpenToolRun: @escaping (String) -> Void
  ) {
    self.bots = bots
    self.layout = layout
    self.focusRestore = focusRestore
    self.onOpenPeerExchange = onOpenPeerExchange
    self.onOpenToolRun = onOpenToolRun
    self.transcript = bots.transcript
    self.composer = bots.composer
  }

  var body: some View {
    ConversationColumn(
      title: bots.title,
      face: bots.selectedFace,
      entries: transcript.entries,
      showsToolCalls: !hideToolCalls,
      preparedMarkdown: transcript.markdown,
      draft: Binding(get: { composer.text }, set: { bots.setDraft($0) }),
      onSend: { bots.send() },
      showsSidebar: layout.showsSidebar, showsInspector: layout.showsInspector,
      participantStatus: bots.participantStatus,
      isWaiting: bots.waiting,
      onStop: { bots.abort() },
      onInsert: bots.running ? { bots.send(inserting: true) } : nil,
      onRecover: { bots.recover() },
      onRetryConnection: { bots.retryConnection() },
      onDismissError: { bots.dismissError() },
      onShowSidebar: { layout.toggleSidebar() },
      onToggleInspector: { layout.toggleInspector() },
      focusRestore: focusRestore,
      onOpenPeerExchange: onOpenPeerExchange,
      onOpenToolRun: onOpenToolRun,
      onAnswerCard: { id, answers, skipped in
        await bots.answerQuestions(entryId: id, answers: answers, skipped: skipped)
      },
      onAnswerSecret: { answer in await bots.answerSecret(answer) }
    )
    .id(bots.selectedId)
  }
}
