// The daemon process (docs/bots/ARCHITECTURE.md, "Process model"): configuration in, one
// composition root, a start line a supervisor can parse, and a shutdown on a signal. The
// behaviour lives in `src/`; this file is only process wiring and has no test double.
import { join } from "node:path";
import { readConfig } from "../src/config.ts";
import { startDaemon } from "../src/main.ts";

// A refused start (another owner, or a root that shares a lock port) is reported and
// exits non-zero; the composition root only throws, so an embedded host stays alive.
const handle = await startDaemon(readConfig()).catch((error: unknown) => {
  process.stderr.write(`bots: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
process.stdout.write(
  `${JSON.stringify({
    event: "daemon.start",
    root: handle.config.root,
    port: handle.port,
    tokenFile: join(handle.config.root, "token"),
  })}\n`,
);

const shutdown = async (): Promise<void> => {
  // A last-resort deadline: the process leaves even if a subsystem never returns.
  const hard = setTimeout(() => process.exit(1), handle.config.closeDeadlineMs + 2_000);
  hard.unref();
  const result = await handle.close().catch(() => "timeout" as const);
  process.exit(result === "closed" ? 0 : 1);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
