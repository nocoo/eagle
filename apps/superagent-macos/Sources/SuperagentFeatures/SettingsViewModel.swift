import Combine
import Foundation
import SuperagentCore

@MainActor
public final class SuperagentSettingsViewModel: ObservableObject {
  @Published public var baseUrl = ""
  @Published public var model = ""
  @Published public var thinkingLevel = "medium"
  @Published public private(set) var hasApiKey = false
  @Published public var apiKey = ""
  @Published public private(set) var loading = false
  @Published public private(set) var saving = false
  @Published public private(set) var notice: String?
  @Published public private(set) var failure: String?
  private let port: SuperagentServicePort

  public init(port: SuperagentServicePort) { self.port = port }

  public func load() async {
    loading = true
    defer { loading = false }
    do {
      let snapshot = try await port.state()
      apply(snapshot.value.configuration)
    } catch { failure = message(error) }
  }

  public func save() async {
    saving = true
    defer { saving = false }
    failure = nil
    notice = nil
    let change = ConfigurationChange(
      baseUrl: baseUrl.trimmingCharacters(in: .whitespacesAndNewlines),
      model: model.trimmingCharacters(in: .whitespacesAndNewlines),
      thinkingLevel: thinkingLevel,
      apiKey: apiKey.isEmpty ? nil : apiKey)
    do {
      let saved = try await port.configure(change)
      apply(saved)
      apiKey = ""
      notice = "已保存"
    } catch { failure = message(error) }
  }

  /// Writes the pair a per-Super-Bot model row changes, leaving the stored key alone: the
  /// key belongs to the service, the model and level belong to this conversation.
  public func apply(model: String, thinkingLevel: String) async {
    await apply(baseUrl: baseUrl, model: model, thinkingLevel: thinkingLevel)
  }

  /// First use: adopt the Bot model settings, so a fresh Super Bot starts configured.
  public func apply(baseUrl: String, model: String, thinkingLevel: String) async {
    guard !baseUrl.isEmpty, !model.isEmpty else { return }
    self.baseUrl = baseUrl
    self.model = model
    self.thinkingLevel = thinkingLevel
    saving = true
    defer { saving = false }
    failure = nil
    notice = nil
    do {
      let saved = try await port.configure(
        ConfigurationChange(
          baseUrl: baseUrl, model: model, thinkingLevel: thinkingLevel, apiKey: nil))
      apply(saved)
    } catch { failure = message(error) }
  }

  public func close() async { await port.close() }

  public func clearKey() async {
    saving = true
    defer { saving = false }
    failure = nil
    notice = nil
    do {
      let saved = try await port.configure(
        ConfigurationChange(
          baseUrl: baseUrl, model: model, thinkingLevel: thinkingLevel, apiKey: ""))
      apply(saved)
      notice = "已清除密钥"
    } catch { failure = message(error) }
  }

  private func apply(_ value: ModelConfiguration?) {
    guard let value else {
      hasApiKey = false
      return
    }
    baseUrl = value.baseUrl
    model = value.model
    thinkingLevel = value.thinkingLevel
    hasApiKey = value.hasApiKey
  }
  private func message(_ error: Error) -> String {
    (error as? SuperagentError)?.errorDescription ?? "Super Bot 服务不可用。"
  }
}
