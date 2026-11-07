import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { ObservationClient } from "../src/observation.ts";
import { startService } from "../src/server.ts";

process.umask(0o077);
try {
  const { values } = parseArgs({ options: { root: { type: "string" }, port: { type: "string" } } });
  const root = resolve(
    values.root ?? process.env.SUPERAGENT_ROOT ?? `${homedir()}/.local/share/eagle-superagent-dev`,
  );
  const port = Number(values.port ?? process.env.SUPERAGENT_PORT ?? "43127");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("invalid_port");
  // SG-002: the worker daemon's observation routes. The credential is the daemon's own
  // file; nothing is read from a worker token, an environment value or an argument.
  const observation = new ObservationClient({
    root,
    endpoint: process.env.BOTS_OBSERVATION_ENDPOINT ?? "http://127.0.0.1:43117",
    tokenFile:
      process.env.BOTS_OBSERVATION_TOKEN_FILE ??
      `${homedir()}/.local/share/eagle-bots/observation/token`,
  });
  const service = await startService({ root, port, observation });
  process.stdout.write(
    `${JSON.stringify({ type: "ready", port: service.port, ...service.identity })}\n`,
  );
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => {
      process.stderr.write("superagent.close.timeout\n");
      process.exit(1);
    }, 6_000);
    service.close().then(
      () => {
        clearTimeout(deadline);
        process.exitCode = 0;
      },
      () => {
        process.stderr.write("superagent.close.failed\n");
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
} catch {
  process.stderr.write("superagent.start.failed\n");
  process.exitCode = 1;
}
