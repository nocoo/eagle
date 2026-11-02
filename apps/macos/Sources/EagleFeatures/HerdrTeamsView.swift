import EagleDesign
import SwiftUI

/// A collapsed Herdr summary under the local Mac, with membership on expansion.
public struct HerdrTeamsView: View {
  @ObservedObject private var model: HerdrTeamsViewModel

  public init(model: HerdrTeamsViewModel) {
    self.model = model
  }

  public var body: some View {
    DisclosureGroup(isExpanded: $model.isExpanded) {
      details
    } label: {
      HStack(spacing: Theme.Metric.panelSectionRowGap) {
        Image(systemName: "person.2")
          .font(.system(size: Theme.Metric.panelSectionGlyph, weight: .semibold))
          .frame(width: Theme.Metric.panelSectionGlyphWidth)
        Text("Herdr").font(Theme.TypeScale.note)
        Spacer(minLength: 0)
        Text(countLabel).font(Theme.TypeScale.pill).monospacedDigit()
        if let error = model.error {
          Image(systemName: "exclamationmark.circle")
            .font(.system(size: 11)).foregroundStyle(Theme.Palette.warning)
            .accessibilityLabel("读取失败").help(error.message)
        } else if !model.isStale && runningTeams > 0 {
          Circle().fill(Theme.Palette.info).frame(width: 6, height: 6)
            .accessibilityLabel("\(runningTeams) 个团队运行中")
            .help("\(runningTeams) 个团队运行中")
        }
      }
      .foregroundStyle(Theme.Palette.textSecondary)
    }
    .disclosureGroupStyle(HerdrDisclosureStyle())
  }

  private var countLabel: String {
    if let snapshot = model.snapshot { return "\(snapshot.teams.count) 个团队" }
    return model.error == nil ? "读取中" : "不可用"
  }

  private var runningTeams: Int {
    model.snapshot?.teams.filter { team in
      team.members.contains { $0.status == .working }
    }.count ?? 0
  }

  private var details: some View {
    VStack(alignment: .leading, spacing: Theme.Metric.panelSectionBodyGap) {
      if let error = model.error {
        Text(error.message)
          .font(Theme.TypeScale.note)
          .foregroundStyle(Theme.Palette.warning)
          .fixedSize(horizontal: false, vertical: true)
      }

      if let snapshot = model.snapshot {
        if snapshot.teams.isEmpty {
          Text(snapshot.sessionCount == 0 ? "Herdr 尚未运行" : "暂无 agent 团队")
            .font(Theme.TypeScale.note)
            .foregroundStyle(Theme.Palette.textSecondary)
            .padding(.vertical, Theme.Metric.panelEmptyVertical)
        } else {
          ForEach(Array(snapshot.teams.enumerated()), id: \.element.id) { index, team in
            if index > 0 { Divider().overlay(Theme.Palette.line) }
            teamRows(team)
          }
        }
      } else if model.error == nil {
        Text("正在读取本机团队…")
          .font(Theme.TypeScale.note)
          .foregroundStyle(Theme.Palette.textSecondary)
      }

      HStack(spacing: 4) {
        if let updatedAt = model.updatedAt {
          Text(model.isStale ? "上次读取" : "更新于")
          Text(updatedAt, style: .time)
          if model.isStale { Text("· 状态未确认") }
        }
        Spacer(minLength: 0)
        IconButton(
          systemName: "arrow.clockwise", label: "刷新本机 Herdr 团队",
          size: Theme.Metric.hitTarget, glyphSize: 12, tint: Theme.Palette.textSecondary
        ) { Task { await model.refresh() } }
        .accessibilityIdentifier("herdr.refresh")
      }
      .font(Theme.TypeScale.pill)
      .foregroundStyle(Theme.Palette.textSecondary)
      .accessibilityIdentifier("herdr.freshness")
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func teamRows(_ team: HerdrTeam) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      VStack(alignment: .leading, spacing: 4) {
        Text(team.name)
          .font(Theme.TypeScale.cardTitle)
          .foregroundStyle(Theme.Palette.textPrimary)
          .lineLimit(2)
          .help(team.name)
        Text(summary(team))
          .font(Theme.TypeScale.pill)
          .foregroundStyle(Theme.Palette.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      .padding(.vertical, 10)
      ForEach(team.members) { member in
        HStack(alignment: .top, spacing: 8) {
          VStack(alignment: .leading, spacing: 4) {
            Text(member.name)
              .font(Theme.TypeScale.note)
              .foregroundStyle(Theme.Palette.textPrimary)
              .lineLimit(1)
              .truncationMode(.middle)
              .help(member.name)
            Text(member.kind + (member.directory.map { " · \($0)" } ?? ""))
              .font(Theme.TypeScale.pill)
              .foregroundStyle(Theme.Palette.textSecondary)
              .lineLimit(1)
              .truncationMode(.middle)
              .help(member.directory ?? "工作目录未知")
          }
          Spacer(minLength: 0)
          Text(model.isStale ? "未确认" : member.status.title)
            .font(Theme.TypeScale.pill)
            .foregroundStyle(statusTint(member.status))
            .fixedSize()
        }
        .padding(.vertical, 8)
        .padding(.leading, Theme.Metric.panelTaskIndent)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("herdr.member.\(team.id).\(member.id)")
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func summary(_ team: HerdrTeam) -> String {
    var parts = [team.session, "\(team.members.count) 成员"]
    if !model.isStale {
      let working = team.members.filter { $0.status == .working }.count
      let blocked = team.members.filter { $0.status == .blocked }.count
      if working > 0 { parts.append("\(working) 运行中") }
      if blocked > 0 { parts.append("\(blocked) 待确认") }
    }
    return parts.joined(separator: " · ")
  }

  private func statusTint(_ status: HerdrAgentStatus) -> Color {
    if model.isStale { return Theme.Palette.textSecondary }
    switch status {
    case .working: return Theme.Palette.info
    case .blocked: return Theme.Palette.warning
    default: return Theme.Palette.textSecondary
    }
  }
}

private struct HerdrDisclosureStyle: DisclosureGroupStyle {
  func makeBody(configuration: Configuration) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      Button {
        configuration.isExpanded.toggle()
      } label: {
        HStack(spacing: 6) {
          Image(systemName: configuration.isExpanded ? "chevron.down" : "chevron.right")
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(Theme.Palette.textSecondary)
            .frame(width: 10)
            .accessibilityHidden(true)
          configuration.label
        }
        .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityValue(configuration.isExpanded ? "已展开" : "已折叠")
      .accessibilityIdentifier("herdr.disclosure")
      if configuration.isExpanded {
        configuration.content.padding(.leading, Theme.Metric.panelTaskIndent)
      }
    }
  }
}
