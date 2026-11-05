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
          .font(Theme.TypeScale.Glyph.section)
          .frame(width: Theme.Metric.panelSectionGlyphWidth)
        Text("Herdr")
          .font(Theme.TypeScale.sectionLabel.weight(.semibold))
          .foregroundStyle(Theme.Palette.textPrimary)
        Spacer(minLength: 0)
        Text(countLabel).font(Theme.TypeScale.pill).monospacedDigit()
        if let error = model.error {
          Image(systemName: "exclamationmark.circle")
            .font(Theme.TypeScale.Glyph.notice).foregroundStyle(Theme.Palette.warning)
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
          Text(snapshot.sessionCount == 0 ? "Herdr 尚未运行" : "暂无团队")
            .font(Theme.TypeScale.note)
            .foregroundStyle(Theme.Palette.textSecondary)
            .padding(.vertical, Theme.Metric.panelEmptyVertical)
        } else {
          ForEach(Array(model.visibleTeams.enumerated()), id: \.element.id) { index, team in
            if index > 0 { Divider().overlay(Theme.Palette.line) }
            teamRows(team)
          }
          if model.additionalTeamCount > 0 {
            Button {
              model.showsAllTeams.toggle()
            } label: {
              HStack {
                Text(model.showsAllTeams ? "收起团队" : "查看更多团队（\(model.additionalTeamCount)）")
                Spacer(minLength: 0)
                Image(systemName: model.showsAllTeams ? "chevron.up" : "chevron.down")
                  .accessibilityHidden(true)
              }
              .font(Theme.TypeScale.pill)
              .foregroundStyle(Theme.Palette.accent)
              .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)
              .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("herdr.more-teams")
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
    let expanded = model.expandedTeamIDs.contains(team.id)
    return VStack(alignment: .leading, spacing: 0) {
      if team.members.isEmpty {
        teamHeader(team, expanded: false)
          .accessibilityElement(children: .combine)
          .accessibilityIdentifier("herdr.team.\(team.id)")
      } else {
        Button {
          if expanded {
            model.expandedTeamIDs.remove(team.id)
          } else {
            model.expandedTeamIDs.insert(team.id)
          }
        } label: {
          teamHeader(team, expanded: expanded)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(team.name)，\(summary(team))")
        .accessibilityValue(expanded ? "已展开" : "已折叠")
        .accessibilityIdentifier("herdr.team.\(team.id)")
        .help(summary(team))
      }
      if expanded {
        ForEach(team.members) { member in
          HStack(alignment: .top, spacing: 8) {
            Image(systemName: "terminal")
              .font(Theme.TypeScale.pill)
              .frame(width: Theme.Metric.panelSectionGlyphWidth)
              .foregroundStyle(Theme.Palette.textSecondary)
              .padding(.top, 2)
              .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
              HStack(spacing: 8) {
                Text(member.name)
                  .font(Theme.TypeScale.note)
                  .foregroundStyle(Theme.Palette.textPrimary)
                  .lineLimit(1)
                  .truncationMode(.middle)
                  .help(member.name)
                Spacer(minLength: 0)
                Text(model.isStale ? "未确认" : member.status.title)
                  .font(Theme.TypeScale.pill)
                  .foregroundStyle(statusTint(member.status))
                  .fixedSize()
              }
              Text(member.detail)
                .font(Theme.TypeScale.pill)
                .foregroundStyle(Theme.Palette.textSecondary)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
                .help(member.configurationHelp)
            }
          }
          .padding(.vertical, 8)
          .padding(.leading, Theme.Metric.panelTaskIndent / 2)
          .accessibilityElement(children: .combine)
          .accessibilityIdentifier("herdr.member.\(team.id).\(member.id)")
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func teamHeader(_ team: HerdrTeam, expanded: Bool) -> some View {
    HStack(spacing: 8) {
      Image(systemName: "person.2")
        .frame(width: Theme.Metric.panelSectionGlyphWidth)
        .foregroundStyle(Theme.Palette.textSecondary)
        .accessibilityHidden(true)
      Text(team.name).lineLimit(2).help(team.name)
      Spacer(minLength: 0)
      if !model.isStale && team.members.contains(where: { $0.status == .working }) {
        Circle().fill(Theme.Palette.info).frame(width: 6, height: 6)
          .accessibilityLabel("运行中")
      }
      Text("\(team.members.count) 成员")
        .font(Theme.TypeScale.pill)
        .foregroundStyle(Theme.Palette.textSecondary)
        .fixedSize()
      if !team.members.isEmpty {
        Image(systemName: expanded ? "chevron.down" : "chevron.right")
          .font(Theme.TypeScale.Glyph.chevron)
          .frame(width: 10)
          .foregroundStyle(Theme.Palette.textSecondary)
          .accessibilityHidden(true)
      } else {
        Theme.Palette.clear.frame(width: 10, height: 10).accessibilityHidden(true)
      }
    }
    .font(Theme.TypeScale.note)
    .foregroundStyle(Theme.Palette.textPrimary)
    .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
    .contentShape(Rectangle())
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
            .font(Theme.TypeScale.Glyph.chevron)
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
        configuration.content
          .padding(.leading, Theme.Metric.panelTaskIndent + Theme.Metric.panelSectionRowGap)
      }
    }
  }
}
