// The secrets routes (docs/bots/PROTOCOL.md, "Secrets"): the card answer, the metadata
// list, the one route that answers a value, and the delete. No response ever echoes a value.
import assert from "node:assert/strict";
import test from "node:test";
import type { Message, Submission } from "../../src/core/domain.ts";
import { SecretsStorageError } from "../../src/core/domain.ts";
import type {
  RuntimeBotSpec,
  RuntimeHandle,
  RuntimeHistory,
  RuntimePort,
  RuntimeSubscription,
  SubmitInput,
} from "../../src/core/RuntimePort.ts";
import { SecretsStore } from "../../src/secrets/store.ts";
import type { SecretsApi } from "../../src/server/http.ts";
import { startStack } from "../support/server.ts";

const card = (args: Record<string, unknown>): Message => ({
  id: "e_card_1",
  role: "assistant",
  state: "complete",
  createdAt: "2026-11-03T01:10:00.000Z",
  blocks: [
    { type: "text", text: "我需要一个密码。" },
    { type: "toolCall", callId: "c_1", name: "secret_request", args },
  ],
});

/** A runtime whose transcript holds one secret card, and that remembers what it was told. */
class CardRuntime implements RuntimePort {
  readonly submitted: SubmitInput[] = [];
  readonly #message: Message | undefined;

  constructor(message: Message | undefined) {
    this.#message = message;
  }

  async open(spec: RuntimeBotSpec): Promise<RuntimeHandle> {
    const runtime = this;
    const snapshot = {
      botId: spec.id,
      messages: [],
      streaming: null,
      pending: [],
      inbox: [],
      running: false,
    };
    return {
      async refreshTools() {},
      async subscribe(): Promise<RuntimeSubscription> {
        return { snapshot, detach: () => undefined };
      },
      async submit(input: SubmitInput): Promise<Submission> {
        runtime.submitted.push(input);
        return { id: "s_1", requestId: input.requestId, status: "placed" };
      },
      async submission() {
        return undefined;
      },
      async entryById(entryId: string): Promise<Message | undefined> {
        if (runtime.#message === undefined) return undefined;
        return runtime.#message.id === entryId ? runtime.#message : undefined;
      },
      async history(): Promise<RuntimeHistory> {
        return { messages: [], hasMore: false };
      },
      async abort() {},
      async recover() {},
      async busy() {
        return { run: false, tasks: false };
      },
      async close() {
        return "closed" as const;
      },
    };
  }
}

const call = async (
  stack: { port: number; token: string },
  path: string,
  init: { method?: string; body?: unknown; token?: string } = {},
) =>
  fetch(`http://127.0.0.1:${stack.port}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${init.token ?? stack.token}`,
      "content-type": "application/json",
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

test("the card answer stores the value and never echoes it", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "bots-secret-http-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secrets = await SecretsStore.open({
    dir: join(root, "config"),
    keyPath: join(root, "state", "secrets.key"),
  });
  const runtime = new CardRuntime(
    card({ key: "github-pat", purpose: "发布 Eagle 用", scope: "bot", ttlMinutes: 60 }),
  );
  const stack = await startStack({
    runtime,
    secrets: { save: (input) => secrets.save(input) },
    secretsApi: {
      list: () => secrets.listAll(),
      reveal: (input) => secrets.reveal(input),
      remove: (input) => secrets.removeAsPerson(input),
    },
  });
  try {
    const botId = await stack.createBot("发布助手");
    const response = await call(stack, `/v1/bots/${botId}/secrets`, {
      method: "POST",
      body: { entryId: "e_card_1", key: "github-pat", value: "ghp_example", scope: "bot" },
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(text.includes("ghp_example"), false, "the response never echoes a value");
    const body = JSON.parse(text) as { submission: { status: string } };
    assert.equal(body.submission.status, "placed");

    const stored = await secrets.read({ botId, key: "github-pat" });
    assert.equal(stored?.value, "ghp_example", "the value is in the store, not the transcript");

    const hidden = runtime.submitted.at(-1);
    assert.ok(hidden, "the answer was admitted");
    assert.equal(hidden.hidden, true, "the answer is a hidden message");
    assert.equal(hidden.answersTo, "e_card_1");
    assert.equal(hidden.text.includes("ghp_example"), false, "the hidden message holds no value");
    assert.match(hidden.text, /github-pat/);
    assert.match(hidden.text, /expires in 1 hour/);
  } finally {
    await stack.close();
  }
});

test("an answer whose key is not the card's is refused", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "bots-secret-http-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secrets = await SecretsStore.open({
    dir: join(root, "config"),
    keyPath: join(root, "state", "secrets.key"),
  });
  const runtime = new CardRuntime(card({ key: "github-pat", purpose: "发布用" }));
  const stack = await startStack({
    runtime,
    secrets: { save: (input) => secrets.save(input) },
    secretsApi: {
      list: () => secrets.listAll(),
      reveal: (input) => secrets.reveal(input),
      remove: (input) => secrets.removeAsPerson(input),
    },
  });
  try {
    const botId = await stack.createBot("发布助手");
    const mismatch = await call(stack, `/v1/bots/${botId}/secrets`, {
      method: "POST",
      body: { entryId: "e_card_1", key: "other-key", value: "ghp_example" },
    });
    assert.equal(mismatch.status, 400);
    assert.equal((await mismatch.text()).includes("ghp_example"), false);

    const unknown = await call(stack, `/v1/bots/${botId}/secrets`, {
      method: "POST",
      body: { entryId: "e_nope", key: "github-pat", value: "ghp_example" },
    });
    assert.equal(unknown.status, 400);

    const empty = await call(stack, `/v1/bots/${botId}/secrets`, {
      method: "POST",
      body: { entryId: "e_card_1", key: "github-pat", value: "" },
    });
    assert.equal(empty.status, 400);
    assert.deepEqual(await secrets.listAll(), [], "nothing was stored");
  } finally {
    await stack.close();
  }
});

test("the list answers metadata only, and the reveal is the one route with a value", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "bots-secret-http-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secrets = await SecretsStore.open({
    dir: join(root, "config"),
    keyPath: join(root, "state", "secrets.key"),
  });
  await secrets.save({
    botId: "b_1",
    key: "github-pat",
    value: "ghp_example",
    scope: "shared",
    purpose: "发布用",
  });
  const stack = await startStack({
    secretsApi: {
      list: () => secrets.listAll(),
      reveal: (input) => secrets.reveal(input),
      remove: (input) => secrets.removeAsPerson(input),
    },
  });
  try {
    const listed = await call(stack, "/v1/secrets");
    assert.equal(listed.status, 200);
    const text = await listed.text();
    assert.equal(text.includes("ghp_example"), false, "the list never carries a value");
    const body = JSON.parse(text) as { secrets: { key: string; scope: string }[] };
    assert.deepEqual(
      body.secrets.map((entry) => entry.key),
      ["github-pat"],
    );
    assert.equal(body.secrets[0]?.scope, "shared");

    const revealed = await call(stack, "/v1/secrets/reveal", {
      method: "POST",
      body: { key: "github-pat", scope: "shared" },
    });
    assert.equal(revealed.status, 200);
    const secret = (await revealed.json()) as { secret: { value: string } };
    assert.equal(secret.secret.value, "ghp_example");

    const missing = await call(stack, "/v1/secrets/reveal", {
      method: "POST",
      body: { key: "absent", scope: "shared" },
    });
    assert.equal(missing.status, 404);
  } finally {
    await stack.close();
  }
});

test("revealing and deleting need the admin scope", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "bots-secret-http-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secrets = await SecretsStore.open({
    dir: join(root, "config"),
    keyPath: join(root, "state", "secrets.key"),
  });
  await secrets.save({ botId: "b_1", key: "github-pat", value: "ghp_example", scope: "shared" });
  const stack = await startStack({
    secretsApi: {
      list: () => secrets.listAll(),
      reveal: (input) => secrets.reveal(input),
      remove: (input) => secrets.removeAsPerson(input),
    },
  });
  try {
    const created = await call(stack, "/v1/clients", {
      method: "POST",
      body: { name: "reader", scopes: ["read"] },
    });
    assert.equal(created.status, 201);
    const issued = (await created.json()) as { token: string };

    const reveal = await call(stack, "/v1/secrets/reveal", {
      method: "POST",
      body: { key: "github-pat", scope: "shared" },
      token: issued.token,
    });
    assert.equal(reveal.status, 403);
    assert.equal((await reveal.text()).includes("ghp_example"), false);

    const removed = await call(stack, "/v1/secrets/shared/github-pat", {
      method: "DELETE",
      token: issued.token,
    });
    assert.equal(removed.status, 403);
    assert.equal((await secrets.listAll()).length, 1, "nothing was deleted");

    const byAdmin = await call(stack, "/v1/secrets/shared/github-pat", { method: "DELETE" });
    assert.equal(byAdmin.status, 204);
    assert.deepEqual(await secrets.listAll(), []);

    const again = await call(stack, "/v1/secrets/shared/github-pat", { method: "DELETE" });
    assert.equal(again.status, 404);
  } finally {
    await stack.close();
  }
});

test("a store that cannot be read is a 503, not an empty list", async () => {
  const broken: SecretsApi = {
    list: () => {
      throw new SecretsStorageError("the secrets container could not be decrypted");
    },
    reveal: () => {
      throw new SecretsStorageError("the secrets container could not be decrypted");
    },
    remove: () => {
      throw new SecretsStorageError("the secrets container could not be decrypted");
    },
  };
  const stack = await startStack({ secretsApi: broken });
  try {
    const listed = await call(stack, "/v1/secrets");
    assert.equal(listed.status, 503);
    const text = await listed.text();
    const body = JSON.parse(text) as { error: { kind: string } };
    assert.equal(body.error.kind, "storage_failed");
    assert.equal(
      text.includes("could not be decrypted"),
      false,
      "the refusal does not carry the detail",
    );
  } finally {
    await stack.close();
  }
});
