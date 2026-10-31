import BotsCore
import BotsFeatures
import EagleDesign
import SwiftUI

/// History choices feed the same conversation and composer that the window already owns.
struct BotsHistoryInspector: View {
  @ObservedObject var model: AppViewModel
  @State private var left = ""
  @State private var right = ""
  @State private var origins: [ReplicaOrigin: String] = [:]
  @State private var resources: [String: String] = [:]
  @State private var previewParents: [String] = []
  @State private var changing = false

  private var ready: [ReplicaHead] { model.heads.filter(\.ready) }
  private func label(_ head: String) -> String {
    guard let item = model.heads.first(where: { $0.head == head }) else {
      return "历史 \(head.prefix(8))"
    }
    return "上下文 \(item.source.conversationId) · \(item.head.prefix(8))"
  }

  var body: some View {
    VStack(alignment: .leading, spacing: Theme.Metric.panelSectionGap) {
      VStack(alignment: .leading, spacing: Theme.Metric.panelSectionBodyGap) {
        PanelSectionHeader(symbolName: "clock.arrow.circlepath", title: "历史与上下文")
        Text(model.selectedHead.map(label) ?? "默认对话")
          .font(Theme.TypeScale.activity)
          .foregroundStyle(Theme.Palette.textPrimary)
        Menu("继续某份历史") {
          Button("默认对话") { model.selectRootContext() }
          ForEach(ready) { item in
            Button(label(item.head)) { perform { await model.selectHead(item.head) } }
              .help(
                "原始来源 \(item.source.replicaId) / \(item.source.botId) / \(item.source.conversationId)\n\(item.head)"
              )
          }
        }
        .disabled(changing || ready.isEmpty)
        Button(model.historyLoading ? "正在读取…" : (model.headsHaveMore ? "加载更多历史" : "刷新历史")) {
          perform { await model.loadHeads() }
        }
        .disabled(changing || model.historyLoading)
        if ready.isEmpty, !model.historyLoading {
          Text("还没有可继续的完整历史。")
            .font(Theme.TypeScale.pill).foregroundStyle(Theme.Palette.textSecondary)
        }
      }

      VStack(alignment: .leading, spacing: Theme.Metric.panelSectionBodyGap) {
        PanelSectionHeader(symbolName: "doc.on.doc", title: "本次资源")
        Menu("选择资源版本") {
          Button("随当前上下文") { perform { await model.selectResourceHead(nil) } }
          ForEach(ready.filter { $0.resourceHead != nil }) { item in
            Button(label(item.head)) { perform { await model.selectResourceHead(item.head) } }
          }
        }
        .disabled(changing)
        ForEach(model.headDetail?.resourceFiles ?? []) { file in
          VStack(alignment: .leading, spacing: 3) {
            Text(file.name ?? "资源尚未就绪").font(Theme.TypeScale.activity)
            if let sha = file.sha256 {
              Text("版本 \(sha.prefix(8))").font(Theme.TypeScale.pill)
                .foregroundStyle(Theme.Palette.textSecondary).help(sha)
            }
          }
        }
      }

      VStack(alignment: .leading, spacing: Theme.Metric.panelSectionBodyGap) {
        PanelSectionHeader(symbolName: "arrow.triangle.merge", title: "合并两份历史")
        parentMenu("第一份", selected: $left)
        parentMenu("第二份", selected: $right)
        Button("查看合并选择") {
          origins = [:]
          resources = [:]
          previewParents = [left, right]
          perform { await model.prepareMerge(heads: [left, right]) }
        }
        .disabled(changing || left.isEmpty || right.isEmpty || left == right)
        if previewParents == [left, right], let preview = model.mergePreview {
          ForEach(preview.conflicts) { conflict in
            Menu {
              ForEach(conflict.options) { option in
                Button(
                  "\(label(option.head)) · \(action(option.action)) · \(option.messageCount) 条"
                ) { origins[conflict.origin] = option.head }
              }
            } label: {
              Text(origins[conflict.origin].map(label) ?? "选择冲突记录 \(conflict.origin.entryId)")
            }
            .help(
              "原始来源 \(conflict.origin.replicaId) / \(conflict.origin.conversationId) / \(conflict.origin.entryId)"
            )
          }
          ForEach(preview.resources) { file in
            if file.versions.count > 1 {
              Menu {
                ForEach(file.versions) { version in
                  Button(
                    "\(version.heads.map(label).joined(separator: " / ")) · \(version.sha256.prefix(8))"
                  ) { resources[file.name] = version.sha256 }
                }
              } label: {
                Text(
                  "\(file.name) · \(resources[file.name].map { String($0.prefix(8)) } ?? "选择版本")")
              }
            } else {
              Text("\(file.name) · \(file.versions.first?.sha256.prefix(8) ?? "")")
                .font(Theme.TypeScale.pill).foregroundStyle(Theme.Palette.textSecondary)
            }
          }
          Button("合并并继续") {
            let choices = origins.map { ReplicaMergeChoice(origin: $0.key, head: $0.value) }
            let versions = resources.map { ReplicaResourceChoice(name: $0.key, sha256: $0.value) }
            perform { await model.merge(choices: choices, resources: versions) }
          }
          .disabled(
            changing || !preview.conflicts.allSatisfy { origins[$0.origin] != nil }
              || !preview.resources.allSatisfy {
                $0.versions.count < 2 || resources[$0.name] != nil
              })
        }
      }

      if let bot = model.selection {
        let pending = model.pendingOutbox(for: bot)
        if !pending.isEmpty {
          VStack(alignment: .leading, spacing: Theme.Metric.panelSectionBodyGap) {
            PanelSectionHeader(symbolName: "tray", title: "待发送")
            ForEach(pending) { entry in
              VStack(alignment: .leading, spacing: 3) {
                Text(entry.text).lineLimit(2).font(Theme.TypeScale.activity)
                Text(
                  "\(entry.contextId.map { "上下文 \($0.suffix(8))" } ?? "默认对话") · \(entry.resourceHead.map { "资源 \($0.prefix(8))" } ?? "原上下文资源")"
                )
                .font(Theme.TypeScale.pill).foregroundStyle(Theme.Palette.textSecondary)
              }
              .help(entry.requestId)
            }
          }
        }
      }
      if let error = model.historyError {
        Text(error).font(Theme.TypeScale.activity).foregroundStyle(Theme.Palette.textPrimary)
          .textSelection(.enabled)
      }
    }
    .disabled(changing)
    .task(id: model.selection) { await model.loadHeads() }
    .onChange(of: model.selection) { _ in
      left = ""
      right = ""
      previewParents = []
      origins = [:]
      resources = [:]
    }
  }

  private func parentMenu(_ title: String, selected: Binding<String>) -> some View {
    Menu(
      selected.wrappedValue.isEmpty ? "选择\(title)历史" : "\(title) · \(label(selected.wrappedValue))"
    ) {
      ForEach(ready) { item in
        Button(label(item.head)) { selected.wrappedValue = item.head }
      }
    }
  }

  private func action(_ value: String) -> String {
    switch value {
    case "omit": "省略"
    case "replace": "替换"
    case "inactive": "不生效"
    default: "保留"
    }
  }

  private func perform(_ operation: @escaping @MainActor () async -> Void) {
    changing = true
    Task {
      await operation()
      changing = false
    }
  }
}
