import EagleDesign
import Foundation
import SwiftUI

/// The live computer list: the shared device model, drawn as the inspector's compact rows.
public struct DeviceInspectorView: View {
  @ObservedObject private var model: DeviceSettingsViewModel
  @StateObject private var herdr: HerdrTeamsViewModel
  private let onManage: () -> Void

  public init(
    model: DeviceSettingsViewModel = .shared, herdr: HerdrTeamsViewModel? = nil,
    onManage: @escaping () -> Void
  ) {
    self.model = model
    _herdr = StateObject(wrappedValue: herdr ?? HerdrTeamsViewModel())
    self.onManage = onManage
  }

  public var body: some View {
    DeviceInspectorList(
      entries: entries,
      enabled: model.enabled,
      stale: model.directoryIsStale,
      localContent: AnyView(HerdrTeamsView(model: herdr)),
      onManage: onManage
    )
    .task { await model.observe() }
    .task { await herdr.observe() }
  }

  private var entries: [DeviceInspectorEntry] {
    var result = (model.directory?.devices ?? []).map { device in
      DeviceInspectorEntry(
        id: device.deviceId, name: device.name,
        isLocal: device.deviceId == model.directory?.localDeviceId,
        online: device.online, policy: model.policy(for: device)?.mode.title ?? "策略未知")
    }
    // Local Herdr remains readable before the independent device service is ready.
    if !result.contains(where: \.isLocal) {
      result.insert(
        DeviceInspectorEntry(
          id: "local-placeholder",
          name: Host.current().localizedName ?? ProcessInfo.processInfo.hostName,
          isLocal: true, online: nil, policy: model.policy?.mode.title ?? "策略未知"), at: 0)
    }
    return result
  }
}
