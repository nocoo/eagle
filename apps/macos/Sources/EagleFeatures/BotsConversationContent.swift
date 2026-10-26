import EagleDesign
import SwiftUI

struct BotsConversationContent: View {
  @ObservedObject var bots: BotsWorkspaceViewModel
  @ObservedObject var layout: ShellLayoutViewModel
  @ObservedObject private var transcript: BotsTranscriptViewModel
  @ObservedObject private var composer: BotsComposerViewModel

  init(bots: BotsWorkspaceViewModel, layout: ShellLayoutViewModel) {
    self.bots = bots
    self.layout = layout
    self.transcript = bots.transcript
    self.composer = bots.composer
  }

  var body: some View {
    ConversationColumn(
      title: bots.title, subtitle: bots.subtitle, tintIndex: bots.tintIndex,
      entries: transcript.entries,
      preparedMarkdown: transcript.markdown,
      draft: Binding(get: { composer.text }, set: { bots.setDraft($0) }),
      onSend: { bots.send() },
      showsSidebar: layout.showsSidebar, showsInspector: layout.showsInspector,
      participantStatus: bots.participantStatus,
      onStop: { bots.abort() }, onRecover: { bots.recover() },
      onDismissError: { bots.dismissError() },
      onShowSidebar: { layout.toggleSidebar() },
      onToggleInspector: { layout.toggleInspector() }
    )
    .id(bots.selectedId)
  }
}
