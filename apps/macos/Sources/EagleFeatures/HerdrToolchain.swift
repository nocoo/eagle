import Foundation

/// The two command-line tools the Herdr page reports on. `hc` is herdr-core, the one a Bot
/// drives; `herdr` is the terminal multiplexer a person uses, which the App only reads.
public enum HerdrTool: String, CaseIterable, Identifiable, Sendable {
  case hc
  case herdr

  public var id: String { rawValue }

  /// What the page calls it, and the command both detection and installation use.
  public var command: String { rawValue }

  public var title: String {
    switch self {
    case .hc: return "hc · herdr-core"
    case .herdr: return "herdr"
    }
  }

  public var summary: String {
    switch self {
    case .hc: return "Bot 写代码用的终端；Bot 只碰自己开的终端"
    case .herdr: return "你自己用的终端；Bot 不在这里操作，只读它在 Inspector 里的样子"
    }
  }

  /// The vendor's own installer. It is run through `sh -lc` so the login PATH is in effect.
  public var installCommand: String {
    switch self {
    case .hc: return "curl -fsSL https://releases.herdr.dev/core/install.sh | sh"
    case .herdr: return "curl -fsSL https://herdr.dev/install.sh | sh"
    }
  }
}

/// What the page knows about one tool at this moment.
public enum HerdrToolState: Equatable, Sendable {
  case checking
  /// Installed, with the first line of what it printed for `--version`.
  case installed(String)
  case missing
  case failed(String)

  public var isInstalled: Bool {
    if case .installed = self { return true }
    return false
  }

  /// The line the page shows beside the name.
  public var detail: String {
    switch self {
    case .checking: return "正在检查…"
    case .installed(let version): return version
    case .missing: return "未安装"
    case .failed(let message): return message
    }
  }
}

/// Detects the two tools and installs one on request. It reads only the binary's own version
/// line, and installation runs the vendor script the page names, never a shell a person typed.
public struct HerdrToolchain: Sendable {
  public var detect: @Sendable (HerdrTool) async -> HerdrToolState
  public var install: @Sendable (HerdrTool) async -> String?

  public init(
    detect: @escaping @Sendable (HerdrTool) async -> HerdrToolState,
    install: @escaping @Sendable (HerdrTool) async -> String?
  ) {
    self.detect = detect
    self.install = install
  }

  public static func live(
    home: URL = FileManager.default.homeDirectoryForCurrentUser,
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) -> HerdrToolchain {
    HerdrToolchain(
      detect: { tool in await HerdrToolchain.readVersion(tool, home: home, environment: environment)
      },
      install: { tool in
        await HerdrToolchain.runInstaller(tool, home: home, environment: environment)
      }
    )
  }

  /// The same search order the App uses for `herdr` in the inspector: the person's own bin
  /// directory first, then the inherited PATH, then the usual install roots.
  static func executable(
    _ tool: HerdrTool, home: URL, environment: [String: String]
  ) -> URL? {
    let paths =
      [home.appendingPathComponent(".local/bin").path]
      + (environment["PATH"] ?? "").split(separator: ":").map(String.init)
      + ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
    return paths.filter { $0.hasPrefix("/") }
      .map { URL(fileURLWithPath: $0).appendingPathComponent(tool.command) }
      .first { FileManager.default.isExecutableFile(atPath: $0.path) }
  }

  static func readVersion(
    _ tool: HerdrTool, home: URL, environment: [String: String]
  ) async -> HerdrToolState {
    guard let executable = executable(tool, home: home, environment: environment) else {
      return .missing
    }
    let outcome = await run(
      executable: executable, arguments: ["--version"], environment: environment,
      timeout: .seconds(10))
    switch outcome {
    case .failed(let message): return .failed(message)
    case .ran(let code, let output, _):
      let line = output.split(separator: "\n").first.map(String.init) ?? ""
      if code != 0 { return .failed(line.isEmpty ? "退出码 \(code)" : line) }
      return .installed(line.isEmpty ? "已安装" : line)
    }
  }

  static func runInstaller(
    _ tool: HerdrTool, home: URL, environment: [String: String]
  ) async -> String? {
    var shellEnvironment = environment.filter {
      ["LANG", "LC_ALL", "LC_CTYPE", "TMPDIR"].contains($0.key)
    }
    shellEnvironment["HOME"] = home.path
    shellEnvironment["PATH"] =
      "\(home.appendingPathComponent(".local/bin").path):"
      + (environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin")
    let outcome = await run(
      executable: URL(fileURLWithPath: "/bin/sh"), arguments: ["-lc", tool.installCommand],
      environment: shellEnvironment, timeout: .seconds(300))
    switch outcome {
    case .failed(let message): return message
    case .ran(let code, let output, let error):
      if code == 0 { return nil }
      let detail = error.isEmpty ? output : error
      return detail.isEmpty ? "安装失败（退出码 \(code)）" : detail
    }
  }

  private enum Outcome {
    case ran(code: Int32, output: String, error: String)
    case failed(String)
  }

  private static func run(
    executable: URL, arguments: [String], environment: [String: String], timeout: Duration
  ) async -> Outcome {
    let process = Process()
    let output = Pipe()
    let error = Pipe()
    process.executableURL = executable
    process.arguments = arguments
    process.environment = environment
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = output
    process.standardError = error
    do { try process.run() } catch { return .failed(error.localizedDescription) }
    try? output.fileHandleForWriting.close()
    try? error.fileHandleForWriting.close()
    let deadline = ContinuousClock.now.advanced(by: timeout)
    while process.isRunning, ContinuousClock.now < deadline {
      try? await Task.sleep(for: .milliseconds(50))
    }
    if process.isRunning {
      kill(process.processIdentifier, SIGKILL)
      return .failed("超时未完成")
    }
    let text =
      String(
        data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    let errors =
      String(
        data: error.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    return .ran(
      code: process.terminationStatus,
      output: text.trimmingCharacters(in: .whitespacesAndNewlines),
      error: errors.trimmingCharacters(in: .whitespacesAndNewlines))
  }
}
