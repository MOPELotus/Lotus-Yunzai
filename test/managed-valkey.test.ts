import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createStorageClient } from "@lotus-yunzai/storage";
import { ensureManagedValkey, stopManagedValkey } from "../lib/managed-valkey.ts";
import { readStorageConnection } from "../lib/valkey-config.ts";

test.skipIf(!Bun.which("valkey-server"))("项目Valkey独立Socket、真实持久化、重复启动及显式端点优先", async () => {
 const a = await mkdtemp(join(tmpdir(), "lotus-valkey-a-")), b = await mkdtemp(join(tmpdir(), "lotus-valkey-b-"));
 const roots = [a,b].map(path => pathToFileURL(path + "/"));
 try {
  const first = await ensureManagedValkey(roots[0]!, { initialize: true, env: {} });
  const second = await ensureManagedValkey(roots[1]!, { initialize: true, env: {} });
  if (!first.connection || !second.connection) throw new Error("Expected initialized storage");
  expect(first.managed).toBe(true); expect(first.connection).not.toEqual(second.connection);
  expect((await stat(join(a,"data/valkey/managed.json"))).mode & 0o777).toBe(0o600);
  expect(await readStorageConnection(roots[0]!)).toEqual(first.connection);
  const client = createStorageClient(first.connection), isolated = createStorageClient(second.connection);
  client.on("error",()=>{}); isolated.on("error",()=>{});
  await client.connect(); await isolated.connect();
  expect((await client.configGet("port")).port).toBe("0");
  await client.set("private-test", "persisted"); expect(await isolated.get("private-test")).toBeNull();
  await client.disconnect(); await isolated.disconnect();
  const parallel = await Promise.all([ensureManagedValkey(roots[0]!, { env: {} }), ensureManagedValkey(roots[0]!, { env: {} })]);
  expect(parallel.map(item => item.connection)).toEqual([first.connection, first.connection]);
  if (typeof second.connection === "string") throw new Error("Expected managed socket");
  await mkdir(join(a,"config"));
  await writeFile(join(a,"config/redis.yaml"), Bun.YAML.stringify({ socket: second.connection.socketPath, password: second.connection.password }));
  expect((await ensureManagedValkey(roots[0]!, { env: {} })).managed).toBe(false);
  await writeFile(join(a,"config/redis.yaml"), "enable: false\n");
  expect(await ensureManagedValkey(roots[0]!, { env: {} })).toEqual({ managed:false });
  expect(await readStorageConnection(roots[0]!)).toBeUndefined();
  await rm(join(a,"config/redis.yaml"));
  await stopManagedValkey(roots[0]!);
  await ensureManagedValkey(roots[0]!, { env: {} });
  const restored = createStorageClient(first.connection); restored.on("error",()=>{}); await restored.connect();
  expect(await restored.get("private-test")).toBe("persisted"); await restored.disconnect();
  await restored.connect(); await restored.save(); await restored.disconnect();
  const moved = await mkdtemp(join(tmpdir(), "lotus-valkey-moved-")); roots.push(pathToFileURL(moved + "/"));
  await cp(join(a,"data"), join(moved,"data"), { recursive:true });
  await expect(ensureManagedValkey(roots[2]!, { env:{} })).rejects.toThrow("目录已迁移");
  const rebound = await ensureManagedValkey(roots[2]!, { initialize:true, env:{} });
  expect(rebound.connection).not.toEqual(first.connection);
  if (!rebound.connection) throw new Error("Expected rebound connection");
  const migrated = createStorageClient(rebound.connection); migrated.on("error",()=>{}); await migrated.connect();
  expect(await migrated.get("private-test")).toBe("persisted"); await migrated.disconnect();
  await verifyOld();
  async function verifyOld() { const old = createStorageClient(first.connection!); old.on("error",()=>{}); await old.connect(); expect(await old.ping()).toBe("PONG"); await old.disconnect(); }

 } finally {
  for (const root of roots) { await stopManagedValkey(root).catch(()=>{}); }
  for (const root of roots) await rm(root,{recursive:true,force:true});
 }
}, 30_000);


test.skipIf(process.platform !== "linux" || !Bun.which("valkey-server"))("移动目录时拒绝与旧Valkey并写同一持久化目录", async () => {
 const base = await mkdtemp(join(tmpdir(), "lotus-valkey-rename-"));
 const original = join(base,"original"), moved = join(base,"moved");
 await mkdir(original);
 const root = pathToFileURL(original + "/"), destination = pathToFileURL(moved + "/");
 let old: ReturnType<typeof createStorageClient> | undefined;
 try {
  const started = await ensureManagedValkey(root,{initialize:true,env:{}});
  if (!started.connection) throw new Error("Expected initialized storage");
  old = createStorageClient(started.connection); old.on("error",()=>{}); await old.connect();
  await old.set("move-test","preserved");
  const before = await readFile(join(original,"data/valkey/managed.json"),"utf8");
  await rename(original,moved);
  await expect(ensureManagedValkey(destination,{initialize:true,env:{}})).rejects.toThrow("请先停止原实例");
  expect(await readFile(join(moved,"data/valkey/managed.json"),"utf8")).toBe(before);
  expect(await old.ping()).toBe("PONG");
  await old.sendCommand(["SHUTDOWN","SAVE"]).catch(()=>{});
  if (old.isOpen) await old.disconnect();
  old = undefined;
  // The daemon exits asynchronously after disconnecting its clients.
  for (let attempt=0;attempt<30;attempt++) {
   const pid=Number(await readFile(join(moved,"data/valkey/valkey.pid"),"utf8"));
   try { process.kill(pid,0); } catch { break; }
   await Bun.sleep(20);
  }
  const rebound = await ensureManagedValkey(destination,{initialize:true,env:{}});
  if (!rebound.connection) throw new Error("Expected rebound storage");
  const current = createStorageClient(rebound.connection); current.on("error",()=>{}); await current.connect();
  expect(await current.get("move-test")).toBe("preserved"); await current.disconnect();
 } finally {
  if (old?.isOpen) { await old.sendCommand(["SHUTDOWN","SAVE"]).catch(()=>{}); if(old.isOpen)await old.disconnect(); }
  await stopManagedValkey(destination).catch(()=>{}); await stopManagedValkey(root).catch(()=>{});
  await rm(base,{recursive:true,force:true});
 }
},30_000);
