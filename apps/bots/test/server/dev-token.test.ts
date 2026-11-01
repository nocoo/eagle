// The development agent token (docs/bots/PROTOCOL.md "CLI clients and scopes"): a bearer
// an agent minted for itself, accepted only while the daemon was told where its file
// is. The file is read again on every authentication, and a file that is not conforming
// is refused rather than repaired.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { WebSocket } from "ws";
import { type Frame, hello, nextFrame, startStack } from "../support/server.ts";

const DEV_TOKEN = "dev-agent-token-0123456789-abcdefghijklmnop";

/**
 * The upgrade's outcome: the socket opened, or the daemon refused it with a status
 * code. A refusal and a silence both end the wait: a socket that never answers must
 * fail the test instead of hanging the suite.
 */
const upgradeOutcome = async (socket: WebSocket, timeoutMs = 5_000): Promise<"open" | number> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      new Promise<"open">((resolve) => socket.once("open", () => resolve("open"))),
      new Promise<number>((resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`the upgrade did not finish within ${timeoutMs} ms`)),
          timeoutMs,
        );
        socket.once("unexpected-response", (_request, response) =>
          resolve(response.statusCode ?? 0),
        );
        socket.once("error", (error: Error) =>
          reject(new Error(`the upgrade failed: ${error.message}`)),
        );
        socket.once("close", (code: number) => reject(new Error(`the socket closed with ${code}`)));
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/** One frame, or a loud failure: a closed socket and a silent one both end the wait. */
const frameOrFail = async (socket: WebSocket, timeoutMs = 5_000): Promise<Frame> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      nextFrame(socket),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`no frame within ${timeoutMs} ms`)), timeoutMs);
        socket.once("error", (error: Error) =>
          reject(new Error(`the socket failed: ${error.message}`)),
        );
        socket.once("close", (code: number) => reject(new Error(`the socket closed with ${code}`)));
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/** A development credential file, as the contract describes it. */
const tokenFile = async (
  content = DEV_TOKEN,
  mode = 0o600,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), "bots-devtoken-"));
  const path = join(dir, "token");
  await writeFile(path, `${content}\n`);
  await chmod(path, mode);
  return { dir, path };
};

const withStack = async (
  options: { readonly devTokenPath?: string },
  body: (stack: Awaited<ReturnType<typeof startStack>>) => Promise<void>,
): Promise<void> => {
  const stack = await startStack(
    options.devTokenPath === undefined ? {} : { devTokenPath: options.devTokenPath },
  );
  try {
    await body(stack);
  } finally {
    await stack.close();
  }
};

test("the development token reads, writes and administers", async () => {
  const { dir, path } = await tokenFile();
  try {
    await withStack({ devTokenPath: path }, async (stack) => {
      const listed = await fetch(`http://127.0.0.1:${stack.port}/v1/bots`, {
        headers: { authorization: `Bearer ${DEV_TOKEN}` },
      });
      assert.equal(listed.status, 200, "a development token reads the catalog");

      const created = await fetch(`http://127.0.0.1:${stack.port}/v1/bots`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${DEV_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ title: "开发代理" }),
      });
      assert.equal(created.status, 201, "a development token writes the catalog");

      const clients = await fetch(`http://127.0.0.1:${stack.port}/v1/clients`, {
        headers: { authorization: `Bearer ${DEV_TOKEN}` },
      });
      assert.equal(clients.status, 200, "a development token administers");
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/v1/clients/me answers the development agent", async () => {
  const { dir, path } = await tokenFile();
  try {
    await withStack({ devTokenPath: path }, async (stack) => {
      const response = await fetch(`http://127.0.0.1:${stack.port}/v1/clients/me`, {
        headers: { authorization: `Bearer ${DEV_TOKEN}` },
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        client: { id: string; name: string; scopes: string[]; createdAt: string };
      };
      assert.equal(body.client.id, "c_dev-agent");
      assert.equal(body.client.name, "dev-agent");
      assert.deepEqual(body.client.scopes, ["read", "write", "admin"]);
      assert.equal(
        body.client.createdAt,
        (await stat(path)).mtime.toISOString(),
        "the identity is born when the file was written",
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a wrong bearer is refused while a development token works", async () => {
  const { dir, path } = await tokenFile();
  try {
    await withStack({ devTokenPath: path }, async (stack) => {
      const refused = await fetch(`http://127.0.0.1:${stack.port}/v1/bots`, {
        headers: { authorization: "Bearer wrong-token-0123456789-abcdefghijkl" },
      });
      assert.equal(refused.status, 401, "a wrong bearer is refused");
      const body = (await refused.json()) as { error?: { kind?: string } };
      assert.equal(body.error?.kind, "auth_failed");
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("without the environment variable the file is ignored", async () => {
  const { dir } = await tokenFile();
  try {
    await withStack({}, async (stack) => {
      const refused = await fetch(`http://127.0.0.1:${stack.port}/v1/bots`, {
        headers: { authorization: `Bearer ${DEV_TOKEN}` },
      });
      assert.equal(
        refused.status,
        401,
        "a development token is never accepted when the daemon was not told about it",
      );
      const owner = await fetch(`http://127.0.0.1:${stack.port}/v1/bots`, {
        headers: { authorization: `Bearer ${stack.token}` },
      });
      assert.equal(owner.status, 200, "the daemon's own token is untouched");
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a file with loose permissions is refused and warns at startup", async () => {
  const { dir, path } = await tokenFile(DEV_TOKEN, 0o644);
  try {
    await withStack({ devTokenPath: path }, async (stack) => {
      const refused = await fetch(`http://127.0.0.1:${stack.port}/v1/bots`, {
        headers: { authorization: `Bearer ${DEV_TOKEN}` },
      });
      assert.equal(refused.status, 401, "a file that is not 0600 is refused");
      const warned = stack.records.filter((record) => record.evt === "transport.devtoken.unsafe");
      assert.equal(warned.length, 1, "startup warns once about the unsafe file");
      assert.equal(warned[0]?.level, "warn");
      assert.equal(warned[0]?.detail?.reason, "invalid");
      assert.equal(
        stack.records.filter((record) => record.evt === "transport.devtoken.ok").length,
        0,
        "an unsafe file is never armed",
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a short token is refused", async () => {
  const { dir, path } = await tokenFile("too-short");
  try {
    await withStack({ devTokenPath: path }, async (stack) => {
      const refused = await fetch(`http://127.0.0.1:${stack.port}/v1/bots`, {
        headers: { authorization: "Bearer too-short" },
      });
      assert.equal(refused.status, 401, "fewer than 32 characters is not a credential");
      assert.equal(
        stack.records.filter((record) => record.evt === "transport.devtoken.ok").length,
        0,
        "a short file is never armed",
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a file that is missing, or is not a file, is refused", async () => {
  const { dir } = await tokenFile();
  try {
    await withStack({ devTokenPath: join(dir, "missing") }, async (stack) => {
      const refused = await fetch(`http://127.0.0.1:${stack.port}/v1/bots`, {
        headers: { authorization: `Bearer ${DEV_TOKEN}` },
      });
      assert.equal(refused.status, 401, "a missing file is no credential");
      assert.equal(
        stack.records.filter((record) => record.evt === "transport.devtoken.unsafe").length,
        1,
        "startup warns once about the missing file",
      );
    });
    await withStack({ devTokenPath: dir }, async (stack) => {
      const refused = await fetch(`http://127.0.0.1:${stack.port}/v1/bots`, {
        headers: { authorization: `Bearer ${DEV_TOKEN}` },
      });
      assert.equal(refused.status, 401, "a directory is no credential");
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a FIFO at the path is refused instead of blocking the daemon", async () => {
  const { dir } = await tokenFile();
  const path = join(dir, "token");
  try {
    await rm(path);
    execFileSync("/usr/bin/mkfifo", ["-m", "600", path]);
    await withStack({ devTokenPath: path }, async (stack) => {
      // No writer will ever open this FIFO: a blocking read would hold the request for
      // good, so the answer has to arrive on its own.
      const refused = await fetch(`http://127.0.0.1:${stack.port}/v1/bots`, {
        headers: { authorization: `Bearer ${DEV_TOKEN}` },
        signal: AbortSignal.timeout(2_000),
      });
      assert.equal(refused.status, 401, "a FIFO is no credential");
      const health = await fetch(`http://127.0.0.1:${stack.port}/v1/health`);
      assert.equal(health.status, 200, "the daemon still answers");
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a rewritten file takes effect at once", async () => {
  const { dir, path } = await tokenFile();
  const next = "next-dev-agent-token-0123456789-abcdefghijk";
  try {
    await withStack({ devTokenPath: path }, async (stack) => {
      await writeFile(path, `${next}\n`);
      await chmod(path, 0o600);
      const accepted = await fetch(`http://127.0.0.1:${stack.port}/v1/bots`, {
        headers: { authorization: `Bearer ${next}` },
      });
      assert.equal(accepted.status, 200, "the new bearer works without a restart");
      const refused = await fetch(`http://127.0.0.1:${stack.port}/v1/bots`, {
        headers: { authorization: `Bearer ${DEV_TOKEN}` },
      });
      assert.equal(refused.status, 401, "the old bearer stops working");
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the upgrade accepts the development token", async () => {
  const { dir, path } = await tokenFile();
  try {
    await withStack({ devTokenPath: path }, async (stack) => {
      const socket = stack.connect({ token: DEV_TOKEN });
      try {
        const outcome = await upgradeOutcome(socket);
        assert.equal(outcome, "open", "the development token is accepted for the upgrade");
        socket.send(JSON.stringify(hello));
        const welcome = await frameOrFail(socket);
        assert.equal(welcome.type, "welcome", "the socket is accepted");
      } finally {
        socket.terminate();
      }
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the upgrade refuses a wrong bearer with 401", async () => {
  const { dir, path } = await tokenFile();
  try {
    await withStack({ devTokenPath: path }, async (stack) => {
      const socket = stack.connect({ token: "wrong-token-0123456789-abcdefghijkl" });
      try {
        assert.equal(
          await upgradeOutcome(socket),
          401,
          "a wrong bearer is refused before the upgrade",
        );
      } finally {
        socket.terminate();
      }
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
