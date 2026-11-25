import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createConnection, isIP } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createStorageClient, type StorageConnectionOptions } from "@lotus-yunzai/storage";
import { readOptionalConfigFile, readOptionalLocalConfig } from "./config.ts";
import { lockFile } from "./file-lock.ts";
import { parseStorageSettings } from "./valkey-config.ts";

type Identity = { pid: number; start: string; executable: string; cwd: string };
type Plan = { format: 1; source: string; target: string; writer: Identity; owner: Identity; connection: StorageConnectionOptions;
  fingerprint: string; binary: string; binaryHash: string; serverBinaryHash: string; directory: string; settings: Record<string, string>; acl: string[];
  serverVersion: string; serverRunId: string; keyspace: string };
type RecordFile = Plan & { published: true; ready: boolean; root: string };
type Checkpoint = { format: 1; runId: string; hash: string; createdAt: number; pauseExpiresAt: number };
function fail(code: string): never { throw new Error(`legacy_valkey_${code}`); }
const fingerprint = (value: string | StorageConnectionOptions) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const location = (root: URL) => join(fileURLToPath(root), "data/legacy-valkey");
const quote = (value: string) => JSON.stringify(value);
const fields = (text: string) => Object.fromEntries(text.split(/\r?\n/u).filter(line => line && !line.startsWith("#")).map(line => {
  const at = line.indexOf(":"); return [line.slice(0, at), line.slice(at + 1)];
}));
async function identity(pid: number): Promise<Identity | undefined> {
  try {
    const text = await readFile(`/proc/${pid}/stat`, "utf8"), rest = text.slice(text.lastIndexOf(")") + 2).split(" ");
    if (rest[0] === "Z") return;
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    if (Number(/^Uid:\s+(\d+)/mu.exec(status)?.[1]) !== process.getuid?.()) fail("process_owner");
    return { pid, start: rest[19]!, executable: await realpath(`/proc/${pid}/exe`), cwd: await realpath(`/proc/${pid}/cwd`) };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH") return; throw error; }
}
async function sameProcess(expected: Identity) {
  const actual = await identity(expected.pid);
  return actual?.start === expected.start && actual.executable === expected.executable && actual.cwd === expected.cwd;
}
async function processCgroup(pid: number) {
  return /^0::(.+)$/mu.exec(await readFile(`/proc/${pid}/cgroup`, "utf8"))?.[1];
}
async function descendant(pid: number, parent: number) {
  const seen = new Set<number>();
  while (pid > 1 && !seen.has(pid)) {
    if (pid === parent) return true;
    seen.add(pid);
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    pid = Number(/^PPid:\s+(\d+)/mu.exec(status)?.[1]);
  }
  return false;
}
async function privateDirectory(path: string) {
  await mkdir(path, { mode: 0o700, recursive: true });
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || await realpath(path) !== path) fail("private_directory");
  await chmod(path, 0o700);
}
async function privateJson<T>(path: string): Promise<T> {
  const info = await lstat(path);
  if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || info.mode & 0o077 || info.size > 1024 * 1024 || await realpath(path) !== path) fail("private_record");
  return JSON.parse(await readFile(path, "utf8")) as T;
}
async function store(path: string, value: unknown) {
  const next = `${path}.${process.pid}.next`;
  await writeFile(next, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  await rename(next, path);
}
async function clientRun<T>(connection: StorageConnectionOptions, run: (client: ReturnType<typeof createStorageClient>) => Promise<T>) {
  const client = createStorageClient(connection); client.on("error", () => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await client.connect();
    return await Promise.race([run(client), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("legacy_valkey_command_timeout")), 180_000);
    })]);
  } finally { clearTimeout(timer); if (client.isOpen) await client.disconnect(); }
}
async function configuration(client: ReturnType<typeof createStorageClient>, name: string) {
  const values = await client.sendCommand<string[]>(["CONFIG", "GET", name]);
  if (values.length !== 2 || values[0] !== name) fail("unsupported_configuration");
  return values[1]!;
}
async function binaryHash(path: string) {
  const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await input.stat(); if (!before.isFile()) fail("unsafe_file");
    const hash = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024); let position = 0;
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
    }
    const after = await input.stat();
    if (position !== before.size || before.ino !== after.ino || before.size !== after.size || before.ctimeMs !== after.ctimeMs || before.mtimeMs !== after.mtimeMs) fail("file_changed");
    return hash.digest("hex");
  } finally { await input.close(); }
}
async function probeBinary(binary: string, expectedHash: string, target: string): Promise<boolean> {
  const directory = await mkdtemp(join(tmpdir(), "lotus-valkey-binary-"));
  const socketPath = join(directory, "probe.sock");
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    child = Bun.spawn([binary, "--port", "0", "--unixsocket", socketPath, "--unixsocketperm", "600", "--dir", directory,
      "--save", "", "--appendonly", "no", "--daemonize", "no"], {
      cwd: target, env: { PATH: process.env.PATH, HOME: process.env.HOME }, stdin: "ignore", stdout: "ignore", stderr: "ignore",
    });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) return false;
      if ((await lstat(socketPath).catch(() => undefined))?.isSocket()) break;
      await Bun.sleep(10);
    }
    const actual = await identity(child.pid);
    if (!actual || await binaryHash(actual.executable) !== expectedHash) return false;
    await clientRun({ host: "127.0.0.1", port: 0, database: 0, socketPath }, client => client.ping());
    return true;
  } catch { return false; }
  finally {
    if (child) { if (child.exitCode === null) child.kill("SIGTERM"); await child.exited; }
    await rm(directory, { recursive: true, force: true });
  }
}
function filename(value: string) {
  if (!value || basename(value) !== value || value === "." || value === ".." || /[\x00-\x1f]/u.test(value)) fail("unsafe_filename");
  return value;
}
async function validatePlan(path: string): Promise<Plan> {
  const plan = await privateJson<Plan>(path);
  if (plan.format !== 1 || !isAbsolute(plan.target) || !isAbsolute(plan.source) || !plan.writer?.pid || !plan.owner?.pid ||
      plan.fingerprint !== fingerprint(plan.connection) || !plan.settings || !Array.isArray(plan.acl) ||
      await realpath(plan.target) !== plan.target || await realpath(plan.source) !== plan.source) fail("invalid_plan");
  if (await binaryHash(plan.binary) !== plan.binaryHash) fail("binary_changed");
  return plan;
}

/** Only a proved local descendant is adopted. Independent services remain external. */
export async function prepareLegacyValkeyHandoff({ source, target, oldPid, planDirectory, dedicatedCgroup }: {
  source: string; target: string; oldPid: number; planDirectory: string; dedicatedCgroup?: string;
}): Promise<{ status: "none" | "external" } | { status: "prepared"; plan: string }> {
  if (process.platform !== "linux") fail("unsupported_platform");
  source = await realpath(source); target = await realpath(target);
  const root = pathToFileURL(source + "/");
  const defaults = await readOptionalConfigFile(root, "config/default_config/redis.yaml");
  const config = await readOptionalLocalConfig(root, "redis", defaults) ?? defaults;
  if (!config || config.enable === false) return { status: "none" };
  const connection = parseStorageSettings(config);
  if (connection.socketPath || !(connection.host === "localhost" || isIP(connection.host) === 4 && connection.host.startsWith("127."))) return { status: "external" };
  const owner = await identity(oldPid); if (!owner || owner.cwd !== source) fail("old_owner");
  if (dedicatedCgroup !== undefined) {
    const systemLeaf = /^\/system\.slice\/([A-Za-z0-9_.@-]+\.service)$/u.exec(dedicatedCgroup)?.[1];
    const userLeaf = /^\/user\.slice\/user-(\d+)\.slice\/user@\1\.service\/app\.slice\/([A-Za-z0-9_.@-]+\.service)$/u.exec(dedicatedCgroup)?.[2];
    const leaf = systemLeaf ?? userLeaf;
    if (!leaf || /^(?:pm2|user@|session|sshd?|dbus|systemd)/iu.test(leaf)) fail("shared_cgroup");
    if (await processCgroup(oldPid) !== dedicatedCgroup) fail("owner_cgroup");
  }
  return clientRun(connection, async client => {
    const server = fields(await client.sendCommand<string>(["INFO", "server"]));
    const writer = await identity(Number(server.process_id)); if (!writer) fail("missing_writer");
    const writerCgroup = dedicatedCgroup ? await processCgroup(writer.pid) : undefined;
    const inDedicatedUnit = dedicatedCgroup !== undefined && (writerCgroup === dedicatedCgroup || writerCgroup?.startsWith(dedicatedCgroup + "/"));
    if (writer.pid === oldPid || !await descendant(writer.pid, oldPid) && !inDedicatedUnit) return { status: "external" };
    if (fields(await client.sendCommand<string>(["INFO", "replication"])).role !== "master" ||
        fields(await client.sendCommand<string>(["INFO", "cluster"])).cluster_enabled === "1" ||
        (await client.sendCommand<unknown[]>(["MODULE", "LIST"])).length) fail("unsupported_mode");
    const settings: Record<string, string> = {};
    for (const name of ["dir", "dbfilename", "appendonly", "appendfilename", "appenddirname", "appendfsync", "save", "databases", "aof-use-rdb-preamble", "rdbcompression", "rdbchecksum"]) {
      settings[name] = await configuration(client, name);
    }
    if (!["yes", "no"].includes(settings.appendonly!)) fail("persistence_disabled");
    for (const name of ["dbfilename", "appendfilename", "appenddirname"]) filename(settings[name]!);
    const directory = await realpath(settings.dir!); if (directory !== settings.dir) fail("unsafe_data_directory");
    const acl = await client.sendCommand<string[]>(["ACL", "LIST"]);
    if (!acl.length || acl.some(line => /[\r\n\0]/u.test(line))) fail("unsupported_acl");
    const serverBinaryHash = await binaryHash(writer.executable);
    let binary: string | undefined;
    for (const candidate of [...new Set([Bun.which("valkey-server"), Bun.which("redis-server"), writer.executable].filter((value): value is string => !!value))]) {
      const path = await realpath(candidate);
      const inside = relative(source, path);
      if (inside !== ".." && !inside.startsWith(".." + sep)) continue;
      const probe = Bun.spawn([path, "--version"], { cwd: target, env: { PATH: process.env.PATH, HOME: process.env.HOME }, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
      const version = await new Response(probe.stdout).text();
      if (await probe.exited === 0 && /v=([0-9.]+)/u.exec(version)?.[1] === (server.valkey_version ?? server.redis_version) && await probeBinary(path, serverBinaryHash, target)) { binary = path; break; }
    }
    if (!binary) fail("binary_unavailable");
    if (!await sameProcess(writer) || !await sameProcess(owner)) fail("writer_changed");
    await privateDirectory(planDirectory);
    const path = join(await realpath(planDirectory), "legacy-valkey-plan.json");
    const plan: Plan = { format: 1, source, target, writer, owner, connection, fingerprint: fingerprint(connection),
      binary, binaryHash: await binaryHash(binary), serverBinaryHash, directory, settings, acl, serverVersion: (server.valkey_version ?? server.redis_version)!, serverRunId: server.run_id!,
      keyspace: await client.sendCommand<string>(["INFO", "keyspace"]) };
    await writeFile(path, JSON.stringify(plan), { mode: 0o600, flag: "wx" });
    return { status: "prepared", plan: path };
  });
}

async function copyTree(source: string, destination: string) {
  const before = await lstat(source);
  if (await realpath(source) !== source || before.uid !== process.getuid?.()) fail("unsafe_persistence");
  if (before.isDirectory()) {
    await mkdir(destination, { mode: 0o700 });
    for (const name of await readdir(source)) await copyTree(join(source, name), join(destination, name));
  } else if (before.isFile() && before.nlink === 1) {
    const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK), output = await open(destination, "wx", 0o600);
    try {
      const opened = await input.stat();
      if (opened.ino !== before.ino || opened.dev !== before.dev) fail("persistence_changed");
      const buffer = Buffer.alloc(1024 * 1024); let position = 0;
      for (;;) {
        const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
        if (!bytesRead) break;
        let written = 0;
        while (written < bytesRead) {
          const next = await output.write(buffer, written, bytesRead - written, position + written);
          if (!next.bytesWritten) fail("persistence_write");
          written += next.bytesWritten;
        }
        position += bytesRead;
      }
      await output.sync();
      const after = await input.stat();
      if (position !== before.size || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail("persistence_changed");
    } finally { await input.close(); await output.close(); }

  } else fail("unsafe_persistence");
}

/** Freeze new writes and persist a complete, private checkpoint before stopping the old tree. */
export async function quiesceLegacyValkeyHandoff(planPath: string) {
  const plan = await validatePlan(planPath);
  if (!await sameProcess(plan.writer) || !await sameProcess(plan.owner)) fail("old_writer_changed");
  return clientRun(plan.connection, async client => {
    const server = fields(await client.sendCommand<string>(["INFO", "server"]));
    if (server.run_id !== plan.serverRunId || Number(server.process_id) !== plan.writer.pid) fail("old_writer_changed");
    for (const [name, value] of Object.entries(plan.settings)) {
      if (await configuration(client, name) !== value) fail("configuration_changed");
    }
    const pauseExpiresAt = Date.now() + 300_000;
    await client.sendCommand(["CLIENT", "PAUSE", "300000", "WRITE"]);
    try {
      let idle = false;
      for (let attempt = 0; attempt < 1200; attempt++) {
        const persistence = fields(await client.sendCommand<string>(["INFO", "persistence"]));
        if (persistence.rdb_bgsave_in_progress === "0" && persistence.aof_rewrite_in_progress !== "1") { idle = true; break; }
        await Bun.sleep(100);
      }
      if (!idle) fail("checkpoint_busy");
      await client.sendCommand(["SAVE"]);
      const checkpoint = join(dirname(planPath), "legacy-valkey-checkpoint.rdb");
      const next = checkpoint + ".next";
      await copyTree(join(plan.directory, plan.settings.dbfilename!), next);
      await rename(next, checkpoint);
      plan.acl = await client.sendCommand<string[]>(["ACL", "LIST"]);
      await store(planPath, plan);
      if (Date.now() + 10_000 >= pauseExpiresAt) fail("checkpoint_pause_expired");
      await store(join(dirname(planPath), "legacy-valkey-checkpoint.json"), {
        format: 1, runId: plan.serverRunId, hash: await binaryHash(checkpoint), createdAt: Date.now(), pauseExpiresAt,
      } satisfies Checkpoint);
      return { status: "quiesced" as const, pauseExpiresAt };
    } catch (error) {
      await rm(join(dirname(planPath), "legacy-valkey-checkpoint.rdb.next"), { force: true });
      await client.sendCommand(["CLIENT", "UNPAUSE"]).catch(() => undefined);
      throw error;
    }
  });
}
export async function resumeLegacyValkeyHandoff(planPath: string) {
  const plan = await validatePlan(planPath);
  if (!await sameProcess(plan.writer)) return { status: "gone" as const };
  await clientRun(plan.connection, async client => {
    const server = fields(await client.sendCommand<string>(["INFO", "server"]));
    if (server.run_id !== plan.serverRunId || Number(server.process_id) !== plan.writer.pid) fail("old_writer_changed");
    await client.sendCommand(["CLIENT", "UNPAUSE"]);
  });
  return { status: "resumed" as const };
}

/** Source bytes remain untouched; normal runtime sees a record only after complete import. */
export async function publishLegacyValkeyHandoff(planPath: string) {
  const plan = await validatePlan(planPath);
  if (await sameProcess(plan.writer) || await sameProcess(plan.owner)) fail("old_writer_alive");
  const checkpoint = await privateJson<Checkpoint>(join(dirname(planPath), "legacy-valkey-checkpoint.json"));
  const checkpointFile = join(dirname(planPath), "legacy-valkey-checkpoint.rdb");
  if (checkpoint.format !== 1 || checkpoint.runId !== plan.serverRunId || checkpoint.hash !== await binaryHash(checkpointFile)) fail("invalid_checkpoint");
  const root = location(pathToFileURL(plan.target + "/"));
  await privateDirectory(dirname(root));
  if (!await Bun.file(join(root, "managed.json")).exists() && await Bun.file(join(root, "pending.json")).exists()) {
    const pending = await readRecord(pathToFileURL(plan.target + "/"), true);
    if (!pending || pending.fingerprint !== plan.fingerprint || pending.writer.start !== plan.writer.start || pending.writer.pid !== plan.writer.pid) fail("different_pending_import");
    await stopRecord(pending);
    await rm(root, { recursive: true, force: true });
  }
  const staging = `${root}.staging-${process.pid}`; await mkdir(staging, { mode: 0o700 });
  let record: RecordFile | undefined;
  let installed = false;
  try {
    const data = join(staging, "data"), original = join(staging, "original");
    await mkdir(data, { mode: 0o700 }); await mkdir(original, { mode: 0o700 });
    if (plan.settings.appendonly === "yes") {
      const aof = join(plan.directory, plan.settings.appenddirname!);
      const info = await lstat(aof).catch(() => undefined);
      if (info?.isDirectory()) {
        const manifest = await readFile(join(aof, plan.settings.appendfilename! + ".manifest"), "utf8");
        if (!/^file .+ seq \d+ type [bi]$/mu.test(manifest)) fail("invalid_aof_manifest");
        await copyTree(aof, join(original, plan.settings.appenddirname!));
      } else await copyTree(join(plan.directory, plan.settings.appendfilename!), join(original, plan.settings.appendfilename!));
    } else await copyTree(join(plan.directory, plan.settings.dbfilename!), join(original, plan.settings.dbfilename!));
    await copyTree(checkpointFile, join(data, plan.settings.dbfilename!));
    await copyTree(checkpointFile, join(staging, "checkpoint.rdb"));
    await writeFile(join(staging, "users.acl"), plan.acl.join("\n") + "\n", { mode: 0o600 });
    record = { ...plan, published: true, ready: true, root };
    await writeFile(join(staging, "pending.json"), JSON.stringify({ ...record, ready: false }), { mode: 0o600 });
    await rename(staging, root); installed = true;
    await startRecord(record, true);
    await store(join(root, "managed.json"), record);
    await rm(join(root, "pending.json"), { force: true });
    return { status: "published" as const };
  } catch (error) {
    if (installed && record) {
      await stopRecord(record);
      await rm(root, { recursive: true, force: true });
    }
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function readRecord(root: URL, allowPending = false): Promise<RecordFile | undefined> {
  let path = join(location(root), "managed.json");
  if (!await Bun.file(path).exists()) {
    path = join(location(root), "pending.json");
    if (!await Bun.file(path).exists()) return;
    if (!allowPending) fail("incomplete_import");
  }
  const record = await privateJson<RecordFile>(path);
  if (record.format !== 1 || record.published !== true || !allowPending && record.ready !== true || record.root !== location(root) || record.target !== await realpath(fileURLToPath(root)) ||
      record.fingerprint !== fingerprint(record.connection)) fail("invalid_record");
  return record;
}

async function managedIdentity(record: RecordFile) {
  const path = join(record.root, "runtime.json");
  if (!await Bun.file(path).exists()) return;
  const runtime = await privateJson<{ process: Identity; runId: string }>(path);
  if (await sameProcess(runtime.process)) return runtime;
}
function configText(record: RecordFile, importing: boolean) {
  return [`bind ${quote(record.connection.host === "localhost" ? "127.0.0.1" : record.connection.host)}`, `port ${record.connection.port}`,
    `dir ${quote(join(record.root, "data"))}`, `aclfile ${quote(join(record.root, "users.acl"))}`, "daemonize yes", "protected-mode yes",
    `pidfile ${quote(join(record.root, "valkey.pid"))}`, `logfile ${quote(join(record.root, "valkey.log"))}`,
    ...Object.entries(record.settings).filter(([key]) => key !== "dir").map(([key, value]) =>
      `${key} ${key === "save" ? value || '\"\"' : quote(importing && key === "appendonly" ? "no" : value)}`)].join("\n") + "\n";
}
async function stopRecord(record: RecordFile) {
  let runtime = await managedIdentity(record);
  if (!runtime) {
    const pid = Number(await readFile(join(record.root, "valkey.pid"), "utf8").catch(() => ""));
    const process = pid > 1 ? await identity(pid) : undefined;
    if (!process || process.cwd !== join(record.root, "data") || await binaryHash(process.executable) !== record.serverBinaryHash) return false;
    runtime = { process, runId: "" };
  }
  // Identity includes PID start time and executable/cwd, even if authentication failed during import.
  if (await sameProcess(runtime.process)) process.kill(runtime.process.pid, "SIGTERM");
  for (let attempt = 0; attempt < 400; attempt++) {
    if (!await sameProcess(runtime.process)) return true;
    await Bun.sleep(50);
  }
  fail("stop_timeout");
}
async function endpointListening(connection: StorageConnectionOptions): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host: connection.host, port: connection.port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
    socket.setTimeout(1500, () => { socket.destroy(); resolve(true); });
  });
}
async function startRecord(record: RecordFile, importing: boolean, signal?: AbortSignal) {
  const running = await managedIdentity(record);
  if (running) {
    if (importing) fail("import_writer_alive");
    await clientRun(record.connection, async client => { if (fields(await client.sendCommand<string>(["INFO", "server"])).run_id !== running.runId) fail("endpoint_changed"); });
    return;
  }
  if (await endpointListening(record.connection)) fail("endpoint_occupied");
  if (await binaryHash(record.binary) !== record.binaryHash) fail("binary_changed");
  const path = join(record.root, "valkey.conf");
  await writeFile(path, configText(record, importing), { mode: 0o600 });
  const child = Bun.spawn([record.binary, path], { cwd: record.root, stdin: "ignore", stdout: "ignore", stderr: "ignore", signal,
    env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  if (await child.exited !== 0) fail("start_failed");
  let started = false;
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      signal?.throwIfAborted();
      try {
        await clientRun(record.connection, async client => {
          const server = fields(await client.sendCommand<string>(["INFO", "server"]));
          const process = await identity(Number(server.process_id));
          if (!process || await binaryHash(process.executable) !== record.serverBinaryHash || process.cwd !== join(record.root, "data")) fail("runtime_identity");
          await store(join(record.root, "runtime.json"), { process, runId: server.run_id });
        });
        started = true; break;
      } catch { await Bun.sleep(100); }
    }
    if (!started) fail("start_timeout");
    if (importing && record.settings.appendonly === "yes") {
      await clientRun(record.connection, async client => {
        await client.sendCommand(["CONFIG", "SET", "appendonly", "yes"]);
        for (let attempt = 0; attempt < 1200; attempt++) {
          signal?.throwIfAborted();
          const persistence = fields(await client.sendCommand<string>(["INFO", "persistence"]));
          if (persistence.aof_rewrite_in_progress === "0" && persistence.aof_rewrite_scheduled === "0") {
            if (persistence.aof_enabled !== "1" || persistence.aof_last_bgrewrite_status !== "ok" || persistence.aof_last_write_status !== "ok") fail("aof_import_failed");
            await writeFile(path, configText(record, false), { mode: 0o600 }); return;
          }
          await Bun.sleep(100);
        }
        fail("aof_import_timeout");
      });
    }
  } catch (error) { await stopRecord(record); throw error; }
}
export async function ensureLegacyValkey(root: URL, connection: string | StorageConnectionOptions | undefined, signal?: AbortSignal): Promise<boolean> {
  const record = await readRecord(root);
  if (!record || !connection || fingerprint(connection) !== record.fingerprint) return false;
  const lock = await lockFile(join(record.root, ".startup.sqlite"), "legacy-valkey", 20_000);
  try { signal?.throwIfAborted(); await startRecord(record, false, signal); return true; }
  finally { lock.close(); }
}

export async function stopLegacyValkey(root: URL): Promise<boolean> {
  const record = await readRecord(root, true); if (!record) return false;
  const lock = await lockFile(join(record.root, ".startup.sqlite"), "legacy-valkey", 20_000);
  try { return await stopRecord(record); }
  finally { lock.close(); }
}
