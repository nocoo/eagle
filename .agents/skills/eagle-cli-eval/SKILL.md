---
name: eagle-cli-eval
description: Run and extend Eagle Bots CLI acceptance, including isolated memory, reflection, decision and password-card cases. Use for CLI evals, three-round verification, regressions or local dev App acceptance.
---

# Eagle CLI acceptance

Work from the repository root. Read `AGENTS.md`, `docs/bots/TESTING.md`,
`docs/bots/CLI.md` and `tests/eval/README.md` before changing the runner or cases.
The scripted model is a fixture; never claim it verifies a real provider or a rendered UI.

## Safety and setup

- Use Node 24+, the installed independent `apps/bots` dependencies and Xcode for the Swift
  CLI. Use the machine-approved registry if installation is needed; do not retry a blocked
  public registry. Build `@nocoo/eagle-agent` before macOS device-host tests.
- `npm --prefix apps/bots run eval` builds `eagle-cli` and runs it as `eagle-dev` against
  real temporary daemons on kernel-assigned ports. Each case owns its home, memory, secret
  store, key and credential. Never point a case at an existing daemon, Bot, shared memory,
  provider key or password. Cases may use only fictional fixture values.
- Never pass a password or token in command arguments, a URL, source, logs or chat. Answer a
  secret card with `chat secret --stdin` from redirected input, or `--skip`; do not enter a
  real value during eval. `stdoutExcludes` and `stderrExcludes` guard fixture leaks without
  copying the forbidden text into failure diagnostics.
- Do not drive an existing live Bot to test a secret. Answering a card starts another model
  turn, which can run tools; keep that turn and its tool environment inside the case root.
- Keep the owner's App and daemon separate from eval. Restart a Dev App only when requested;
  use the project's Herdr pane workflow, verify PID, source directory and listener, and leave
  the App in the foreground. Do not kill another owner's process or replace live state.

## Three rounds

1. Run the entire suite from the root:

   ```sh
   npm --prefix apps/bots run eval
   ```

   Record every case and the exit code. `eval:cli` selects only `cli-*`; it does not replace
   the full suite. `--case <id>` is for diagnosis, followed by the whole suite again.
2. For every failure or uncovered requirement, first demonstrate it with a failing case or
   deterministic test, then make the smallest fix. Update the owning contract in the same
   commit when behavior changes. Run affected tests, `npm --prefix apps/bots run check`, and
   Swift package tests when Swift changes. Commit that coherent fix before the next round.
3. Repeat the full suite for rounds two and three, fixing and verifying each round before
   proceeding. A single `--repeat 3` repeats each case consecutively; it is not three
   fix-between-rounds. Never skip tests, relax limits or treat an interrupted run as green.

`tests/eval/cases/cli-*` drive conversations, authentication and exits through the real
CLI. Use raw HTTP only for fixture setup that the CLI does not expose, not as the product
journey. Existing cases cover auth, chat, memory, reflection, decision, secret admission,
read-only refusal, replay, skip and home isolation. Add cases for the observed failure,
including a negative control for a security assertion; avoid sleeps in place of a barrier.

## Evidence

Report the commit and remote base, three separate full-suite results and exit codes, every
fix and its failing test, and the final foreground App/daemon PID and source path. Distinguish
scripted model, real CLI, real filesystem/process and rendered-App evidence. State unrun root
release gates, real provider, Herdr collection, authentication and D1 checks explicitly.
