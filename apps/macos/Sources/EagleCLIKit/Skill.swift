import Foundation

/// `--skill`: the document another agent reads to learn this surface in one call. It is the
/// same shape as `herdr --skill`, and `docs/bots/CLI.md` "skill" owns its text.
public enum Skill {
  public static func document(binaryName: String, clientName: String?) -> String {
    // The parenthetical is the only part that depends on the credential, so the sentence
    // reads the same with and without one.
    let asClient = clientName.map { " (this copy answers as \($0))" } ?? ""
    let document = """
      ---
      name: \(binaryName)
      description: "List and manage the local Bots catalog and talk to one bot. Use when the user asks to message a bot, to create or organize bots, or to read what a bot answered. Requires a running Eagle App with the CLI switch on."
      ---

      # Eagle

      Eagle owns a local daemon that runs multi-bot conversations. The `\(binaryName)` command is
      the supported way to reach it from a terminal or from another agent. It reads its
      credential from `~/.config/eagle/\(binaryName).json`\(asClient); there is nothing else to
      configure.

      Start with `\(binaryName) --help`, then one command group without arguments
      (`\(binaryName) bots`, `\(binaryName) chat`). Do not guess ids: read them from `bots list`,
      `groups list` or the JSON shapes.

      ## Rules

      - Prefer `--json` when you need to parse an answer; the text form is for a person.
      - `chat send --wait` returns after the run settles and prints the answer; `chat watch`
        keeps streaming, including messages another client sends.
      - Creating, renaming, moving and deleting change the catalog the App shows immediately.
        Delete only when the user asked for it, and only with `--yes`.
      - Exit 3 means this credential lacks the scope; ask the person to add it in
        Settings → CLI instead of retrying.
      - Exit 4 means the daemon is unreachable: the CLI switch may be off, or the App is not
        running. Do not start a second daemon.

      ## Commands

      ```
      \(binaryName) --skill | --version | --help
      \(binaryName) health
      \(binaryName) whoami
      \(binaryName) bots list [--group G|-] [--json]
      \(binaryName) bots show <bot>
      \(binaryName) bots create --title T [--label L] [--group G] [--shape S --tint C]
      \(binaryName) bots update <bot> [--title T] [--label L] [--group G|-] [--model M] [--thinking LEVEL]
      \(binaryName) bots move <bot> --group G|-
      \(binaryName) bots delete <bot> --yes
      \(binaryName) groups list|create <title>|rename <id> <title>|order <id,id,…>|delete <id> --yes
      \(binaryName) chat send <bot> --text T [--wait] [--timeout 120] [--when-busy followUp|steer]
      \(binaryName) chat watch <bot>
      \(binaryName) chat history <bot> [--limit N] [--before e_12]
      \(binaryName) chat abort <bot>
      \(binaryName) usage [--days N]
      ```

      A `<bot>` is an id (`b_…`) or an exact, unique title.
      """
    guard binaryName != "eagle" else { return document }
    return document + "\n\n" + developmentSection(binaryName: binaryName)
  }

  /// Only a development copy reads `~/.config/eagle-dev/token`; the released `eagle` never
  /// does, so its document must not mention it (`docs/bots/CLI.md` "Development token").
  private static func developmentSection(binaryName: String) -> String {
    """
    ## The development token

    This copy is a development build, so it also accepts a credential you mint yourself,
    and a run then needs nobody at a switch:

    ```
    umask 077 && mkdir -p ~/.config/eagle-dev && openssl rand -base64 48 > ~/.config/eagle-dev/token
    ```

    The file holds one bearer of at least 32 characters, and its mode must be `0600`; any
    other mode is refused with exit 3 and the path in the message. `EAGLE_TOKEN` wins over
    the file, and the file wins over `~/.config/eagle/\(binaryName).json`.
    """
  }
}
