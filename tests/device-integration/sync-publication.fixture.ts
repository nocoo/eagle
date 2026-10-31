// Owned parent bridge for the public Swift Supervisor test; no credentials on argv/HTTP.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import {
  deviceProcess,
  localCall,
  processPort,
  workerFixture,
} from "./device-fixtures.ts";

const root = mkdtempSync("/tmp/eagle-publication-");
const workerRoot = mkdtempSync(resolve(".local/publication-worker-"));
const worker = await workerFixture(workerRoot);
const cli = join(root, "cli");
mkdirSync(cli);
writeFileSync(
  join(cli, "tailscale"),
  `#!/bin/sh\nprintf '%s' '{"BackendState":"Running","Self":{"TailscaleIPs":["100.64.1.1"]}}'\n`,
);
chmodSync(join(cli, "tailscale"), 0o700);
const grantor = deviceProcess(join(root, "grantor"), worker.origin, cli);
const reader = deviceProcess(join(root, "reader"), worker.origin);
await Promise.all([grantor.ready(), reader.ready()]);
const sharedBotId = randomUUID();
const botsRoot = join(root, "bots");
mkdirSync(botsRoot);
const script = join(root, "bots.mjs");
writeFileSync(
  script,
  `
import {Server} from 'node:net';
import {createInterface} from 'node:readline';
const lines=createInterface({input:process.stdin});const input=lines[Symbol.asyncIterator]();
const config=JSON.parse((await input.next()).value);
const original=Server.prototype.listen;
Server.prototype.listen=function(options,...rest){
 if(options?.host==='100.64.1.1')options={...options,host:'127.0.0.1'};
 return Reflect.apply(original,this,[options,...rest]);
};
const {startDaemon}=await import(config.main);const {readConfig}=await import(config.config);
const daemon=await startDaemon(readConfig({argv:['--root',config.root,'--port','0','--sync-port','0'],env:{BOTS_DEVICE_SOCKET:config.socket}}));
console.log(JSON.stringify({type:'ready',port:daemon.port}));
let stopping=false;
async function stop(){if(stopping)return;stopping=true;await daemon.close();process.exit(0);}
process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
await input.next();await stop();
`,
);
const bots = processPort(script, root);
bots.send({
  main: new URL("../../apps/bots/src/main.ts", import.meta.url).href,
  config: new URL("../../apps/bots/src/config.ts", import.meta.url).href,
  root: botsRoot,
  socket: grantor.socketPath,
});
const ready = await bots.message((message) => message.type === "ready");
let publications = 0;
let lastPort: unknown;
let lastDigest: unknown;
const bridge = createServer(async (request, response) => {
  try {
    let result: unknown;
    if (request.url === "/publish" && request.method === "POST") {
      let text = "";
      for await (const chunk of request) text += chunk;
      const input = JSON.parse(text) as {
        syncPort: number | null;
        expectedSelfDigest?: string;
      };
      result = await grantor.manage("sync.endpoints.publish", input);
      if (input.syncPort !== null) {
        publications++;
        lastPort = input.syncPort;
        lastDigest = input.expectedSelfDigest;
      }
    } else if (request.url === "/pair" && request.method === "POST") {
      const invitation = await grantor.manage("pairing.create", {});
      await reader.manage("pairing.redeem", {
        requestId: randomUUID(),
        code: invitation.code,
      });
      result = await grantor.manage("sync.share", {
        sharedBotId,
        peerDeviceId: reader.deviceId,
        enabled: true,
      });
    } else if (request.url === "/access") {
      result = await localCall(reader.socketPath, "sync.access", {
        sharedBotId,
        peerDeviceId: grantor.deviceId,
        purpose: "replica.read",
      });
    } else if (request.url === "/revoke" && request.method === "POST") {
      result = await grantor.manage("member.remove", {
        deviceId: reader.deviceId,
      });
    } else {
      assert.equal(request.url, "/state");
      const identity = (await localCall(
        grantor.socketPath,
        "sync.identity",
      )) as { identity: { groupId: string | null } };
      result = {
        publications,
        lastPort,
        lastDigest,
        groupId: identity.identity.groupId,
        pid: bots.child.pid,
      };
    }
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(result));
  } catch (error) {
    response.writeHead(403, { "content-type": "application/json" }).end(
      JSON.stringify({
        error: error instanceof Error ? error.message : "refused",
      }),
    );
  }
});
await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
const address = bridge.address();
assert(address && typeof address !== "string");
console.log(
  JSON.stringify({
    bridge: `http://127.0.0.1:${address.port}`,
    root: botsRoot,
    port: ready.port,
    pid: bots.child.pid,
    socket: grantor.socketPath,
  }),
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  bridge.closeAllConnections();
  await new Promise<void>((resolve) => bridge.close(() => resolve()));
  await bots.stop();
  await Promise.all([grantor.stop(), reader.stop()]);
  await worker.mf.dispose();
  rmSync(root, { recursive: true, force: true });
  rmSync(workerRoot, { recursive: true, force: true });
  process.exit(0);
}
process.stdin.resume();
process.stdin.once("end", () => void stop());
process.once("SIGTERM", () => void stop());
