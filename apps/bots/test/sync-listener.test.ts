import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readConfig } from "../src/config.ts";

test("dedicated sync port is absent by default and explicitly accepts zero without changing management", () => {
  assert.equal(readConfig({ argv: [], env: {} }).syncPort, undefined);
  assert.equal(readConfig({ argv: ["--sync-port", "0"], env: {} }).syncPort, 0);
  assert.equal(readConfig({ argv: [], env: { BOTS_SYNC_PORT: "43119" } }).syncPort, 43119);
  for (const value of ["", "-1", "65536", "1.5", "0.0.0.0"])
    assert.throws(() => readConfig({ argv: ["--sync-port", value], env: {} }));
  assert.throws(() => readConfig({ argv: ["--sync-port"], env: {} }));
});

test("Self listener binds the complete set or none, fences discovery changes and drains on loss/close", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-self-listener-"));
  // Only the owned child maps fixture Tailscale hosts onto real local TCP sockets.
  // Product discovery/listen/handler are unchanged; this is not physical-interface proof.
  const script = `
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Server} from 'node:net';
import {SyncListener} from ${JSON.stringify(new URL("../src/sync-listener.ts", import.meta.url).href)};
import {AuthenticatedSync} from ${JSON.stringify(new URL("../src/sync-pull.ts", import.meta.url).href)};
import {BotRegistry} from ${JSON.stringify(new URL("../src/core/BotRegistry.ts", import.meta.url).href)};
import {BotDirectory,nodeDirectoryFs} from ${JSON.stringify(new URL("../src/core/BotDirectory.ts", import.meta.url).href)};
import {captureLog} from ${JSON.stringify(new URL("../src/log/log.ts", import.meta.url).href)};
const root=${JSON.stringify(dir)};
const {log,records}=captureLog();
const registry=new BotRegistry({directory:new BotDirectory(root,await nodeDirectoryFs()),openRuntime:()=>{throw new Error('must not open SDK')},model:{provider:'none',modelId:'none'},log,idleCloseMs:1000,quarantineRetryMs:1000,closeDeadlineMs:1000});
let addresses=[], fence=false, waiting;
const self=values=>({version:1,addresses:values,digest:createHash('sha256').update(JSON.stringify(values)).digest('hex')});
const device={version:1,self:async()=>{
 if(waiting)await waiting;
 const result=self(addresses);
 if(fence){fence=false;addresses=[];}
 return result;
},identity:()=>{throw new Error('not used')},access:()=>{throw new Error('not used')}};
const sync=new AuthenticatedSync({registry,device,log});
const listener=new SyncListener(sync,device,0,log);
const binds=[]; const original=Server.prototype.listen;
let collide=false;
Server.prototype.listen=function(options,...rest){
 if(options&&typeof options==='object'&&['100.64.1.1','100.64.1.2'].includes(options.host)){
  binds.push({host:options.host,port:options.port});
  options={...options,host:collide?'127.0.0.1':options.host==='100.64.1.1'?'127.0.0.1':'::1'};
 }
 return Reflect.apply(original,this,[options,...rest]);
};
try {
 await listener.refresh(); assert.equal(sync.status().ready,false);assert.equal(binds.length,0);
 addresses=['127.0.0.1'];await listener.refresh();assert.equal(binds.length,0);assert.equal(sync.status().ready,false);
 addresses=['100.64.1.1','100.64.1.2'];await listener.refresh();
 assert.equal(sync.status().ready,true);const port=sync.status().actualPort;
 assert.deepEqual(binds,[{host:'100.64.1.1',port:0},{host:'100.64.1.2',port}]);
 const bad=await fetch('http://127.0.0.1:'+port+'/v1/bots/arbitrary/run',{method:'POST'});
 assert.equal(bad.status,403,'listener never proxies local run/management');await bad.text();
 addresses=[];await listener.refresh();assert.equal(sync.status().ready,false);
 await assert.rejects(fetch('http://127.0.0.1:'+port+'/v1/sync/page',{method:'POST'}));
 addresses=['100.64.1.1','100.64.1.2'];collide=true;await listener.refresh();assert.equal(sync.status().ready,false,'second bind failure publishes no partial set');
 collide=false;fence=true;await listener.refresh();assert.equal(sync.status().ready,false,'Self changed across bind');
 addresses=['100.64.1.1','100.64.1.2'];await listener.refresh();assert.equal(sync.status().ready,true);
 let release;waiting=new Promise(resolve=>release=resolve);const refreshing=listener.refresh();
 const closed=listener.close();assert.equal(sync.status().ready,false);release();await Promise.all([closed,refreshing]);assert.equal(sync.status().ready,false);
 assert(records.some(row=>row.err?.origin&&row.evt==='runtime.sync.fail'));
 console.log('owned-self-bind: all-set, no partial bind, discovery fence, loss, drain; no SDK opened');
} finally {await listener.close();Server.prototype.listen=original;}
`;
  const path = join(dir, "listener.mjs");
  await writeFile(path, script);
  try {
    const child = spawn(process.execPath, [path], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const exit = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(exit, 0, output);
    assert.match(output, /owned-self-bind/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
