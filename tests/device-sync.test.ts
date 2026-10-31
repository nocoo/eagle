import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { syncCandidates } from "../packages/agent/device-sync.ts";
import {
  SyncAccess,
  SyncAccessResult,
  SyncProofRequest,
  syncProofPayload,
} from "../packages/contracts/src/device-sync.ts";

test("Registry and the independent Bot codec use the same normative sync metadata contract", () => {
  const fixture = JSON.parse(
    readFileSync("fixtures/bots-protocol/sync-access.http.json", "utf8"),
  );
  assert.deepEqual(
    SyncAccess.omit({ sharedBotId: true }).parse(fixture.request),
    fixture.request,
  );
  assert.deepEqual(SyncAccessResult.parse(fixture.response), fixture.response);
});

test("Tailscale discovery uses only bounded Self addresses, logged-out withdrawal and honest failures", async () => {
  const root = mkdtempSync(resolve(".local/device-sync-probe-"));
  const previous = process.env.PATH;
  const binary = join(root, "tailscale");
  const result = (value: unknown, exit = 0) => {
    writeFileSync(
      binary,
      `#!/bin/sh\n[ "$1" = status ] && [ "$2" = --json ] || exit 2\nprintf '%s' '${JSON.stringify(value)}'\nexit ${exit}\n`,
    );
    chmodSync(binary, 0o700);
  };
  try {
    process.env.PATH = root;
    result({
      BackendState: "Running",
      Self: {
        TailscaleIPs: ["100.64.1.2", "fd7a:115c:a1e0::12", "100.64.1.2"],
      },
      Peer: { other: { TailscaleIPs: ["100.64.9.9"] } },
    });
    assert.deepEqual(await syncCandidates(7015), [
      { address: "100.64.1.2", port: 7015 },
      { address: "fd7a:115c:a1e0::12", port: 7015 },
    ]);
    assert.deepEqual(await syncCandidates(null), []);
    result({ BackendState: "NeedsLogin", Self: null }, 1);
    assert.deepEqual(await syncCandidates(7015), []);
    result({
      BackendState: "Running",
      Self: { TailscaleIPs: ["192.168.1.1"] },
    });
    await assert.rejects(syncCandidates(7015));
    result({
      BackendState: "Running",
      Self: { TailscaleIPs: Array(9).fill("100.64.1.2") },
    });
    await assert.rejects(syncCandidates(7015));
    writeFileSync(binary, "#!/bin/sh\nprintf broken\nexit 1\n");
    await assert.rejects(syncCandidates(7015), /tailscale_discovery_failed/);
    writeFileSync(binary, "#!/bin/sh\nprintf broken\n");
    await assert.rejects(syncCandidates(7015));
  } finally {
    process.env.PATH = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("sync proof has one fixed domain, full identity binding and no arbitrary payload fields", () => {
  const fixture = JSON.parse(
    readFileSync("fixtures/bots-protocol/sync-proof.http.json", "utf8"),
  );
  const request = SyncProofRequest.parse(fixture.request);
  assert.equal(syncProofPayload(request), fixture.signingPayload);
  const key = createPublicKey({
    key: Buffer.from(request.reader.publicKey, "base64url"),
    format: "der",
    type: "spki",
  });
  const signature = Buffer.from(fixture.signature, "base64url");
  assert.equal(
    verify(null, Buffer.from(fixture.signingPayload), key, signature),
    true,
  );
  for (const change of [
    { role: "server" },
    { readerNonce: request.serverNonce },
    { sessionId: request.generation },
    { generation: request.sessionId },
    { readerEphemeral: request.serverEphemeral },
    { expiresAt: request.expiresAt + 1 },
    { sharedBotId: "55555555-5555-4555-8555-555555555555" },
    { server: { ...request.server, credentialVersion: 2 } },
  ])
    assert.equal(
      verify(
        null,
        Buffer.from(syncProofPayload({ ...request, ...change })),
        key,
        signature,
      ),
      false,
    );
  for (const change of [
    { payload: "arbitrary" },
    { digest: "caller bytes" },
    { role: "other" },
    { purpose: "execute" },
    { readerNonce: "short" },
    { registryOrigin: "https://device.example/path" },
    { server: request.reader },
    { server: { ...request.server, groupId: null } },
  ])
    assert.throws(() => syncProofPayload({ ...request, ...change }));
});
