import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createStorageClient, type StorageConnectionOptions } from "@lotus-yunzai/storage";
import { ensureLegacyValkey, prepareLegacyValkeyHandoff, publishLegacyValkeyHandoff, quiesceLegacyValkeyHandoff, resumeLegacyValkeyHandoff, stopLegacyValkey } from "../lib/legacy-valkey-handoff.ts";
import { ensureManagedValkey, stopManagedValkey } from "../lib/managed-valkey.ts";

const available = process.platform === "linux" && !!Bun.which("valkey-server");
async function using<T>(connection: StorageConnectionOptions, read: (client: ReturnType<typeof createStorageClient>) => Promise<T>) {
  const client = createStorageClient(connection); client.on("error", () => {});
  try { await client.connect(); return await read(client); }
  finally { if (client.isOpen) await client.disconnect(); }
}
async function fixture(aof: boolean) {
  const root = await mkdtemp(join(tmpdir(), "lotus-handoff-db-")), source = join(root, "old"), target = join(root, "new");
  const data = join(source, "db"); await mkdir(data, { recursive: true }); await mkdir(join(target, "config"), { recursive: true }); await mkdir(join(source, "config"));
  const reservation = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }), port = reservation.port!; reservation.stop(true);
  const binary = Bun.which("valkey-server")!;
  const acl = join(source, "users.acl");
  await writeFile(acl, "user default off\nuser migration on >synthetic-private-password ~* &* +@all\n", { mode: 0o600 });
  const config = { host: "127.0.0.1", port, db: 7, username: "migration", password: "synthetic-private-password", path: binary };
  const connection: StorageConnectionOptions = { host: config.host, port, database: 7, username: config.username, password: config.password };
  for (const base of [source, target]) await writeFile(join(base, "config/redis.yaml"), Bun.YAML.stringify(config), { mode: 0o600 });
  const main = join(source, "old.ts");
  await writeFile(main, `const child = Bun.spawn(${JSON.stringify([binary, "--bind", "127.0.0.1", "--port", String(port), "--dir", data, "--dbfilename", "original.rdb", "--save", "60 1", "--appendonly", aof ? "yes" : "no", "--appendfilename", "original.aof", "--appenddirname", "original-aof", "--aclfile", acl])}, {cwd:${JSON.stringify(source)},stdin:"ignore",stdout:"ignore",stderr:"ignore"});
    process.on("SIGTERM", async()=>{child.kill("SIGTERM");await child.exited;process.exit(0)});setInterval(()=>{},1000);`);
  const old = Bun.spawn([process.execPath, main], { cwd: source, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  for (let i = 0; ; i++) {
    try { await using(connection, async client => { await client.ping(); }); break; }
    catch (error) { if (i > 50 || old.exitCode !== null) throw error; await Bun.sleep(20); }
  }
  const rootUrl = pathToFileURL(target + "/");
  return { source, target, root, data, old, connection, rootUrl, async close() {
    await stopLegacyValkey(rootUrl).catch(() => {});
    if (old.exitCode === null) old.kill("SIGTERM"); await old.exited;
    await rm(root, { recursive: true, force: true });
  } };
}
async function treeHashes(root: string, base = root): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const item of await readdir(root, { withFileTypes: true })) {
    const file = join(root, item.name);
    if (item.isDirectory()) Object.assign(hashes, await treeHashes(file, base));
    else hashes[file.slice(base.length)] = createHash("sha256").update(await readFile(file)).digest("hex");
  }
  return hashes;
}
for (const aof of [false, true]) test.skipIf(!available)(`直属旧Valkey ${aof ? "AOF" : "RDB"}迁入后保留所有DB、TTL与非默认ACL，重启可恢复`, async () => {
  const f = await fixture(aof);
  try {
    await using(f.connection, async client => { await client.set("ttl-proof", "retained", { EX: 600 }); await client.select(0); await client.set("db-zero", "zero"); await client.select(15); await client.set("db-fifteen", "fifteen"); });
    const prepared = await prepareLegacyValkeyHandoff({ source: f.source, target: f.target, oldPid: f.old.pid, planDirectory: join(f.root, "private-plan") });
    expect(prepared.status).toBe("prepared"); if (prepared.status !== "prepared") throw Error("Expected owned plan");
    expect((await stat(prepared.plan)).mode & 0o777).toBe(0o600);
    await expect(publishLegacyValkeyHandoff(prepared.plan)).rejects.toThrow("old_writer_alive");
    await using(f.connection, async client => { await client.sendCommand(["SAVE"]); await client.set("ttl-proof", "updated", { EX: 600 }); });
    expect(await quiesceLegacyValkeyHandoff(prepared.plan)).toMatchObject({ status: "quiesced" });
    f.old.kill("SIGTERM"); expect(await f.old.exited).toBe(0);
    const original = await treeHashes(f.data);
    expect(await publishLegacyValkeyHandoff(prepared.plan)).toEqual({ status: "published" });
    const restored = await ensureManagedValkey(f.rootUrl, { initialize: true, env: {} }); expect(restored.managed).toBe(true);
    await using(f.connection, async client => { expect(await client.get("ttl-proof")).toBe("updated"); expect(await client.ttl("ttl-proof")).toBeGreaterThan(500); await client.select(0); expect(await client.get("db-zero")).toBe("zero"); await client.select(15); expect(await client.get("db-fifteen")).toBe("fifteen"); });
    expect(await treeHashes(f.data)).toEqual(original);
    await using(f.connection, client => client.set("new-business-write", "after-import"));
    await stopManagedValkey(f.rootUrl);
    expect((await ensureManagedValkey(f.rootUrl, { env: {} })).managed).toBe(true);
    await using(f.connection, async client => { expect(await client.get("ttl-proof")).toBe("updated"); expect(await client.get("new-business-write")).toBe("after-import"); expect(await client.ttl("ttl-proof")).toBeGreaterThan(500); });
    await stopManagedValkey(f.rootUrl);
    expect(await ensureLegacyValkey(f.rootUrl, { ...f.connection, database: 8 })).toBe(false);
    expect(await ensureLegacyValkey(f.rootUrl, { ...f.connection, password: "explicitly-changed" })).toBe(false);
    await writeFile(join(f.target, "config/redis.yaml"), "enable: false\n", { mode: 0o600 });
    expect((await ensureManagedValkey(f.rootUrl, { env: {} })).managed).toBe(false);
  } finally { await f.close(); }
}, 60_000);

test.skipIf(!available)("独立外部Valkey不接管，不创建记录也不停止数据库", async () => {
  const f = await fixture(false);
  const unrelated = Bun.spawn([process.execPath, "--eval", "setInterval(()=>{},1000)"], { cwd: f.source, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  try {
    expect(await prepareLegacyValkeyHandoff({ source: f.source, target: f.target, oldPid: unrelated.pid, planDirectory: join(f.root, "private-plan") })).toEqual({ status: "external" });
    expect(await Bun.file(join(f.target, "data/legacy-valkey/managed.json")).exists()).toBe(false);
    expect(await stopLegacyValkey(f.rootUrl)).toBe(false);
    expect(await using(f.connection, client => client.ping())).toBe("PONG");
  } finally { unrelated.kill("SIGTERM"); await unrelated.exited; await f.close(); }
}, 20_000);

test.skipIf(!available)("quiesce冻结新写，resume只恢复原实例，不丢暂停期间的写入", async () => {
  const f = await fixture(false);
  let writer: ReturnType<typeof createStorageClient> | undefined;
  try {
    const plan = await prepareLegacyValkeyHandoff({ source: f.source, target: f.target, oldPid: f.old.pid, planDirectory: join(f.root, "private-plan") });
    if (plan.status !== "prepared") throw Error("Missing plan");
    await quiesceLegacyValkeyHandoff(plan.plan);
    writer = createStorageClient(f.connection); writer.on("error", () => {}); await writer.connect();
    let finished = false; const pending = writer.set("paused-proof", "later").then(value => { finished = true; return value; });
    await Bun.sleep(75); expect(finished).toBe(false);
    expect(await resumeLegacyValkeyHandoff(plan.plan)).toEqual({ status: "resumed" });
    expect(await pending).toBe("OK"); expect(await writer.get("paused-proof")).toBe("later");
    expect(await Bun.file(join(f.target, "data/legacy-valkey/managed.json")).exists()).toBe(false);
  } finally { if (writer?.isOpen) await writer.disconnect(); await f.close(); }
}, 20_000);

test.skipIf(!available)("AOF转换失败不发布ready记录，清理临时daemon且原库可完整恢复", async () => {
  const f = await fixture(true);
  let restored: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await using(f.connection, client => client.set("failure-proof", "original", { EX: 600 }));
    const plan = await prepareLegacyValkeyHandoff({ source: f.source, target: f.target, oldPid: f.old.pid, planDirectory: join(f.root, "private-plan") });
    if (plan.status !== "prepared") throw Error("Missing plan");
    await quiesceLegacyValkeyHandoff(plan.plan);
    f.old.kill("SIGTERM"); await f.old.exited;
    const original = await treeHashes(f.data);
    const raw = JSON.parse(await readFile(plan.plan, "utf8"));
    raw.acl = raw.acl.map((line: string) => line.replace("+@all", "+@all -config"));
    await writeFile(plan.plan, JSON.stringify(raw), { mode: 0o600 });
    await expect(publishLegacyValkeyHandoff(plan.plan)).rejects.toThrow();
    expect(await Bun.file(join(f.target, "data/legacy-valkey/managed.json")).exists()).toBe(false);
    expect(await treeHashes(f.data)).toEqual(original);
    restored = Bun.spawn([process.execPath, join(f.source, "old.ts")], { cwd: f.source, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    let value: string | null = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      try { value = await using(f.connection, client => client.get("failure-proof")); break; }
      catch { await Bun.sleep(20); }
    }
    expect(value).toBe("original");
  } finally { if (restored) { restored.kill("SIGTERM"); await restored.exited; } await f.close(); }
}, 30_000);

test.skipIf(!available)("不接受共享PM2/user/session CG或不属于旧宿主的专用CG声明", async () => {
  const f = await fixture(false);
  try {
    for (const dedicatedCgroup of ["/", "/user.slice/user-1000.slice", "/system.slice/pm2-lotus.service", "/system.slice/session-1.scope", "/system.slice/not-this-host.service"]) {
      await expect(prepareLegacyValkeyHandoff({ source: f.source, target: f.target, oldPid: f.old.pid,
        planDirectory: join(f.root, "private-plan"), dedicatedCgroup })).rejects.toThrow();
    }
    expect(await using(f.connection, client => client.ping())).toBe("PONG");
  } finally { await f.close(); }
}, 20_000);

test.skipIf(!available)("publish被中断后的临时实例不能作为业务库，stop可清理，checkpoint可重新导入", async () => {
  const f = await fixture(true);
  let publisher: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await using(f.connection, client => client.set("interrupt-proof", "preserved", { EX: 600 }));
    const plan = await prepareLegacyValkeyHandoff({ source: f.source, target: f.target, oldPid: f.old.pid, planDirectory: join(f.root, "private-plan") });
    if (plan.status !== "prepared") throw Error("Missing plan");
    await quiesceLegacyValkeyHandoff(plan.plan); f.old.kill("SIGTERM"); await f.old.exited;
    publisher = Bun.spawn([process.execPath, new URL("../scripts/legacy-migrate-valkey.ts", import.meta.url).pathname, "publish", plan.plan], {
      cwd: f.target, stdin: "ignore", stdout: "ignore", stderr: "ignore",
    });
    const runtime = join(f.target, "data/legacy-valkey/runtime.json"), ready = join(f.target, "data/legacy-valkey/managed.json");
    for (let i = 0; i < 2000 && !await Bun.file(runtime).exists(); i++) {
      if (publisher.exitCode !== null) throw Error("Publisher exited before interruption point");
      await Bun.sleep(1);
    }
    expect(await Bun.file(runtime).exists()).toBe(true);
    publisher.kill("SIGKILL"); await publisher.exited;
    expect(await Bun.file(ready).exists()).toBe(false);
    await expect(ensureManagedValkey(f.rootUrl, { env: {} })).rejects.toThrow("incomplete_import");
    expect(await stopLegacyValkey(f.rootUrl)).toBe(true);
    expect(await publishLegacyValkeyHandoff(plan.plan)).toEqual({ status: "published" });
    expect(await using(f.connection, client => client.get("interrupt-proof"))).toBe("preserved");
  } finally { if (publisher?.exitCode === null) { publisher.kill("SIGKILL"); await publisher.exited; } await f.close(); }
}, 30_000);
