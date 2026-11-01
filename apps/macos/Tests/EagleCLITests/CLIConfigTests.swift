import Foundation
import Testing

@testable import EagleCLIKit

@Suite("CLI config")
struct CLIConfigTests {
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
