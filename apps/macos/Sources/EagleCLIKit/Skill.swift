import Foundation

/// `--skill`: the document another agent reads to learn this surface in one call. It is the
/// same shape as `herdr --skill`, and `docs/bots/CLI.md` "skill" owns its text.
public enum Skill {
  public static func document(binaryName: String, clientName: String?) -> String {
    """
    ---
    name: \(binaryName)
    description: "List and manage the local Bots catalog and talk to one bot. Use when the user asks to message a bot, to create or organize bots, or to read what a bot answered. Requires a running Eagle App with the CLI switch on."
    ---

    # Eagle

    Eagle owns a local daemon that runs multi-bot conversations. The `\(binaryName)` command is
    the supported way to reach it from a terminal or from another agent. It reads its
    credential from `~/.config/eagle/\(binaryName).json`; there is nothing to configure here
    \(clientName.map { "(this copy answers as \($0))" } ?? "").

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
  }
}
