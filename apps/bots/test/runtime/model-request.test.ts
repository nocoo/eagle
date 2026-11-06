// The reasoning level the daemon actually sends (docs/bots/RUNTIME.md, "The model
// registry"): a real Responses HTTP request against a local endpoint that records the
// body, so `xhigh` and `max` are proved on the wire and not only in a faux snapshot.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { ModelRegistry } from "../../src/runtime/pi/models.ts";

const frame = (type: string, body: unknown): string =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...(body as object) })}\n\n`;

const opening = (id: string): string =>
  frame("response.created", { response: { id, status: "in_progress" } }) +
  frame("response.output_item.added", {
    output_index: 0,
    item: { type: "message", id: `msg_${id}`, role: "assistant", content: [] },
  });

const finish = (id: string, text: string): string => {
  const output = {
    type: "message",
    id: `msg_${id}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return (
    frame("response.output_text.done", { output_index: 0, item_id: `msg_${id}`, text }) +
    frame("response.output_item.done", { output_index: 0, item: output }) +
    frame("response.completed", {
      response: {
        id,
        status: "completed",
        output: [output],
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      },
    })
  );
};

type Captured = { readonly model?: string; readonly reasoning?: { effort?: string } };

const captureServer = async (): Promise<{
  readonly baseUrl: string;
  readonly bodies: Captured[];
  close(): Promise<void>;
}> => {
  const bodies: Captured[] = [];
  let sequence = 0;
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method !== "POST") {
        response.writeHead(404).end();
        return;
      }
      bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Captured);
      sequence += 1;
      const text = "巴黎是法国的首都。";
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.write(opening(`resp_${sequence}`));
      response.end(finish(`resp_${sequence}`, text));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    bodies,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
};

test("xhigh and max reach the gateway as they are, never lowered", async () => {
  const endpoint = await captureServer();
  try {
    const registry = new ModelRegistry({
      provider: "magpie",
      baseUrl: endpoint.baseUrl,
      apiKey: "sk-wire-0000000000000000",
      contextWindow: 200_000,
      maxTokens: 8_192,
    });
    registry.ensure(["auto/gpt-6-luna"]);
    const models = registry.models;
    const model = models.getModel("magpie", "auto/gpt-6-luna");
    assert.ok(model !== undefined, "the stored model is registered");
    const context = {
      messages: [{ role: "user" as const, content: "法国的首都是哪里？", timestamp: Date.now() }],
    };
    for (const level of ["xhigh", "max"] as const) {
      await models.completeSimple(model, context, { reasoning: level });
      const sent = endpoint.bodies.at(-1);
      assert.equal(sent?.model, "auto/gpt-6-luna", "the request names the bot's own model");
      assert.equal(
        sent?.reasoning?.effort,
        level,
        `${level} is requested as ${level}, not lowered to high`,
      );
    }
    await models.completeSimple(model, context, {});
    assert.equal(
      endpoint.bodies.at(-1)?.reasoning?.effort,
      "none",
      "off sends the gateway's no-effort value, not a level",
    );
  } finally {
    await endpoint.close();
  }
});
