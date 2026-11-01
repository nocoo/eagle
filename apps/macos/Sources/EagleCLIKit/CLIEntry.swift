import Foundation

/// The one place that turns arguments into an exit code (`docs/bots/CLI.md` "Exit codes").
public enum CLIEntry {
  @discardableResult
  public static func run(
    arguments: [String],
    environment: [String: String] = ProcessInfo.processInfo.environment,
    home: String? = nil,
    printer makePrinter: ((Bool) -> Printer)? = nil,
    session: URLSession = .shared
  ) async -> Int32 {
    let argv0 = arguments.first ?? "eagle-dev"
    let tokens = Array(arguments.dropFirst())
    let config = CLIConfig.load(argv0: argv0, environment: environment, home: home)
    let printer =
      makePrinter?(tokens.contains("--json")) ?? Printer(json: tokens.contains("--json"))
    do {
      try await Commands(config: config, printer: printer, session: session).run(tokens)
      return 0
    } catch let error as CLIError {
      printer.error(error.message)
      return error.exitCode
    } catch {
      printer.error("\(error)")
      return 1
    }
  }
}
