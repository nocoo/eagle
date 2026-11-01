import EagleCLIKit
import Foundation

/// `eagle` / `eagle-dev`: a thin client of the local daemon (`docs/bots/CLI.md`).
@main
enum CLI {
  static func main() async {
    let code = await CLIEntry.run(arguments: CommandLine.arguments)
    exit(code)
  }
}
