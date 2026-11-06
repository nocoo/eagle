import SwiftUI

/// One row in the transcript column, split out so benchmarks can build the same tree inside
/// [`TranscriptScrollColumn`] as production without duplicating row switch logic.
struct TranscriptEntryRow: View {
  private let entry: TranscriptEntry
  private let preparedMarkdown: [String: [RenderedMarkdownBlock]]
  private let onOpenPeerExchange: ((String) -> Void)?
  private let onOpenToolRun: ((String) -> Void)?
  private let onAnswerCard: ((String, [[String]], Bool) async -> Result<Void, AskCardFailure>)?
  private let onAnswerSecret: ((SecretCardAnswer) async -> Result<Void, SecretCardFailure>)?

  init(
    entry: TranscriptEntry,
    preparedMarkdown: [String: [RenderedMarkdownBlock]],
    onOpenPeerExchange: ((String) -> Void)?,
    onOpenToolRun: ((String) -> Void)? = nil,
    onAnswerCard: ((String, [[String]], Bool) async -> Result<Void, AskCardFailure>)?,
    onAnswerSecret: ((SecretCardAnswer) async -> Result<Void, SecretCardFailure>)?
  ) {
    self.entry = entry
    self.preparedMarkdown = preparedMarkdown
    self.onOpenPeerExchange = onOpenPeerExchange
    self.onOpenToolRun = onOpenToolRun
    self.onAnswerCard = onAnswerCard
    self.onAnswerSecret = onAnswerSecret
  }

  var body: some View {
    switch entry {
    case .assistant(_, let blocks, let from):
      VStack(alignment: .leading, spacing: Theme.Layout.labelGap) {
        AssistantBubble(
          text: blocks.markdown, preparedBlocks: preparedMarkdown[entry.id]
        )
        .equatable()
        if let from {
          PeerOriginRow(origin: from) { id in onOpenPeerExchange?(id) }
        }
      }
      .transition(
        .asymmetric(
          insertion: .opacity.combined(
            with: .scale(scale: Theme.Chat.messageEntryScale, anchor: .bottomLeading)),
          removal: .opacity
        )
      )
    case .streamingAssistant(_, let blocks):
      AssistantBubble(
        text: blocks.markdown, streaming: true, preparedBlocks: preparedMarkdown[entry.id]
      )
      .equatable()
      .transition(
        .asymmetric(
          insertion: .opacity.combined(
            with: .scale(scale: Theme.Chat.messageEntryScale, anchor: .bottomLeading)),
          removal: .opacity
        )
      )
    case .user(_, let text, let origin):
      UserBubble(text, origin: origin)
        .transition(
          .asymmetric(
            insertion: .opacity.combined(
              with: .scale(scale: Theme.Chat.messageEntryScale, anchor: .bottomTrailing)),
            removal: .opacity
          )
        )
    case .note(_, let text, let tintIndices):
      DeliveryNote(text, avatars: tintIndices.map(Theme.Palette.avatarTint))
    case .peerExchange(_, let exchange):
      PeerExchangeRow(exchange: exchange) { onOpenPeerExchange?(exchange.id) }
        .transition(.opacity)
    case .question(_, let card):
      AskCardRow(
        card: card,
        onAnswer: { id, answers, skipped in
          guard let onAnswerCard else { return .failure(AskCardFailure("这个客户端不能提交回答")) }
          return await onAnswerCard(id, answers, skipped)
        }
      )
      .transition(.opacity)
    case .secret(_, let card):
      SecretCardRow(card: card) { answer in
        guard let onAnswerSecret else { return .failure(SecretCardFailure("这个客户端不能保存密码")) }
        return await onAnswerSecret(answer)
      }
      .transition(.opacity)
    case .tool(_, let row):
      ToolCallRow(row)
        .transition(.opacity.combined(with: .move(edge: .bottom)))
    case .toolRun(let id, let rows):
      ToolRunRow(rows) { onOpenToolRun?(id) }
        .transition(.opacity)
    }
  }
}
