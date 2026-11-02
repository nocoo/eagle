// The decision probe (docs/bots/PROTOCOL.md, "Providers"): one real System One call proves the
// relay, the key, the model name and the answer shape at once, because the relays disagree on
// every one of those and a model listing cannot tell them apart.
import assert from "node:assert/strict";
import test from "node:test";
import { decisionRoot, probeDecision } from "../../src/server/decision.ts";

const answer = (body: Record<string, unknown>) => Response.json(body);

const chooser = (choice: string, confidence = 0.62) =>
  answer({
    model: "jev-1.14.0",
    answers: {
      next_step: {
        type: "choice",
        choice,
        confidence,
        probabilities: { test: confidence, merge: 1 - confidence },
      },
    },
    usage: { input_tokens: 271, output_tokens: 20 },
  });

test("one minimal choice call proves the route and reports the resolved model", async () => {
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  const probe = await probeDecision(
    { baseUrl: "http://127.0.0.1:3425", model: "typesafe/jev-latest", apiKey: "relay-key" },
    {
      fetch: async (url, init) => {
        seen.push({ url: String(url), init });
        return chooser("test");
      },
    },
  );
  assert.equal(seen.length, 1, "a probe is one call");
  assert.equal(seen[0]?.url, "http://127.0.0.1:3425/v1/systemone");
  assert.equal(seen[0]?.init?.method, "POST");
  assert.equal(new Headers(seen[0]?.init?.headers).get("authorization"), "Bearer relay-key");
  const body = JSON.parse(String(seen[0]?.init?.body)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ["model", "questions", "state"]);
  assert.equal(body.model, "typesafe/jev-latest");
  assert.equal(typeof body.state, "string");
  const question = (body.questions as Record<string, Record<string, unknown>>).next_step;
  assert.equal(question?.type, "choice");
  assert.deepEqual(Object.keys(question?.criteria as object).sort(), ["merge", "test"]);
  assert.equal(probe.ok, true);
  assert.equal(probe.model, "typesafe/jev-latest");
  assert.equal(probe.resolvedModel, "jev-1.14.0");
  assert.match(probe.message, /jev-1\.14\.0/);
  assert.match(probe.message, /test/);
});

test("an address typed with /v1 or /v1/systemone is the same root", async () => {
  assert.equal(decisionRoot("http://relay.test"), "http://relay.test");
  assert.equal(decisionRoot("http://relay.test/"), "http://relay.test");
  assert.equal(decisionRoot("http://relay.test/v1"), "http://relay.test");
  assert.equal(decisionRoot("http://relay.test/v1/"), "http://relay.test");
  assert.equal(decisionRoot("http://relay.test/v1/systemone"), "http://relay.test");
  assert.equal(decisionRoot("https://api.typesafe.ai"), "https://api.typesafe.ai");
  assert.equal(decisionRoot("relay.test"), undefined, "a root is an absolute http(s) URL");
  assert.equal(decisionRoot("ftp://relay.test"), undefined);
  const urls: string[] = [];
  await probeDecision(
    { baseUrl: "http://relay.test/v1", model: "jev-latest", apiKey: "" },
    {
      fetch: async (url) => {
        urls.push(String(url));
        return chooser("merge");
      },
    },
  );
  assert.deepEqual(urls, ["http://relay.test/v1/systemone"]);
});

test("a relay that supplies its own upstream key needs no key here", async () => {
  const headers: (string | null)[] = [];
  const probe = await probeDecision(
    { baseUrl: "http://127.0.0.1:3425", model: "typesafe/jev-latest", apiKey: "" },
    {
      fetch: async (_url, init) => {
        headers.push(new Headers(init?.headers).get("authorization"));
        return chooser("test");
      },
    },
  );
  assert.deepEqual(headers, [null]);
  assert.equal(probe.ok, true);
});

test("a refused key is an authentication failure, not a decision", async () => {
  const probe = await probeDecision(
    { baseUrl: "https://api.typesafe.ai", model: "jev-latest", apiKey: "bad" },
    { fetch: async () => new Response("no", { status: 401 }) },
  );
  assert.equal(probe.ok, false);
  assert.match(probe.message, /拒绝|Key/);
  assert.equal(probe.model, undefined);
});

test("an upstream status is reported as itself", async () => {
  const probe = await probeDecision(
    { baseUrl: "http://127.0.0.1:3425", model: "raven-jp1/microsoft-decision-1", apiKey: "" },
    {
      fetch: async () =>
        Response.json({ error: { message: "magpie knows no Jev model" } }, { status: 404 }),
    },
  );
  assert.equal(probe.ok, false);
  assert.match(probe.message, /404/);
});

test("an answer outside the criteria is not a usable decision", async () => {
  for (const body of [
    chooser("ship"),
    Response.json({ answers: { next_step: { type: "noul", noul: 0.4 } }, model: "jev" }),
    Response.json({ answers: {}, model: "jev" }),
    Response.json({ model: "jev" }),
    new Response("<html>gateway</html>", { status: 200 }),
  ]) {
    const probe = await probeDecision(
      { baseUrl: "http://relay.test", model: "jev-latest", apiKey: "k" },
      { fetch: async () => body.clone() },
    );
    assert.equal(probe.ok, false);
    assert.match(probe.message, /决策|不合法/, JSON.stringify(await body.text()));
  }
});

test("a timeout is a reachability failure and does not claim a decision", async () => {
  const probe = await probeDecision(
    { baseUrl: "http://relay.test", model: "jev-latest", apiKey: "k" },
    {
      timeoutMs: 10,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    },
  );
  assert.equal(probe.ok, false);
  assert.match(probe.message, /超时/);
});

test("an answer that names no model reports none instead of the request alias", async () => {
  const probe = await probeDecision(
    { baseUrl: "http://relay.test", model: "jev-latest", apiKey: "k" },
    {
      fetch: async () =>
        Response.json({ answers: { next_step: { choice: "merge", type: "choice" } } }),
    },
  );
  assert.equal(probe.ok, true);
  assert.equal(probe.resolvedModel, undefined, "an unnamed model is not evidence");
  assert.equal(probe.model, "jev-latest");
  assert.equal(probe.message, "连接成功 · merge");
});

test("a stored address that is not a URL fails without a request", async () => {
  let asked = false;
  const probe = await probeDecision(
    { baseUrl: "relay.test", model: "jev-latest", apiKey: "k" },
    {
      fetch: async () => {
        asked = true;
        return chooser("test");
      },
    },
  );
  assert.equal(probe.ok, false);
  assert.match(probe.message, /http/);
  assert.equal(asked, false);
});

// The address is echoed back by the settings page, so a credential inside it would be a key in
// plain sight; a query or a fragment cannot carry the appended `/v1/systemone` either.
test("an address carrying credentials, a query or a fragment is refused", async () => {
  for (const baseUrl of [
    "http://user:secret-key@relay.test/v1",
    "http://relay.test/v1?region=local",
    "http://relay.test/v1#frag",
  ]) {
    assert.equal(decisionRoot(baseUrl), undefined, baseUrl);
    let asked = false;
    const probe = await probeDecision(
      { baseUrl, model: "jev-latest", apiKey: "k" },
      {
        fetch: async () => {
          asked = true;
          return chooser("test");
        },
      },
    );
    assert.equal(probe.ok, false, baseUrl);
    assert.equal(asked, false, "a refused address never reaches the network");
  }
});

test("an answer that is not a distribution over the criteria is not usable", async () => {
  for (const body of [
    // A prototype name is not one of the criteria.
    Response.json({ model: "jev", answers: { next_step: { type: "choice", choice: "toString" } } }),
    // Scores that do not sum to one are not probabilities.
    Response.json({
      model: "jev",
      answers: {
        next_step: {
          type: "choice",
          choice: "test",
          probabilities: { test: 0.9, merge: 0.9 },
        },
      },
    }),
    Response.json({
      model: "jev",
      answers: {
        next_step: {
          type: "choice",
          choice: "test",
          probabilities: { test: 0.6, merge: 0.4 },
          confidence: "0.6",
        },
      },
    }),
  ]) {
    const probe = await probeDecision(
      { baseUrl: "http://relay.test", model: "jev-latest", apiKey: "k" },
      { fetch: async () => body.clone() },
    );
    assert.equal(probe.ok, false, await body.clone().text());
    assert.match(probe.message, /决策/);
  }
});
