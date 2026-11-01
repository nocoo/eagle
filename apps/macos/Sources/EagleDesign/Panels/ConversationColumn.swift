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
  /// Several calls from one turn, collapsed into a single line with a detail sheet.
  case toolRun(id: String, rows: [ToolRow])

  public var id: String {
    switch self {
    case .assistant(let id, _, _), .streamingAssistant(let id, _), .user(let id, _, _),
      .note(let id, _, _), .peerExchange(let id, _), .tool(let id, _), .toolRun(let id, _):
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
  @State private var scroller = TranscriptScroller()
  @State private var composerFocusRequest = 0

  public init(
    title: String,
    tintIndex: Int,
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
    onOpenPeerExchange: ((String) -> Void)? = nil
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
      .animation(.easeOut(duration: 0.18), value: isWaiting)

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
            + Theme.Metric.headerControlHeight + 8
        )

        HStack(spacing: 8) {
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
    ScrollViewReader { proxy in
      GeometryReader { viewport in
        ScrollView {
          LazyVStack(alignment: .leading, spacing: Theme.Metric.turnGap) {
            ForEach(entries.hidingToolCalls(!showsToolCalls)) { entry in
              row(entry).id(entry.id)
            }
            Color.clear.frame(height: 1).id("bottom")
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, Theme.Metric.conversationInset)
          // Clear of the top edge fade: the first row must not start under it.
          .padding(.top, Theme.Metric.edgeFadeHeight + 10)
          .padding(.bottom, 12)
          .frame(minHeight: viewport.size.height, alignment: .top)
          // The document's background catches only blank space, behind message controls.
          .background {
            Color.clear
              .contentShape(Rectangle())
              .onTapGesture { composerFocusRequest += 1 }
              .accessibilityHidden(true)
          }
        }
        .scrollEdgeFades(
          Theme.Palette.surface, top: Theme.Metric.edgeFadeHeight,
          bottom: Theme.Metric.edgeFadeHeight
        )
        .onScrollPhaseChange { _, phase in
          scroller.setUserScrolling(
            phase == .tracking || phase == .interacting || phase == .decelerating)
          if phase == .idle, scroller.endUserScroll() {
            proxy.scrollTo("bottom", anchor: .bottom)
          }
        }
        .onScrollGeometryChange(for: TranscriptScrollMetrics.self) { geometry in
          TranscriptScrollMetrics(
            contentHeight: geometry.contentSize.height, visibleBottom: geometry.visibleRect.maxY
          )
        } action: { _, metrics in
          if scroller.update(metrics) {
            proxy.scrollTo("bottom", anchor: .bottom)
          }
        }
      }
    }
  }

  @ViewBuilder
  private func row(_ entry: TranscriptEntry) -> some View {
    switch entry {
    case .assistant(_, let blocks, let from):
      VStack(alignment: .leading, spacing: 6) {
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
          insertion: .opacity.combined(with: .scale(scale: 0.985, anchor: .bottomLeading)),
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
          insertion: .opacity.combined(with: .scale(scale: 0.985, anchor: .bottomLeading)),
          removal: .opacity
        )
      )
    case .user(_, let text, let origin):
      UserBubble(text, origin: origin)
        .transition(
          .asymmetric(
            insertion: .opacity.combined(with: .scale(scale: 0.985, anchor: .bottomTrailing)),
            removal: .opacity
          )
        )
    case .note(_, let text, let tintIndices):
      DeliveryNote(text, avatars: tintIndices.map(Theme.Palette.avatarTint))
    case .peerExchange(_, let exchange):
      PeerExchangeRow(exchange: exchange) { onOpenPeerExchange?(exchange.id) }
        .transition(.opacity)
    case .tool(_, let row):
      ToolCallRow(row)
        .transition(.opacity.combined(with: .move(edge: .bottom)))
    case .toolRun(_, let rows):
      ToolRunRow(rows)
        .transition(.opacity)
    }
  }
}
