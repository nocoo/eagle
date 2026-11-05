import SwiftUI

/// One tool invocation in the transcript: the call and, once it lands, its result. It is
/// a compact card that stays out of the answer's way, expands on click, and colors only
/// the failure state (docs/bots/PRODUCT.md, "Delegation").
public struct ToolRow: Hashable, Sendable, Identifiable {
  /// Stable across renders: the call's message and block, or the result's message.
  public var id: String
  public var name: String
  /// The one-line argument hint, for example `path=notes.txt`.
  public var subtitle: String
  /// Pretty-printed arguments; empty when the call carried none.
  public var input: String
  /// The result text, once the daemon appends the tool row.
  public var output: String?
  public var isError: Bool
  public var isRunning: Bool
  /// How long the tool took, when its result carried it.
  public var durationMs: Int?

  public init(
    id: String,
    name: String,
    subtitle: String,
    input: String = "",
    output: String? = nil,
    isError: Bool = false,
    isRunning: Bool = false,
    durationMs: Int? = nil
  ) {
    self.id = id
    self.name = name
    self.subtitle = subtitle
    self.input = input
    self.output = output
    self.isError = isError
    self.isRunning = isRunning
    self.durationMs = durationMs
  }

  /// A compact human duration, for example `21 ms` or `1.4 s`.
  public var durationLabel: String? {
    guard let durationMs else { return nil }
    if durationMs < 1_000 { return "\(durationMs) ms" }
    return String(format: "%.1f s", Double(durationMs) / 1_000)
  }
}

/// The tool row itself. Dense by default: one line, no vertical air, so a long tool run
/// reads as a list; the body opens only when asked for.
public struct ToolCallRow: View {
  private let row: ToolRow
  @State private var expanded = false
  @State private var hovering = false

  public init(_ row: ToolRow) {
    self.row = row
  }

  public var body: some View {
    HStack(alignment: .top, spacing: Theme.Layout.rowGap) {
      VStack(alignment: .leading, spacing: Theme.Layout.microGap) {
        header
        if expanded {
          detailBody(of: row)
            .padding(.top, Theme.Tool.rowVerticalInset)
        } else if let preview = preview {
          // The result is visible without a click: one dim line, the rest on expansion.
          Text(preview)
            .font(Theme.TypeScale.monoCaption)
            .foregroundStyle(
              row.isError ? Theme.Palette.destructive : Theme.Palette.textMuted
            )
            .lineLimit(1)
            .truncationMode(.tail)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
      }
      .padding(.horizontal, Theme.Layout.rowGap)
      .padding(.vertical, Theme.Tool.rowVerticalInset)
      .frame(maxWidth: contentWidth, alignment: .leading)
      .background(
        RoundedRectangle(cornerRadius: Theme.Tool.rowRadius, style: .continuous)
          .fill(hovering ? Theme.Palette.hover : Theme.Palette.clear)
      )
      .contentShape(Rectangle())
      .onTapGesture { withAnimation(Theme.Motion.selection) { expanded.toggle() } }
      .onHover { hovering = $0 }
      Spacer(minLength: Theme.Chat.assistantTrailingSpace)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("工具 \(row.name)")
  }

  private var contentWidth: CGFloat { Theme.Chat.contentWidth }

  private var preview: String? {
    guard let output = row.output else { return nil }
    let line = output.drop(while: { $0 == "\n" }).prefix(while: { $0 != "\n" })
    return line.isEmpty ? nil : String(line)
  }

  private var header: some View {
    HStack(spacing: Theme.Tool.detailGap) {
      Image(systemName: "wrench.and.screwdriver")
        .font(Theme.TypeScale.toolCaption)
        .foregroundStyle(
          row.isError ? Theme.Palette.destructive : Theme.Palette.textSecondary
        )
        .frame(width: Theme.Tool.glyphSlot)
      Text(row.name)
        .font(Theme.TypeScale.monoTitle)
        .foregroundStyle(Theme.Palette.textPrimary)
        .lineLimit(1)
      if !row.subtitle.isEmpty {
        Text(row.subtitle)
          .font(Theme.TypeScale.note)
          .foregroundStyle(Theme.Palette.textMuted)
          .lineLimit(1)
          .truncationMode(.middle)
      }
      Spacer(minLength: Theme.Layout.labelGap)
      if row.isRunning {
        SpinnerArc(size: Theme.Tool.spinnerSize, lineWidth: Theme.Tool.spinnerStroke)
      } else if row.isError {
        Text("失败")
          .font(Theme.TypeScale.note)
          .foregroundStyle(Theme.Palette.destructive)
      } else if let duration = row.durationLabel {
        Text(duration)
          .font(Theme.TypeScale.monoCaption)
          .foregroundStyle(Theme.Palette.textMuted)
      }
      Image(systemName: expanded ? "chevron.up" : "chevron.down")
        .font(Theme.TypeScale.Glyph.chevron)
        .foregroundStyle(Theme.Palette.textMuted)
    }
  }

  @ViewBuilder
  private func detailBody(of row: ToolRow) -> some View {
    VStack(alignment: .leading, spacing: Theme.Tool.detailGap) {
      if !row.input.isEmpty {
        label("参数")
        ScrollView(.vertical) {
          Text(row.input)
            .font(Theme.TypeScale.monoCaption)
            .foregroundStyle(Theme.Palette.textSecondary)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: Theme.Tool.inputMaxHeight)
      }
      if let output = row.output, !output.isEmpty {
        label(row.isError ? "错误" : "结果")
        ScrollView(.vertical) {
          Text(output)
            .font(Theme.TypeScale.monoCaption)
            .foregroundStyle(
              row.isError ? Theme.Palette.destructive : Theme.Palette.textSecondary
            )
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: Theme.Tool.outputMaxHeight)
      }
    }
  }

  private func label(_ text: String) -> some View {
    Text(text)
      .font(Theme.TypeScale.toolCaption)
      .foregroundStyle(Theme.Palette.textMuted)
  }
}

/// A run of several tool calls in one assistant turn. While one is executing the line says
/// what is running; once they all settle it collapses to a single summary line, and a click
/// opens the calls (arguments, output, timing, failures) in a sheet.
public struct ToolRunRow: View {
  private let rows: [ToolRow]
  @State private var showingDetails = false
  @State private var hovering = false

  public init(_ rows: [ToolRow]) {
    self.rows = rows
  }

  private var contentWidth: CGFloat { Theme.Chat.contentWidth }

  private var running: ToolRow? { rows.last { $0.isRunning } }
  private var failures: Int { rows.filter(\.isError).count }
  private var totalMs: Int { rows.compactMap(\.durationMs).reduce(0, +) }

  public var body: some View {
    HStack(spacing: 0) {
      Button {
        showingDetails = true
      } label: {
        HStack(spacing: Theme.Layout.rowGap) {
          Image(systemName: "wrench.and.screwdriver")
            .font(Theme.TypeScale.toolCaption)
            .foregroundStyle(failures > 0 ? Theme.Palette.destructive : Theme.Palette.textSecondary)
            .frame(width: Theme.Tool.glyphSlot)
          if let running {
            Text("正在执行 \(running.name)")
              .font(Theme.TypeScale.monoTitle)
              .foregroundStyle(Theme.Palette.textPrimary)
              .lineLimit(1)
            if !running.subtitle.isEmpty {
              Text(running.subtitle)
                .font(Theme.TypeScale.note)
                .foregroundStyle(Theme.Palette.textMuted)
                .lineLimit(1)
                .truncationMode(.middle)
            }
          } else {
            Text("\(rows.count) 个工具调用")
              .font(Theme.TypeScale.compactTitle)
              .foregroundStyle(Theme.Palette.textPrimary)
            if failures > 0 {
              Text("\(failures) 个失败")
                .font(Theme.TypeScale.note)
                .foregroundStyle(Theme.Palette.destructive)
            } else if totalMs > 0 {
              Text(totalLabel)
                .font(Theme.TypeScale.monoCaption)
                .foregroundStyle(Theme.Palette.textMuted)
            }
          }
          Spacer(minLength: Theme.Layout.labelGap)
          if running != nil {
            SpinnerArc(size: Theme.Tool.spinnerSize, lineWidth: Theme.Tool.spinnerStroke)
          }
          Image(systemName: "chevron.right")
            .font(Theme.TypeScale.Glyph.chevron)
            .foregroundStyle(Theme.Palette.textMuted)
        }
        .padding(.horizontal, Theme.Layout.rowGap)
        .padding(.vertical, Theme.Layout.labelGap)
        .frame(maxWidth: contentWidth, alignment: .leading)
        .background(
          RoundedRectangle(cornerRadius: Theme.Tool.rowRadius, style: .continuous)
            .fill(hovering ? Theme.Palette.hover : Theme.Palette.clear)
        )
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
      }
      .buttonStyle(.plain)
      Spacer(minLength: Theme.Chat.assistantTrailingSpace)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityLabel("工具调用 \(rows.count) 个")
    .sheet(isPresented: $showingDetails) {
      ToolRunDetailView(rows: rows)
    }
  }

  private var totalLabel: String {
    if totalMs < 1_000 { return "\(totalMs) ms" }
    return String(format: "%.1f s", Double(totalMs) / 1_000)
  }
}

/// The detail dialog for one tool run: every call with its arguments, output and status.
public struct ToolRunDetailView: View {
  private let rows: [ToolRow]
  @Environment(\.dismiss) private var dismiss

  public init(rows: [ToolRow]) {
    self.rows = rows
  }

  public var body: some View {
    VStack(spacing: 0) {
      HStack {
        Text("工具调用")
          .font(Theme.TypeScale.sectionTitle)
          .foregroundStyle(Theme.Palette.textPrimary)
        Text("\(rows.count)")
          .font(Theme.TypeScale.note)
          .foregroundStyle(Theme.Palette.textMuted)
        Spacer()
        Button("完成") { dismiss() }
          .buttonStyle(.plain)
          .font(Theme.TypeScale.note)
          .foregroundStyle(Theme.Palette.accent)
      }
      .padding(.horizontal, Theme.Layout.groupGap)
      .padding(.vertical, Theme.Tool.headerVerticalInset)
      Divider()
      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
            detail(row)
            if index < rows.count - 1 { Divider().padding(.vertical, Theme.Layout.detailGap) }
          }
        }
        .padding(Theme.Layout.groupGap)
      }
    }
    .frame(
      minWidth: Theme.Tool.dialogMinWidth, idealWidth: Theme.Tool.dialogWidth,
      minHeight: Theme.Tool.dialogMinHeight, idealHeight: Theme.Tool.dialogHeight
    )
    .background(Theme.Palette.surface)
  }

  @ViewBuilder
  private func detail(_ row: ToolRow) -> some View {
    VStack(alignment: .leading, spacing: Theme.Tool.detailGap) {
      HStack(spacing: Theme.Layout.rowGap) {
        Text(row.name)
          .font(Theme.TypeScale.toolDetailTitle)
          .foregroundStyle(Theme.Palette.textPrimary)
        if row.isRunning {
          SpinnerArc(size: Theme.Tool.detailSpinnerSize, lineWidth: Theme.Tool.detailSpinnerStroke)
        } else if row.isError {
          Text("失败")
            .font(Theme.TypeScale.note)
            .foregroundStyle(Theme.Palette.destructive)
        } else if let duration = row.durationLabel {
          Text(duration)
            .font(Theme.TypeScale.monoCaption)
            .foregroundStyle(Theme.Palette.textMuted)
        }
        Spacer()
      }
      if !row.subtitle.isEmpty {
        Text(row.subtitle)
          .font(Theme.TypeScale.note)
          .foregroundStyle(Theme.Palette.textMuted)
          .textSelection(.enabled)
      }
      if !row.input.isEmpty {
        sectionLabel("参数")
        ScrollView(.vertical) {
          Text(row.input)
            .font(Theme.TypeScale.monoCaption)
            .foregroundStyle(Theme.Palette.textSecondary)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: Theme.Tool.dialogInputMaxHeight)
      }
      if let output = row.output, !output.isEmpty {
        sectionLabel(row.isError ? "错误" : "结果")
        ScrollView(.vertical) {
          Text(output)
            .font(Theme.TypeScale.monoCaption)
            .foregroundStyle(row.isError ? Theme.Palette.destructive : Theme.Palette.textSecondary)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: Theme.Tool.dialogOutputMaxHeight)
      }
    }
    .padding(.vertical, Theme.Tool.rowVerticalInset)
  }

  private func sectionLabel(_ text: String) -> some View {
    Text(text)
      .font(Theme.TypeScale.toolCaption)
      .foregroundStyle(Theme.Palette.textMuted)
  }
}
