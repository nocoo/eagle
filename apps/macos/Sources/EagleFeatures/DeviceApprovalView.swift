import EagleDesign
import EagleDevices
import SwiftUI

/// Presented by the App's single confirmation window, independent of workspace lifetime.
public struct DeviceApprovalView: View {
  @ObservedObject private var model: DeviceSettingsViewModel
  @State private var displayedRequestId: String?
  @AppStorage("eagle.appearance") private var appearance = "system"

  public init(model: DeviceSettingsViewModel = .shared) {
    self.model = model
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: Theme.Layout.sectionInset) {
      if let request = model.pendingApproval {
        let summary = DeviceApprovalPresentation(operation: request.operation)
        Text("允许这次\(summary.title)？")
          .font(Theme.TypeScale.dialogTitle)
          .foregroundStyle(Theme.Palette.textPrimary)
        Text("仅允许下面这一次操作。关闭或超时会拒绝。")
          .font(Theme.TypeScale.note)
          .foregroundStyle(Theme.Palette.textSecondary)
        ScrollView {
          VStack(alignment: .leading, spacing: Theme.Layout.sectionInset) {
            HStack(alignment: .top, spacing: Theme.Layout.sectionInset) {
              field("发起设备", deviceName(request.sourceDeviceId), monospaced: false)
              Image(systemName: "arrow.right").foregroundStyle(Theme.Palette.textMuted)
                .padding(.top, Theme.Metric.contentInset)
              field("执行设备", deviceName(request.targetDeviceId), monospaced: false)
            }
            Divider().overlay(Theme.Palette.line)
            ForEach(summary.fields, id: \.title) { item in
              field(item.title, item.value)
            }
            field(
              "有效至", Date(timeIntervalSince1970: Double(request.expiresAt) / 1000).formatted(),
              monospaced: false)
            DisclosureGroup("技术详情") {
              VStack(alignment: .leading, spacing: Theme.Layout.sectionGap) {
                field("发起设备 ID", request.sourceDeviceId)
                field("执行设备 ID", request.targetDeviceId)
                field("操作 ID", request.operationId)
                field("原请求 ID", request.requestId)
                field("策略版本", String(request.policyVersion))
                field("参数摘要 SHA-256", request.digest)
                field("完整操作 JSON", DeviceApprovalPresentation.json(request.operation))
              }
              .padding(.top, Theme.Layout.sectionGap)
            }
            .font(Theme.TypeScale.note)
            .foregroundStyle(Theme.Palette.textSecondary)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: Theme.Dialog.approvalContentHeight)
        TimelineView(.periodic(from: .now, by: 1)) { context in
          let expired = Int64(context.date.timeIntervalSince1970 * 1000) >= request.expiresAt
          HStack {
            if expired {
              Text("确认已过期")
                .font(Theme.TypeScale.note)
                .foregroundStyle(Theme.Palette.destructive)
            }
            Spacer(minLength: 0)
            ActionControl("拒绝", role: .cancel, style: .automatic) {
              model.respondToApproval(false, requestId: request.id)
            }
            .keyboardShortcut(.cancelAction)
            SettingsActionButton("允许此次操作", prominent: true) {
              model.respondToApproval(true, requestId: request.id)
            }
            .disabled(expired)
          }
        }
      } else {
        Text("没有待确认的设备操作")
          .foregroundStyle(Theme.Palette.textSecondary)
      }
    }
    .padding(Theme.Layout.pageInset)
    .frame(
      minWidth: Theme.Dialog.approvalMinWidth, idealWidth: Theme.Dialog.approvalWidth,
      maxWidth: Theme.Dialog.approvalMaxWidth, minHeight: Theme.Dialog.approvalMinHeight
    )
    .background(Theme.Palette.surface)
    .preferredColorScheme(appearance == "light" ? .light : appearance == "dark" ? .dark : nil)
    .onAppear { displayedRequestId = model.pendingApproval?.id }
    .onDisappear {
      if let displayedRequestId { model.respondToApproval(false, requestId: displayedRequestId) }
    }
  }

  private func deviceName(_ id: String) -> String {
    model.directory?.devices.first { $0.deviceId == id }?.name ?? "未识别设备（可在技术详情核对）"
  }

  private func field(_ title: String, _ value: String, monospaced: Bool = true) -> some View {
    VStack(alignment: .leading, spacing: Theme.Layout.detailGap) {
      Text(title).font(Theme.TypeScale.note).foregroundStyle(Theme.Palette.textSecondary)
      Text(value)
        .font(monospaced ? Theme.TypeScale.mono : Theme.TypeScale.note)
        .foregroundStyle(Theme.Palette.textPrimary)
        .textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// Human-readable fields never truncate an operation parameter. Protocol metadata is separate.
struct DeviceApprovalPresentation {
  struct Field {
    let title: String
    let value: String
  }
  let title: String
  let fields: [Field]

  init(operation: DeviceJSON) {
    let titles = [
      "command": "执行命令", "file.read": "读取文件", "file.write": "写入文件", "file.list": "列出目录",
      "native": "执行本机工具",
    ]
    title = titles[operation["kind"]?.string ?? ""] ?? "执行设备操作"
    guard case .object(let values) = operation else {
      fields = [Field(title: "完整操作", value: Self.json(operation))]
      return
    }
    let order = ["command", "path", "tool", "args", "content", "cwd", "timeoutMs"]
    let labels = [
      "command": "命令", "path": "路径", "tool": "工具", "args": "完整工具参数", "content": "写入内容",
      "cwd": "工作目录", "timeoutMs": "超时时间",
    ]
    let keys =
      order.filter { values[$0] != nil }
      + values.keys.filter { !order.contains($0) && $0 != "kind" }.sorted()
    fields = keys.map { key in
      let value = values[key] ?? .null
      let text: String
      if key == "timeoutMs", let milliseconds = value.number, milliseconds >= 1000 {
        text = (milliseconds / 1000).formatted(.number.precision(.fractionLength(0...3))) + " 秒"
      } else if key == "timeoutMs" {
        text = "\(Self.json(value)) 毫秒"
      } else {
        text = value.string ?? Self.json(value)
      }
      return Field(title: labels[key] ?? key, value: text)
    }
  }

  static func json(_ value: DeviceJSON) -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    guard let data = try? encoder.encode(value), let text = String(data: data, encoding: .utf8)
    else {
      return "无法读取操作，请拒绝并重新发起。"
    }
    return text
  }
}
