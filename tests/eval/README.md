# Bots eval cases

Repeatable acceptance runs of a **real** Bots daemon against a **scripted** model. Each
case is one JSON file; a run boots the daemon on a temporary root, serves the case's
model replies from a local Responses endpoint, drives the case's steps over HTTP and a
WebSocket, and then checks what the transcript actually contains.

These are acceptance runs, not unit tests: they need no API key, no network and no Herdr,
but they do boot a process, write real files and run real tools. The deterministic gates
live in `apps/bots/test` (`npm --prefix apps/bots run check`); a case here answers "does
the whole product still do this end to end".

```sh
# every case, one report line each
npm --prefix apps/bots run eval
# one case, with the model requests and every frame printed
npm --prefix apps/bots run eval -- --case coding-fix-loop --verbose
# leave the temp root for inspection
npm --prefix apps/bots run eval -- --case trigger-webhook --keep
# trace every frame and every model request while it runs
EVAL_TRACE=1 npm --prefix apps/bots run eval -- --case trigger-cron --verbose
```

## CLI cases

A case whose steps are `cli` drives the product through the shipped command line
instead of the raw wire, which is how acceptance is run (`docs/bots/TESTING.md`,
"Driving acceptance through the CLI").

```sh
# builds apps/macos' eagle-cli, then runs every cli-* case through it
npm --prefix apps/bots run eval:cli
npm --prefix apps/bots run eval:cli -- --case cli-chat --verbose
```

`eval:cli` links the built binary as `eagle-dev` inside the case's temp root, because
the CLI takes its own name from argv0: that name selects the development credential.
Each case gets a temporary `HOME`, mints `~/.config/eagle-dev/token` there (mode 0600)
and starts the daemon with `BOTS_DEV_AGENT_TOKEN` pointing at it, so a run never reads
or writes the real `~/.config`. A `file` step rewrites that token (mode or value) to
prove a case fails closed.

| Extra step | Does |
| --- | --- |
| `cli` | Runs `args` with `HOME`, `EAGLE_ROOT` and `EAGLE_PORT` set; asserts `expectExit`, `stdoutContains`, `stderrContains` and a `json` subset. `bin: "release"` runs a link named `eagle`; `expectTimeout` is for a command that must outlive its budget (`chat watch`). `capture` stores the last JSON line. |
| `file` | Writes a path under the case root with an optional octal `mode`. |

`http` and `cli` steps may `capture` a name, and later steps address it as
`{{name.path.to.value}}` in `args`, `env`, `file` content or a string `json`
expectation. The runner also captures `{{dev.token}}`, `{{dev.path}}` and
`{{dev.home}}`. Every case still ends with the same transcript assertions.

A run exits non-zero when any case fails, and the report names the first unmet
expectation. `--repeat N` runs a case N times in a row: that is how a trigger is proven
stable rather than lucky once.

## Case format

```jsonc
{
  "id": "coding-fix-loop",              // unique, matches the file name
  "title": "修好一个失败的脚本",          // one line for the report
  "kind": "coding",                      // chat | coding | search | trigger | complex
  "notes": "why this case exists",       // optional, free text
  "timeoutMs": 120000,                   // optional, whole-case budget (default 120 s)
  "toolGroups": ["core", "coding"],      // optional, default ["core", "coding"]
  "workspace": {                         // optional files the bot starts with
    "src/sum.js": "export const sum = (a, b) => a - b;\n"
  },
  "triggers": [                          // optional, written before the bot opens
    {
      "kind": "webhook",                 // webhook | schedule
      "name": "deploy notify",
      "prompt": "a deploy finished; report the result",
      "cron": "* * * * *",               // schedule only
      "timezone": "Asia/Shanghai",        // schedule only, defaults to the runner's zone
      "enabled": true
    }
  ],
  "model": {
    "script": [                          // served in order, one per model request
      { "text": "先看看脚本。" },
      { "toolCall": { "name": "read", "args": { "path": "src/sum.js" } } },
      { "toolCall": { "name": "bash", "args": { "command": "node check.mjs" } } },
      { "toolCall": { "name": "edit", "args": {
          "path": "src/sum.js",
          "edits": [{ "oldText": "a - b", "newText": "a + b" }] } } },
      { "toolCall": { "name": "bash", "args": { "command": "node check.mjs" } } },
      { "text": "修好了：加号。" }
    ],
    "repeatLast": false                  // optional; default false fails on extra requests
  },
  "steps": [
    { "kind": "chat", "text": "把 check.mjs 修好" },
    { "kind": "webhook", "trigger": "deploy notify", "body": "deploy 2f1a failed" },
    { "kind": "webhook", "trigger": "deploy notify", "body": "deploy 2f1a failed",
      "idempotencyKey": "k-1" },         // a retry, deduped by the daemon
    { "kind": "patch", "trigger": "deploy notify", "enabled": false },
    { "kind": "http", "method": "POST", "path": "/v1/triggers/<bot>/<trigger>",
      "headers": { "authorization": "Bearer wrong" }, "body": "x", "expectStatus": 404 },
    { "kind": "waitFor", "origin": "schedule", "count": 2, "timeoutMs": 150000 },
    { "kind": "sleep", "ms": 500 }
  ],
  "expect": {
    "messages": [                        // exact order, each check optional
      { "role": "user", "origin": "webhook", "contains": "deploy 2f1a failed" },
      { "role": "assistant", "contains": "修好了" }
    ],
    "atLeast": [                         // counts over the whole transcript
      { "origin": "schedule", "count": 2 },
      { "role": "assistant", "count": 1 }
    ],
    "toolsCalled": ["read", "bash", "edit"],   // every named tool ran at least once
    "files": { "src/sum.js": "a + b" },        // the workspace afterwards
    "noErrors": true,                    // no error frame beyond an unconfigured search
    "modelRequests": { "max": 8 }        // a loop guard: a runaway model fails the case
  }
}
```

Steps run in order. Every step has `kind`; `timeoutMs` on a step overrides the case
budget for that step.

| Step | Does |
| --- | --- |
| `chat` | Sends a message as the person and waits for the run to settle |
| `webhook` | Posts `body` to one of the case's webhook triggers with its own token; `idempotencyKey` when a retry is the point |
| `patch` | `PATCH /v1/triggers/<bot>/<trigger>` with `{ enabled }` |
| `http` | Any request against the daemon; `expectStatus` asserts the code |
| `waitFor` | Waits until the transcript has at least `count` messages matching `origin`/`role`/`contains` |
| `sleep` | Waits; only for spacing, never to "hope" for an outcome |

## What is already covered

- `chat-basic` — a plain answer with no tool.
- `coding-fix-loop` — read, run, edit, re-run; the runner also checks the file changed.
- `search-unconfigured` — the deferred search tools discovered with `tool_search` and then
  refused without a provider key: a bounded result the model can read, and the run
  continues. A case runs with a **temporary `XDG_CONFIG_HOME`**, so it never reads the
  user's saved provider keys and never spends their credits. The keyed wire behaviour
  (DeepSeek, Tavily, ranking, cancellation) is covered deterministically by
  `apps/bots/test/tools/search*`.
- `trigger-webhook` — a delivery, a retry deduped by its key, a disabled 409, a wrong
  token 404, and the answer that follows.
- `trigger-cron` — a `* * * * *` schedule that must fire at least twice; run it with
  `--repeat 3` to prove it is stable (≈2 minutes per round).
- `complex-self-trigger` — the model creates its own webhook trigger with
  `trigger_create`, and a delivery then reaches it.
- `cli-surface` — the release-facing basics through the CLI: `--version`, `--skill`,
  `health`, `whoami`, `usage`, and the documented exit codes 2, 3 and 4.
- `cli-catalog` — groups and bots created, renamed, reordered, moved and deleted only
  through commands, each write read back by the next command.
- `cli-chat` — `chat send --wait`, `chat history`, `chat watch`, and an answer aborted
  while it is still in flight; the transcript must never carry that answer.
- `cli-auth` — the development token works, an unsafe or replaced file is refused, a
  release binary ignores the file, and a read-only credential cannot write.
- `complex-*` — three different end-to-end shapes (a coding loop, a triggered triage
  that writes a file, and a model that creates its own trigger and then receives a
  delivery).

## Limits

A case never proves a real provider's behaviour: the model is scripted, so a case can
only fail on the daemon, the tools or the wiring. Search without a key is refused by
design, so keyed search is not an eval case. Nothing here runs Herdr.
