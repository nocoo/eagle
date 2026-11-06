import SwiftUI

/// One transcript row. Assistant turns are plain text; only user turns and the
/// delivery meta lines carry color.
public enum TranscriptEntry: Identifiable, Hashable, Sendable {
  /// `from` names the peer whose message this answer was given to; absent means the open bot was
  /// answering a person.
  case assistant(id: String, blocks: [AssistantBlock], from: PeerOrigin? = nil)
  /// The assistant turn still receiving deltas: the bubble shows a caret.
  case streamingAssistant(id: String, blocks: [AssistantBlock])
  /// A person's turn; `origin` names a cause other than a person typing (TRIGGERS.md §6).
  case user(id: String, text: String, origin: String? = nil)
  case note(id: String, text: String, tintIndices: [Int])
  /// One round trip between this bot and one counterpart, folded into a single line.
  case peerExchange(id: String, exchange: PeerExchange)
  case tool(id: String, row: ToolRow)
  /// An `ask_user` call: a control the person answers, not chat history.
  case question(id: String, card: AskCard)
  /// A `secret_request` call: a card the person fills in with a password.
  case secret(id: String, card: SecretCard)
  /// Several calls from one turn, collapsed into a single line with a detail sheet.
  case toolRun(id: String, rows: [ToolRow])

  public var id: String {
    switch self {
    case .assistant(let id, _, _), .streamingAssistant(let id, _), .user(let id, _, _),
      .note(let id, _, _), .peerExchange(let id, _), .tool(let id, _), .toolRun(let id, _),
      .question(let id, _), .secret(let id, _):
      return id
    }
  }

  public var isToolCall: Bool {
    switch self {
    case .tool, .toolRun: return true
    default: return false
    }
  }
}

extension [TranscriptEntry] {
  /// Settings → 通用 hides tool traffic without touching the stored conversation.
  public func hidingToolCalls(_ hidden: Bool) -> [TranscriptEntry] {
    guard hidden else { return self }
    return filter { !$0.isToolCall }
  }
}

/// Middle column: a slim control strip, scrollable transcript, composer.
public struct ConversationColumn: View {
  private let title: String
  private let tintIndex: Int
  /// The bot's own face, shared with its sidebar row and the inspector.
  private let face: BotFace.Style?
  private let entries: [TranscriptEntry]
  private let showsToolCalls: Bool
  private let preparedMarkdown: [String: [RenderedMarkdownBlock]]
  @Binding private var draft: String
  private let onSend: () -> Void
  private let onShowSidebar: () -> Void
  private let onToggleInspector: () -> Void
  /// Opens a peer exchange by id; nil leaves the rows inert for surfaces that never show one.
  private let onOpenPeerExchange: ((String) -> Void)?
  private let onAnswerCard: ((String, [[String]], Bool) async -> Result<Void, AskCardFailure>)?
  /// Answers a secret card: the answer, and what the daemon said about it.
  private let onAnswerSecret: ((SecretCardAnswer) async -> Result<Void, SecretCardFailure>)?
  private let showsSidebar: Bool
  private let showsInspector: Bool
  private let participantStatus: ParticipantStatus?
  /// Whether a bot is working with nothing to show yet: the wave line above the composer.
  private let isWaiting: Bool
  private let onStop: () -> Void
  private let onInsert: (() -> Void)?
  private let onRecover: () -> Void
  private let onRetryConnection: () -> Void
  private let onDismissError: () -> Void
  @State private var composerFocusRequest = 0

  public init(
    title: String,
    tintIndex: Int = 0,
    face: BotFace.Style? = nil,
    entries: [TranscriptEntry],
    showsToolCalls: Bool = true,
    preparedMarkdown: [String: [RenderedMarkdownBlock]] = [:],
    draft: Binding<String>,
    onSend: @escaping () -> Void,
    showsSidebar: Bool = true,
    showsInspector: Bool = true,
    participantStatus: ParticipantStatus? = nil,
    isWaiting: Bool = false,
    onStop: @escaping () -> Void = {},
    onInsert: (() -> Void)? = nil,
    onRecover: @escaping () -> Void = {},
    onRetryConnection: @escaping () -> Void = {},
    onDismissError: @escaping () -> Void = {},
    onShowSidebar: @escaping () -> Void = {},
    onToggleInspector: @escaping () -> Void = {},
    onOpenPeerExchange: ((String) -> Void)? = nil,
    onAnswerCard: ((String, [[String]], Bool) async -> Result<Void, AskCardFailure>)? = nil,
    onAnswerSecret: ((SecretCardAnswer) async -> Result<Void, SecretCardFailure>)? = nil
  ) {
    self.title = title
    self.tintIndex = tintIndex
    self.face = face
    self.entries = entries
    self.showsToolCalls = showsToolCalls
    self.preparedMarkdown = preparedMarkdown
    self._draft = draft
    self.onSend = onSend
    self.showsSidebar = showsSidebar
    self.showsInspector = showsInspector
    self.participantStatus = participantStatus
    self.isWaiting = isWaiting
    self.onStop = onStop
    self.onInsert = onInsert
    self.onRecover = onRecover
    self.onRetryConnection = onRetryConnection
    self.onDismissError = onDismissError
    self.onShowSidebar = onShowSidebar
    self.onToggleInspector = onToggleInspector
    self.onOpenPeerExchange = onOpenPeerExchange
    self.onAnswerCard = onAnswerCard
    self.onAnswerSecret = onAnswerSecret
  }

  public var body: some View {
    VStack(spacing: 0) {
      header

      transcript
        .frame(maxWidth: .infinity, maxHeight: .infinity)

      // The waiting line owns a band of its own: work starting or finishing repaints one
      // line and never moves the transcript or the composer.
      HStack(spacing: 0) {
        if isWaiting {
          WaitingLine(
            face: face, tintIndex: tintIndex, initial: String(title.prefix(1))
          )
          .transition(.opacity)
        }
        Spacer(minLength: 0)
      }
      .frame(height: Theme.Metric.waitingBandHeight)
      .padding(.horizontal, Theme.Metric.conversationInset)
      .frame(maxWidth: Theme.Chat.laneMaxWidth)
      .animation(Theme.Motion.waiting, value: isWaiting)

      Composer(
        placeholder: "给 \(title) 发消息",
        hint: onInsert == nil ? nil : "⌘↩ 插入当前回答",
        text: $draft,
        onSend: onSend,
        onInsert: onInsert,
        autofocus: true,
        focusRequest: composerFocusRequest
      )
      .fixedSize(horizontal: false, vertical: true)
      .padding(.horizontal, Theme.Metric.conversationInset)
      .frame(maxWidth: Theme.Chat.laneMaxWidth)
      .padding(.bottom, Theme.Metric.composerBottomInset)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Theme.Palette.surface)
  }

  private var header: some View {
    HeaderRow {
      ZStack {
        ParticipantBubble(
          name: title,
          tintIndex: tintIndex,
          face: face,
          status: participantStatus,
          onStop: onStop,
          onRecover: onRecover,
          onRetry: onRetryConnection,
          onDismissError: onDismissError,
          action: onToggleInspector
        )
        .padding(
          .horizontal,
          (showsSidebar ? Theme.Metric.conversationInset : Theme.Metric.trafficLightsClearance)
            + Theme.Metric.headerControlHeight + Theme.Chat.actionGap
        )

        HStack(spacing: Theme.Chat.actionGap) {
          if !showsSidebar {
            IconButton(
              systemName: "sidebar.left", label: "展开侧栏", style: .circled, action: onShowSidebar)
          }
          Spacer(minLength: 0)
          if !showsInspector {
            IconButton(
              systemName: "sidebar.right", label: "展开检查器", style: .circled,
              action: onToggleInspector)
          }
        }
        .padding(
          .leading,
          showsSidebar ? Theme.Metric.conversationInset : Theme.Metric.trafficLightsClearance
        )
        .padding(.trailing, Theme.Metric.conversationInset)
      }
    }
  }

  private var transcript: some View {
    TranscriptScrollColumn {
      ForEach(entries.hidingToolCalls(!showsToolCalls)) { entry in
        TranscriptEntryRow(
          entry: entry,
          preparedMarkdown: preparedMarkdown,
          onOpenPeerExchange: onOpenPeerExchange,
          onAnswerCard: onAnswerCard,
          onAnswerSecret: onAnswerSecret
        )
        .id(entry.id)
      }
    }
  }
}
