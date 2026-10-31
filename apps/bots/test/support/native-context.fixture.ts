// Owned native composition fixture: production HTTP/socket/runtime over real SDK SQLite.
// Only the provider is controlled; the bridge reads evidence and never supplies history.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { HistoryBundle } from "../../src/runtime/pi/HistoryReplica.ts";
import { assistant, getCurrentSystemMessage, text, toolCall, trace, waitFor } from "./pi.ts";
import { startStack } from "./server.ts";

const root = await mkdtemp(join(tmpdir(), "eagle-native-context-"));
const stack = await startStack({ real: true, root });
try {
  await writeFile(join(root, "token"), stack.token, { mode: 0o600 });
  const bot = await stack.createBot("本机历史接力");
  const handle = await stack.registry.open(bot, trace);
  const command = async (method: "export" | "context" | "merge", params: unknown) =>
    handle.replica?.({ method, params, trace });
  stack.faux?.setResponses([
    assistant(
      [
        toolCall("write", {
          path: "native-once.txt",
          content: "original native tool bytes",
        }),
      ],
      { stopReason: "toolUse" },
    ),
    text("共同工具结果"),
  ]);
  await handle.submit({
    requestId: "native_fixture_seed",
    text: "共同原始上下文",
    whenBusy: "followUp",
    trace,
  });
  await waitFor(
    async () => (await handle.submission({ requestId: "native_fixture_seed" }))?.status === "done",
    "seed commits",
  );
  const seed = (await command("export", {})) as HistoryBundle;
  const parents: HistoryBundle[] = [];
  for (const side of ["left", "right"]) {
    const contextId = `native_fixture_${side}`;
    const bytes = Buffer.from(`${side} native instructions`);
    const resource = (await command("export", {
      kind: "resources",
      resources: [
        {
          name: "AGENTS.md",
          kind: "instructions",
          sha256: createHash("sha256").update(bytes).digest("hex"),
          base64: bytes.toString("base64"),
        },
      ],
    })) as { head: string };
    await command("context", {
      contextId,
      head: seed.head,
      resourceHead: resource.head,
    });
    stack.faux?.setResponses([text(`${side} 分支结果`)]);
    await handle.submit({
      requestId: `native_branch_${side}`,
      contextId,
      resourceHead: resource.head,
      text: `${side} 分支原文`,
      whenBusy: "followUp",
      trace,
    });
    await waitFor(
      async () =>
        (
          await handle.submission({
            requestId: `native_branch_${side}`,
            contextId,
          })
        )?.status === "done",
      "branch commits",
    );
    parents.push((await command("export", { contextId })) as HistoryBundle);
  }
  const baselineCalls = stack.faux?.state.callCount;
  const providerInputs: unknown[] = [];
  const providerResources: string[] = [];
  stack.faux?.setResponses([
    (request) => {
      providerInputs.push(request.messages);
      providerResources.push(
        getCurrentSystemMessage(request.messages)?.sections?.["bots-resources"] ?? "",
      );
      return text("原生合并继续完成");
    },
  ]);
  process.stdout.write(
    `${JSON.stringify({ root, port: stack.port, bot, heads: parents.map((item) => item.head), baselineCalls })}\n`,
  );
  for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line) as { method: string; contextId?: string };
    if (request.method === "stop") break;
    assert.equal(request.method, "evidence");
    const context =
      request.contextId === undefined
        ? null
        : ((await command("export", {
            contextId: request.contextId,
          })) as HistoryBundle);
    process.stdout.write(
      `${JSON.stringify({ calls: stack.faux?.state.callCount, providerInputs, providerResources, context, originalParentsUnchanged: await Promise.all(parents.map(async (bundle) => JSON.stringify(await command("export", { head: bundle.head })) === JSON.stringify(bundle))), originalToolBytes: await readFile(join(stack.directory.botDir(bot), "workspace/native-once.txt"), "utf8"), records: stack.records.filter((record) => record.level === "error") })}\n`,
    );
  }
} finally {
  await stack.close();
  await rm(root, { recursive: true, force: true });
}
