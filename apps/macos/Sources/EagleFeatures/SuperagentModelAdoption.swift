import Foundation
import SuperagentCore

/// What a first use — or the notice's own action — copies from the Bot's gateway. It is a pure
/// decision so the rules can be tested without a socket: inherit only what the Super Bot lacks,
/// and never replace a model, a level or a key a person already chose here.
enum SuperagentModelAdoption {
  static func change(
    current: ModelConfiguration?, inherited: BotsGatewayCredential
  ) -> ConfigurationChange? {
    let missing = current?.baseUrl.trimmingCharacters(in: .whitespaces).isEmpty ?? true
    // Inheriting an empty key would clear a working one, and a service without any key cannot
    // answer anyway: without something to inherit there is no change to make.
    let key = inherited.apiKey.trimmingCharacters(in: .whitespaces)
    let needsKey = !(current?.hasApiKey ?? false)
    guard missing || needsKey, !needsKey || !key.isEmpty else { return nil }
    return ConfigurationChange(
      baseUrl: missing ? inherited.baseUrl : (current?.baseUrl ?? inherited.baseUrl),
      model: missing ? inherited.model : (current?.model ?? inherited.model),
      thinkingLevel: missing
        ? inherited.thinkingLevel : (current?.thinkingLevel ?? inherited.thinkingLevel),
      apiKey: needsKey ? key : nil)
  }
}
