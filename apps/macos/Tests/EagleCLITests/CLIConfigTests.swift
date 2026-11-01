import Foundation
import Testing

@testable import EagleCLIKit

@Suite("CLI config")
struct CLIConfigTests {
  private func makeHome() throws -> URL {
    let home = FileManager.default.temporaryDirectory
      .appendingPathComponent("eagle-cli-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
    return home
  }

  private func writeDevToken(_ home: URL, _ text: String, mode: Int = 0o600) throws -> URL {
    let directory = home.appendingPathComponent(".config/eagle-dev", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let url = directory.appendingPathComponent("token")
    try Data(text.utf8).write(to: url)
    try FileManager.default.setAttributes([.posixPermissions: mode], ofItemAtPath: url.path)
    return url
  }

  private func writeConfig(_ home: URL, _ name: String, _ json: String) throws {
    let directory = home.appendingPathComponent(".config/eagle", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try Data(json.utf8).write(to: directory.appendingPathComponent(name))
  }

  @Test("the released binary and a development copy never share a file or a credential")
  func names() {
    #expect(CLIConfig.binaryName(for: "/Applications/Eagle.app/Contents/Helpers/eagle") == "eagle")
    #expect(CLIConfig.binaryName(for: "/x/y/eagle-dev") == "eagle-dev")
    #expect(
      CLIConfig.binaryName(for: "/x/y/EagleCLI") == "eagle-dev", "a swift run copy is a dev build")
    #expect(
      CLIConfig.configURL(binaryName: "eagle", home: "/Users/me").path
        == "/Users/me/.config/eagle/eagle.json")
  }

  @Test("the file is read, the environment wins, and defaults fill the rest")
  func resolution() throws {
    let home = FileManager.default.temporaryDirectory
      .appendingPathComponent("eagle-cli-\(UUID().uuidString)", isDirectory: true)
    let directory = home.appendingPathComponent(".config/eagle", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: home) }
    try Data(
      #"{"root":"/custom/root","port":"44000","token":"c_1.secret","client":"this Mac"}"#.utf8
    ).write(to: directory.appendingPathComponent("eagle-dev.json"))

    let file = CLIConfig.load(argv0: "/x/eagle-dev", environment: [:], home: home.path)
    #expect(file.root == "/custom/root")
    #expect(file.port == "44000")
    #expect(file.token == "c_1.secret")
    #expect(file.clientName == "this Mac")
    #expect(file.baseURL.absoluteString == "http://127.0.0.1:44000")

    let env = CLIConfig.load(
      argv0: "/x/eagle-dev",
      environment: ["EAGLE_TOKEN": "c_2.env", "EAGLE_PORT": "45000"],
      home: home.path)
    #expect(env.token == "c_2.env")
    #expect(env.port == "45000")
    #expect(env.root == "/custom/root", "an untouched field still comes from the file")

    let empty = CLIConfig.load(argv0: "/x/eagle", environment: [:], home: "/nonexistent-home")
    #expect(empty.token == nil, "a missing credential is never borrowed from the App")
    #expect(empty.root == "~/.local/share/eagle-bots")
    #expect(empty.port == "43117")
  }

  @Test("a development binary reads the development token, and the environment still wins")
  func developmentToken() throws {
    let home = try makeHome()
    defer { try? FileManager.default.removeItem(at: home) }
    let token = String(repeating: "d", count: 48)
    _ = try writeDevToken(home, token)

    let file = CLIConfig.load(argv0: "/x/eagle-dev", environment: [:], home: home.path)
    #expect(file.token == token)
    #expect(file.unsafeDevToken == nil)

    let env = CLIConfig.load(
      argv0: "/x/eagle-dev", environment: ["EAGLE_TOKEN": "c_env"], home: home.path)
    #expect(env.token == "c_env", "the environment wins over the development token")
  }

  @Test("the development token wins over the config file's token")
  func developmentTokenBeatsTheConfigFile() throws {
    let home = try makeHome()
    defer { try? FileManager.default.removeItem(at: home) }
    try writeConfig(home, "eagle-dev.json", #"{"token":"c_config"}"#)
    let token = String(repeating: "d", count: 48)
    _ = try writeDevToken(home, token)

    let file = CLIConfig.load(argv0: "/x/eagle-dev", environment: [:], home: home.path)
    #expect(file.token == token, "the development token wins over the config file's token")
  }

  @Test("an unsafe development token file is an explicit local error, never a fallback")
  func unsafeDevelopmentToken() throws {
    let home = try makeHome()
    defer { try? FileManager.default.removeItem(at: home) }
    try writeConfig(home, "eagle-dev.json", #"{"token":"c_config"}"#)
    let token = String(repeating: "d", count: 48)
    let loose = try writeDevToken(home, token, mode: 0o644)

    let file = CLIConfig.load(argv0: "/x/eagle-dev", environment: [:], home: home.path)
    #expect(file.token == nil, "an unsafe file never falls back to the config file's token")
    #expect(file.unsafeDevToken?.path == loose.path)
    #expect(file.unsafeDevToken?.reason.contains("0600") == true)

    let short = try writeDevToken(home, "too-short", mode: 0o600)
    let weak = CLIConfig.load(argv0: "/x/eagle-dev", environment: [:], home: home.path)
    #expect(weak.token == nil)
    #expect(weak.unsafeDevToken?.path == short.path)
    #expect(weak.unsafeDevToken?.reason.contains("32") == true)
  }

  @Test("a directory that cannot be inspected fails closed instead of looking absent")
  func unreadableDirectoryIsNotAbsent() throws {
    let home = try makeHome()
    let directory = home.appendingPathComponent(".config/eagle-dev", isDirectory: true)
    defer {
      try? FileManager.default.setAttributes(
        [.posixPermissions: 0o755], ofItemAtPath: directory.path)
      try? FileManager.default.removeItem(at: home)
    }
    _ = try writeDevToken(home, String(repeating: "d", count: 48))
    try writeConfig(home, "eagle-dev.json", #"{"token":"c_config"}"#)
    // The owner can still stat a 0000 directory, but cannot open anything inside it.
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o000], ofItemAtPath: directory.path)

    let file = CLIConfig.load(argv0: "/x/eagle-dev", environment: [:], home: home.path)
    #expect(
      file.token == nil,
      "a credential that cannot be inspected never falls back to the config file's token")
    #expect(file.unsafeDevToken != nil, "the refusal is explicit and names the path")
    #expect(file.unsafeDevToken?.reason.contains("cannot be opened") == true)
  }

  @Test("EAGLE_TOKEN wins over an unsafe development token file")
  func environmentBeatsTheUnsafeFile() throws {
    let home = try makeHome()
    defer { try? FileManager.default.removeItem(at: home) }
    let loose = try writeDevToken(home, String(repeating: "d", count: 48), mode: 0o644)
    #expect(FileManager.default.fileExists(atPath: loose.path))

    let file = CLIConfig.load(
      argv0: "/x/eagle-dev", environment: ["EAGLE_TOKEN": "c_env"], home: home.path)
    #expect(file.token == "c_env")
    #expect(file.unsafeDevToken == nil, "an explicit environment token needs no local file")
  }

  @Test("EAGLE_TOKEN does not even open the development file")
  func environmentSkipsTheFileEntirely() throws {
    let home = try makeHome()
    let directory = home.appendingPathComponent(".config/eagle-dev", isDirectory: true)
    defer {
      try? FileManager.default.setAttributes(
        [.posixPermissions: 0o755], ofItemAtPath: directory.path)
      try? FileManager.default.removeItem(at: home)
    }
    _ = try writeDevToken(home, String(repeating: "d", count: 48))
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o000], ofItemAtPath: directory.path)

    let file = CLIConfig.load(
      argv0: "/x/eagle-dev", environment: ["EAGLE_TOKEN": "c_env"], home: home.path)
    #expect(file.token == "c_env")
    #expect(
      file.unsafeDevToken == nil,
      "an inspection that never happened cannot report a file it did not open")
  }

  @Test("the released binary never reads the development directory")
  func releaseIgnoresTheDevelopmentToken() throws {
    let home = try makeHome()
    defer { try? FileManager.default.removeItem(at: home) }
    _ = try writeDevToken(home, String(repeating: "d", count: 48))
    try writeConfig(home, "eagle.json", #"{"token":"c_release"}"#)

    let file = CLIConfig.load(argv0: "/x/eagle", environment: [:], home: home.path)
    #expect(file.token == "c_release")
    #expect(file.unsafeDevToken == nil)
    #expect(file.configPath.hasSuffix(".config/eagle/eagle.json"))
  }

  @Test("HOME decides where the development token is looked for")
  func homeComesFromTheEnvironment() throws {
    let home = try makeHome()
    defer { try? FileManager.default.removeItem(at: home) }
    let token = String(repeating: "d", count: 48)
    _ = try writeDevToken(home, token)

    let file = CLIConfig.load(argv0: "/x/eagle-dev", environment: ["HOME": home.path])
    #expect(file.token == token)
  }
}

@Suite("CLI arguments")
struct ArgumentsTests {
  @Test("values, switches and equals forms parse")
  func parse() throws {
    let arguments = try Arguments.parse(
      ["b_1", "--title=T", "--label", "研究", "--json"],
      valueFlags: ["title", "label"], switchFlags: ["json"])
    #expect(arguments.positionals == ["b_1"])
    #expect(arguments.value("title") == "T")
    #expect(arguments.value("label") == "研究")
    #expect(arguments.switches.contains("json"))
  }

  @Test("an unknown option or a missing value is a usage error")
  func parseRefusals() {
    #expect(throws: CLIError.self) {
      try Arguments.parse(["--nope"], valueFlags: [], switchFlags: [])
    }
    #expect(throws: CLIError.self) {
      try Arguments.parse(["--title"], valueFlags: ["title"], switchFlags: [])
    }
    #expect(throws: CLIError.self) {
      try Arguments.parse(["--json=1"], valueFlags: [], switchFlags: ["json"])
    }
  }
}
