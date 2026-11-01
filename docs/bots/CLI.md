# Bots — the `eagle` CLI

The App ships a small command line client so another agent on this Mac can list the bots,
talk to one of them, and manage the catalog without a window. The CLI is a thin wrapper over
the daemon's HTTP and WebSocket surface ([PROTOCOL.md](PROTOCOL.md)); it holds no state of its
own and never invents one.

## Names, install, discovery

| Build | Binary | Link |
| --- | --- | --- |
| Release App | `Contents/Helpers/eagle` | `~/.local/bin/eagle` |
| Development or candidate App | `Contents/Helpers/eagle-dev` | `~/.local/bin/eagle-dev` |

- **The App owns the installation.** Settings → CLI has one switch. Turning it on creates the
  symlink into `~/.local/bin`, issues the `this-mac` credential (scopes `read` and `write`)
  when none is configured yet, and writes the config file. Turning it off removes the link
  and revokes that credential; the daemon keeps running for the App.
- **Permissions are asked for at the switch.** Creating `~/.local/bin` or the link needs no
  elevation; if a person's `~/.local/bin` is missing and cannot be created, the switch
  reports the exact path and stops. The App never edits a shell profile: when
  `~/.local/bin` is not in `PATH`, the page shows the one `export` line to add.
- **Two builds, two names.** `eagle` and `eagle-dev` never overwrite each other, and each
  keeps its own config file and its own credential, so a development daemon and the daily
  App can run side by side.
- **Config file.** `~/.config/eagle/<binary-name>.json`, mode 0600:

```json
{ "root": "/Users/me/.local/share/eagle-bots", "port": "43117",
  "token": "c_01H….Zm9vYmFy", "client": "this-mac" }
```

- **Resolution order.** `EAGLE_TOKEN` and `EAGLE_PORT` / `EAGLE_ROOT` win over the file;
  the file wins over the defaults (`~/.local/share/eagle-bots`, `43117`). A missing token is
  an auth failure with a message naming the file, never a silent fallback to the App's own
  `<root>/token`: a CLI credential cannot borrow the App's rights.
- **No secrets on the command line.** `--token` does not exist. The config file and the
  environment are the only carriers, so a token never lands in shell history or `ps`.

## Development token

A development copy of the CLI can carry a credential that the person or an agent minted
itself, so an acceptance run needs nobody at a switch. The released `eagle` never reads
this file.

- **Path.** `~/.config/eagle-dev/token`, one bearer token and nothing else.
- **Mode 0600.** Only its owner may read it; only the file's mode is checked, not the
  directory's.
- **At least 32 characters** after trimming; a shorter value is refused.
- **Mint it with:**

```sh
umask 077 && mkdir -p ~/.config/eagle-dev && openssl rand -base64 48 > ~/.config/eagle-dev/token
```

- **Resolution order for a development binary** (`eagle-dev`, or a `swift run` copy):
  `EAGLE_TOKEN`, then `~/.config/eagle-dev/token`, then the `token` in
  `~/.config/eagle/eagle-dev.json`, then nothing — which is an auth failure (exit 3).
  `EAGLE_TOKEN` wins because it is the caller's own instruction for this one run, while a
  file on disk is a leftover another run may have written; a token set for this command
  must not be shadowed by it, and a file that is not safe is not even read.
- **An unsafe file is an explicit local error.** A development token file that exists but
  is not mode 0600, or whose trimmed content is shorter than 32 characters, stops the
  commands that need a credential with exit 3 and a message naming the path and the
  reason. It never falls back to the config file's token and never sends a request.
  `--version`, `--help`, `--skill` and `health` still work: they need no credential, and
  `--version` is the diagnostic for a broken setup.
- **The released `eagle` is unchanged**: `EAGLE_TOKEN`, then the `token` in
  `~/.config/eagle/eagle.json`, and never `~/.config/eagle-dev`.
- **The daemon side.** An App running from source starts its daemon with
  `BOTS_DEV_AGENT_TOKEN=<home>/.config/eagle-dev/token`, which is how a development daemon
  learns to accept that file. A packaged build never sets it, so a released App's daemon
  never accepts a development token.

The token file and `EAGLE_TOKEN` are the only carriers; nothing travels on the command
line, and the App's own `<root>/token` is never borrowed.

## Commands

Every command prints human-readable text by default and one JSON object with `--json`. Ids
come from the daemon; a bot may also be named by its exact title when that title is unique.

| Command | Scope | What it does |
| --- | --- | --- |
| `eagle --skill` | — | Prints the agent-facing skill document (below `## skill`) |
| `eagle --version` | — | Prints the App version and the daemon it talks to |
| `eagle health` | none | `GET /v1/health`; answers without a credential |
| `eagle whoami` | read | `GET /v1/clients/me`: the credential name and its scopes |
| `eagle bots list` | read | The catalog with id, title, label, group, face, state |
| `eagle bots show <bot>` | read | One summary, plus its group title |
| `eagle bots create --title T [--label L] [--shape S --tint C] [--group G]` | write | `POST /v1/bots` |
| `eagle bots update <bot> [--title] [--label] [--shape --tint] [--group] [--model] [--thinking]` | write | `PATCH /v1/bots/:id`; `--group -` and `--label ""` clear their field |
| `eagle bots move <bot> --group G` | write | The one-field form of `update --group` |
| `eagle bots delete <bot> --yes` | admin | `DELETE /v1/bots/:id` |
| `eagle groups list` | read | Groups in display order with member counts |
| `eagle groups create <title>` | write | `POST /v1/groups` |
| `eagle groups rename <id> <title>` | write | `PATCH /v1/groups/:id` |
| `eagle groups order <id,id,…>` | write | `PUT /v1/groups/order`, every group once |
| `eagle groups delete <id> --yes` | admin | `DELETE /v1/groups/:id` |
| `eagle chat send <bot> --text T [--wait] [--timeout 120]` | write | Subscribes, sends, and with `--wait` prints the answer once the run settles |
| `eagle chat watch <bot>` | read | Streams every append and delta until interrupted; another client's messages appear too |
| `eagle chat history <bot> [--limit N] [--before e_12]` | read | Older messages, oldest first |
| `eagle chat abort <bot>` | write | Withdraws the running input and the queue |
| `eagle usage [--days N]` | read | Token and call totals over the retention window |

`--json` shapes follow PROTOCOL.md: `{ "bots": [...] }`, `{ "bot": {...} }`,
`{ "groups": [...] }`, `{ "usage": {...} }`, and for chat one object per line:
`{ "type": "append" | "delta" | "status" | "submission" | "history", ... }` exactly as the
socket frames carry them.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Done |
| 1 | The daemon refused the request (`error.kind` is printed) |
| 2 | The command line is wrong; nothing was sent |
| 3 | No credential, a refused credential, or a missing scope |
| 4 | The daemon is unreachable: no CLI switch on, App not running, or a wrong port |

Destructive commands require `--yes`; without it they answer code 2 and send nothing.

## skill

`eagle --skill` prints the document below, with the binary's own name substituted, so an
agent can learn the surface with one command and then use `--help` for exact syntax. It is
the same shape as `herdr --skill`.

A development copy (`eagle-dev`, or a `swift run` copy) prints the same document followed by
the `## The development token` section, because only it reads that file; the released
`eagle` never mentions it.

```markdown
---
name: eagle
description: "List and manage the local Bots catalog and talk to one bot. Use when the user asks to message a bot, to create or organize bots, or to read what a bot answered. Requires a running Eagle App with the CLI switch on."
---

# Eagle

Eagle owns a local daemon that runs multi-bot conversations. The `eagle` command is
the supported way to reach it from a terminal or from another agent. It reads its
credential from `~/.config/eagle/eagle.json`; there is nothing else to
configure.

Start with `eagle --help`, then one command group without arguments
(`eagle bots`, `eagle chat`). Do not guess ids: read them from `bots list`,
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
eagle --skill | --version | --help
eagle health
eagle whoami
eagle bots list [--group G|-] [--json]
eagle bots show <bot>
eagle bots create --title T [--label L] [--group G] [--shape S --tint C]
eagle bots update <bot> [--title T] [--label L] [--group G|-] [--model M] [--thinking LEVEL]
eagle bots move <bot> --group G|-
eagle bots delete <bot> --yes
eagle groups list|create <title>|rename <id> <title>|order <id,id,…>|delete <id> --yes
eagle chat send <bot> --text T [--wait] [--timeout 120] [--when-busy followUp|steer]
eagle chat watch <bot>
eagle chat history <bot> [--limit N] [--before e_12]
eagle chat abort <bot>
eagle usage [--days N]
```

A `<bot>` is an id (`b_…`) or an exact, unique title.
```

```markdown
## The development token

This copy is a development build, so it also accepts a credential you mint yourself,
and a run then needs nobody at a switch:

```
umask 077 && mkdir -p ~/.config/eagle-dev && openssl rand -base64 48 > ~/.config/eagle-dev/token
```

The file holds one bearer of at least 32 characters, and its mode must be `0600`; any
other mode is refused with exit 3 and the path in the message. `EAGLE_TOKEN` wins over
the file, and the file wins over `~/.config/eagle/eagle-dev.json`.
```

## Limits and refusals

- The CLI never writes to `<root>/clients.json`; issuing, revoking and deleting credentials
  is the App's job (`/v1/clients`, `admin`).
- One CLI process opens at most one socket and closes it on exit or Ctrl-C.
- Every refused call prints `error.kind` verbatim and exits non-zero; a partial answer is
  never printed as if it were complete.
