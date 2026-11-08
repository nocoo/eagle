import Foundation
import SuperagentCore
import Testing

@testable import EagleFeatures

/// The Super Bot is its own service, but a person's model account is one account: first use
/// copies it, and nothing a person chose on this side is overwritten afterwards.
@Suite("Super agent model adoption")
struct SuperagentModelAdoptionTests {
  private var inherited: BotsGatewayCredential {
    BotsGatewayCredential(
      baseUrl: "http://127.0.0.1:3425", model: "group/eagle", thinkingLevel: "high",
      apiKey: "local-key")
  }

  @Test("a fresh service takes the whole account, key included")
  func fresh() {
    let change = SuperagentModelAdoption.change(current: nil, inherited: inherited)
    #expect(change?.baseUrl == "http://127.0.0.1:3425")
    #expect(change?.model == "group/eagle")
    #expect(change?.thinkingLevel == "high")
    #expect(change?.apiKey == "local-key")
  }

  @Test("a service with a model but no key only gains the key")
  func missingKey() {
    let current = ModelConfiguration(
      baseUrl: "http://127.0.0.1:3425", model: "group/eagle", thinkingLevel: "medium",
      hasApiKey: false)
    let change = SuperagentModelAdoption.change(current: current, inherited: inherited)
    #expect(change?.model == "group/eagle", "a chosen model is not replaced")
    #expect(change?.thinkingLevel == "medium", "a chosen level is not replaced")
    #expect(change?.apiKey == "local-key")
  }

  @Test("a configured service is left alone")
  func configured() {
    let current = ModelConfiguration(
      baseUrl: "http://127.0.0.1:3425", model: "group/other", thinkingLevel: "low",
      hasApiKey: true)
    #expect(SuperagentModelAdoption.change(current: current, inherited: inherited) == nil)
  }

  @Test("nothing is inherited when the Bot has no key to inherit")
  func noInheritableKey() {
    let keyless = BotsGatewayCredential(
      baseUrl: "http://127.0.0.1:3425", model: "group/eagle", thinkingLevel: "high", apiKey: "")
    #expect(SuperagentModelAdoption.change(current: nil, inherited: keyless) == nil)
  }

  @Test("the daemon's gateway file is read only when it is a private regular file")
  func readingTheGatewayFile() throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("gateway-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let file = root.appendingPathComponent("gateway.json")
    let body =
      #"{"provider":"magpie","baseUrl":"http://127.0.0.1:3425","model":"group/eagle","thinkingLevel":"high","apiKey":"local-key"}"#
    try Data(body.utf8).write(to: file)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    #expect(BotsGatewayCredential.read(root: root) == inherited)

    try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: file.path)
    #expect(BotsGatewayCredential.read(root: root) == nil, "a readable credential is refused")

    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    try Data(#"{"baseUrl":"http://127.0.0.1:3425","model":"m"}"#.utf8).write(to: file)
    #expect(BotsGatewayCredential.read(root: root) == nil, "no key means nothing to inherit")

    try FileManager.default.removeItem(at: file)
    try FileManager.default.createSymbolicLink(
      at: file, withDestinationURL: URL(fileURLWithPath: "/etc/hosts"))
    #expect(BotsGatewayCredential.read(root: root) == nil, "a link is not a credential")
  }
}
