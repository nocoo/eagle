import Foundation

/// Output is the only place that decides between a person and a parser: `--json` prints one
/// JSON object per line and nothing else. The sink is injectable so a test reads exactly
/// what the binary would print.
public struct Printer: Sendable {
  public typealias Sink = @Sendable (String, Bool) -> Void

  private let json: Bool
  private let sink: Sink

  public init(json: Bool, sink: @escaping Sink = Printer.standard) {
    self.json = json
    self.sink = sink
  }

  public static let standard: Sink = { line, isError in
    let handle = isError ? FileHandle.standardError : FileHandle.standardOutput
    handle.write(Data((line + "\n").utf8))
  }

  public func wantsJSON(_ arguments: Arguments) -> Bool {
    json || arguments.switches.contains("json")
  }

  public func text(_ line: String) { sink(line, false) }

  public func error(_ line: String) { sink(line, true) }

  public func json(_ object: Any) {
    guard JSONSerialization.isValidJSONObject(object),
      let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    else {
      text("{}")
      return
    }
    text(String(decoding: data, as: UTF8.self))
  }

  /// Prints the whole answer as JSON, or one text line drawn from it.
  public func output(
    _ arguments: Arguments, json object: [String: Any], line: ([String: Any]) -> String
  ) {
    if wantsJSON(arguments) {
      json(object)
      return
    }
    text(line(object["group"] as? [String: Any] ?? object))
  }
}

/// The CLI's own identity: the App's version when it ships inside the bundle. A helper
/// binary has no `Info.plist` of its own, so the enclosing `.app` is what carries it.
public enum EagleCLIKit {
  public static var version: String {
    if let short = version(inAppContaining: executableURL), !short.isEmpty { return short }
    if let short = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
      !short.isEmpty, short != "dev"
    {
      return short
    }
    return "dev"
  }

  private static var executableURL: URL {
    (CommandLine.arguments.first.map { URL(fileURLWithPath: $0) } ?? URL(fileURLWithPath: ""))
      .resolvingSymlinksInPath()
  }

  /// Walks up from the binary until a `Contents/Info.plist` names a version.
  private static func version(inAppContaining executable: URL) -> String? {
    var directory = executable.deletingLastPathComponent()
    for _ in 0..<5 {
      let plist = directory.appendingPathComponent("Contents/Info.plist")
      if let data = try? Data(contentsOf: plist),
        let object = try? PropertyListSerialization.propertyList(
          from: data, options: [], format: nil) as? [String: Any],
        let short = object["CFBundleShortVersionString"] as? String,
        !short.isEmpty, short != "dev"
      {
        return short
      }
      directory = directory.deletingLastPathComponent()
    }
    return nil
  }
}
