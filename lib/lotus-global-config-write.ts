import { constants, linkSync, renameSync, type Stats } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { lockFile } from "./file-lock.ts";
import { inheritLotusGlobalConfig } from "./lotus-global-config.ts";

type GlobalDocument = Readonly<Record<string, unknown>>;
type ErrorReason = "permission" | "config" | "conflict" | "cancelled";

export class GlobalConfigWriteError extends Error {
  constructor(readonly reason: ErrorReason) { super(reason); }
}

function error(reason: ErrorReason): never {
  throw new GlobalConfigWriteError(reason);
}

function errno(cause: unknown) {
  return (cause as NodeJS.ErrnoException | undefined)?.code;
}

async function named(file: string) {
  return lstat(file).catch((cause: unknown) => {
    if (errno(cause) !== "ENOENT") throw cause;
    return undefined;
  });
}

interface Location {
  readonly source: string;
  readonly file: string;
  readonly exists: boolean;
}

type ConfigurationName = "global" | "bot" | "server" | "system-status" | "genshin-damage" |
  "remote" | "panel-rank" | "notice" | "mys.pushNews" | "guides" | "zzz-rank" | "zzz-panel" |
  "gacha-display" | "group" | "groupAdmin" | "auto-group-card" | "group-leave-blacklist";

function groupConfigLockPath(root: URL) {
  return fileURLToPath(new URL("config/.lotus-group-config.sqlite", root));
}

export async function withLocalGroupConfigWrite<T>(root: URL, write: () => Promise<T>): Promise<T> {
  const path = groupConfigLockPath(root);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = await lockFile(path, "群组配置");
  try { return await write(); }
  finally { lock.close(); }
}

async function canonicalDirectory(path: string): Promise<string> {
  const state = await named(path);
  if (state) {
    const location = await realpath(path);
    if (!(await named(location))?.isDirectory()) error("config");
    return location;
  }
  return join(await canonicalDirectory(dirname(path)), basename(path));
}

async function effectiveFile(root: URL, name: ConfigurationName, override?: string): Promise<Location> {
  const primary = override ? resolve(override) : fileURLToPath(new URL(`config/${name}.yaml`, root));
  const legacy = ["global", "bot", "auto-group-card", "group-leave-blacklist"].includes(name)
    ? [fileURLToPath(new URL(`config/config/${name}.yaml`, root))] : [];
  for (const source of [primary, ...legacy]) {
    const state = await named(source);
    if (!state) continue;
    if (!state.isFile() && !state.isSymbolicLink()) error("config");
    const file = await realpath(source);
    if (!(await named(file))?.isFile()) error("config");
    if (name === "server" && (file !== source || (state.mode & 0o077) !== 0)) error("config");
    return { source, file, exists: true };
  }
  const directory = await canonicalDirectory(dirname(primary));
  return { source: primary, file: join(directory, basename(primary)), exists: false };
}

function sameLocation(a: Location, b: Location) {
  return a.source === b.source && a.file === b.file;
}

function sameState(a: Stats, b: Stats | undefined) {
  return b?.dev === a.dev && b.ino === a.ino && b.size === a.size && b.ctimeMs === a.ctimeMs && b.mtimeMs === a.mtimeMs &&
    b.mode === a.mode && b.uid === a.uid && b.gid === a.gid;
}

async function snapshot(location: Location, maxBytes = Infinity) {
  if (!location.exists) return;
  const file = location.file;
  const input = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await input.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) error("config");
    const bytes = Buffer.alloc(stat.size);
    for (let offset = 0; offset < bytes.length;) {
      const { bytesRead } = await input.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) error("conflict");
      offset += bytesRead;
    }
    if (!sameState(stat, await input.stat()) || !sameState(stat, await named(file))) error("conflict");
    return { stat, bytes };
  } finally {
    await input.close();
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
}

export async function readCanonicalLocalConfiguration(root: URL, name: ConfigurationName, maxBytes: number) {
  const location = await effectiveFile(root, name);
  const current = await snapshot(location, maxBytes);
  const latest = await effectiveFile(root, name);
  if (!sameLocation(location, latest) || location.exists !== latest.exists) error("conflict");
  const parsed: unknown = Bun.YAML.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(current?.bytes));
  return parsed == null ? {} : record(parsed) ?? error("config");
}

interface UpdateOptions<T> {
  readonly canWrite: (document: GlobalDocument) => boolean;
  readonly prepare: (text: string, local: GlobalDocument, effective: GlobalDocument) => { yaml?: string; value: T };
  readonly signal?: AbortSignal;
  readonly canCommit?: () => boolean;
  readonly onCommitted?: (value: T) => void;
  readonly override?: string;
  // Read-only resolver for a namespace with its own inheritance rules. It runs again before commit.
  readonly resolveEffective?: () => Promise<GlobalDocument>;
}

export function updateLotusGlobalConfig<T>(root: URL, options: UpdateOptions<T>): Promise<T> {
  return updateLocalConfiguration(root, "global", options);
}

export async function updateLocalConfiguration<T>(
  root: URL, name: ConfigurationName, { canWrite, prepare, signal, canCommit, onCommitted, override, resolveEffective }: UpdateOptions<T>,
): Promise<T> {
  function assertActive() {
    if (signal?.aborted) error("cancelled");
  }

  function authorize(document: GlobalDocument) {
    if (canWrite(structuredClone(document)) !== true) error("permission");
  }

  function inherited(document: GlobalDocument) {
    if (resolveEffective) return resolveEffective();
    return name === "global" ? inheritLotusGlobalConfig(root, document) : document;
  }

  assertActive();
  const initial = await effectiveFile(root, name, override);
  if (!initial.exists && !await named(dirname(initial.file))) {
    authorize(await inherited({}));
    await mkdir(dirname(initial.file), { mode: 0o700, recursive: name === "system-status" || name === "genshin-damage" }).catch((cause: unknown) => {
      if (errno(cause) !== "EEXIST") throw cause;
    });
  }
  const sidecar = name === "group" ? groupConfigLockPath(root) :
    name === "groupAdmin" ? fileURLToPath(new URL("config/.lotus-group-admin.sqlite", root)) :
      join(dirname(initial.file), `.${basename(initial.file)}.lotus-${name}.sqlite`);
  const database = await lockFile(sidecar, name === "global" ? "全局配置" : `${name}.yaml`).catch(() => error("conflict"));
  try {
    assertActive();
    const location = await effectiveFile(root, name, override);
    if (!sameLocation(initial, location)) error("conflict");
    const current = await snapshot(location);
    const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(current?.bytes);
    const parsed: unknown = Bun.YAML.parse(content);
    const previous = parsed == null ? {} : record(parsed) ?? error("config");
    const effective = await inherited(previous);
    authorize(effective);
    assertActive();
    const next = prepare(content, previous, effective);

    async function verifySnapshot() {
      const active = await effectiveFile(root, name, override);
      if (!sameLocation(location, active) || location.exists !== active.exists) error("conflict");
      const latest = await snapshot(active);
      if (current && (!latest || !sameState(current.stat, latest.stat) || !current.bytes.equals(latest.bytes))) error("conflict");
      const latestEffective = await inherited(previous);
      if (!isDeepStrictEqual(effective, latestEffective)) error("conflict");
      if (name !== "global") authorize(latestEffective);
      assertActive();
    }
    if (next.yaml === undefined) {
      await verifySnapshot();
      if (canCommit && !canCommit()) error("permission");
      onCommitted?.(next.value);
      return next.value;
    }

    const directory = await mkdtemp(join(dirname(location.file), `.lotus-${name}-settings-`));
    try {
      const staged = join(directory, `${name}.yaml`);
      const output = await open(staged, "wx", 0o600);
      try {
        await output.writeFile(next.yaml, "utf8");
        if (current) {
          const owner = await output.stat();
          if (owner.uid !== current.stat.uid || owner.gid !== current.stat.gid) await output.chown(current.stat.uid, current.stat.gid);
          await output.chmod(current.stat.mode & 0o7777);
        }
        await output.sync();
      } finally {
        await output.close();
      }

      await verifySnapshot();
      if (canCommit && !canCommit()) error("permission");
      if (current) renameSync(staged, location.file);
      else {
        try { linkSync(staged, location.file); }
        catch (cause) { if (errno(cause) === "EEXIST") error("conflict"); throw cause; }
      }
      // Publish runtime state while later mutations still wait for the same lock.
      onCommitted?.(next.value);
      return next.value;
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  } finally {
    database.close();
  }
}
