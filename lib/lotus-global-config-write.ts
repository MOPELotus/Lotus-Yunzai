import { constants, linkSync, renameSync, type Stats } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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

async function effectiveFile(root: URL): Promise<Location> {
  const primary = fileURLToPath(new URL("config/global.yaml", root));
  const legacy = fileURLToPath(new URL("config/config/global.yaml", root));
  for (const source of [primary, legacy]) {
    const state = await named(source);
    if (!state) continue;
    if (!state.isFile() && !state.isSymbolicLink()) error("config");
    const file = await realpath(source);
    if (!(await named(file))?.isFile()) error("config");
    return { source, file, exists: true };
  }
  const parent = await named(dirname(primary));
  const directory = parent ? await realpath(dirname(primary)) : join(await realpath(fileURLToPath(root)), "config");
  if (parent && !(await named(directory))?.isDirectory()) error("config");
  return { source: primary, file: join(directory, "global.yaml"), exists: false };
}

function sameLocation(a: Location, b: Location) {
  return a.source === b.source && a.file === b.file;
}

function sameState(a: Stats, b: Stats | undefined) {
  return b?.dev === a.dev && b.ino === a.ino && b.size === a.size && b.ctimeMs === a.ctimeMs && b.mtimeMs === a.mtimeMs &&
    b.mode === a.mode && b.uid === a.uid && b.gid === a.gid;
}

async function snapshot(location: Location) {
  if (!location.exists) return;
  const file = location.file;
  const input = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await input.stat();
    if (!stat.isFile() || stat.nlink !== 1) error("config");
    const bytes = await input.readFile();
    if (!sameState(stat, await input.stat()) || !sameState(stat, await named(file))) error("conflict");
    return { stat, bytes };
  } finally {
    await input.close();
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
}

interface UpdateOptions<T> {
  readonly canWrite: (document: GlobalDocument) => boolean;
  readonly prepare: (text: string, local: GlobalDocument, effective: GlobalDocument) => { yaml?: string; value: T };
  readonly signal?: AbortSignal;
}

export async function updateLotusGlobalConfig<T>(root: URL, { canWrite, prepare, signal }: UpdateOptions<T>): Promise<T> {
  function assertActive() {
    if (signal?.aborted) error("cancelled");
  }

  function authorize(document: GlobalDocument) {
    if (canWrite(structuredClone(document)) !== true) error("permission");
  }

  assertActive();
  const initial = await effectiveFile(root);
  if (!initial.exists && !await named(dirname(initial.file))) {
    authorize(await inheritLotusGlobalConfig(root, {}));
    await mkdir(dirname(initial.file), { mode: 0o700 }).catch((cause: unknown) => {
      if (errno(cause) !== "EEXIST") throw cause;
    });
  }
  const sidecar = join(dirname(initial.file), `.${basename(initial.file)}.lotus-global.sqlite`);
  const database = await lockFile(sidecar, "全局配置").catch(() => error("conflict"));
  try {
    assertActive();
    const location = await effectiveFile(root);
    if (!sameLocation(initial, location)) error("conflict");
    const current = await snapshot(location);
    const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(current?.bytes);
    const parsed: unknown = Bun.YAML.parse(content);
    const previous = parsed == null ? {} : record(parsed) ?? error("config");
    const effective = await inheritLotusGlobalConfig(root, previous);
    authorize(effective);
    assertActive();
    const next = prepare(content, previous, effective);

    async function verifySnapshot() {
      const active = await effectiveFile(root);
      if (!sameLocation(location, active) || location.exists !== active.exists) error("conflict");
      const latest = await snapshot(active);
      if (current && (!latest || !sameState(current.stat, latest.stat) || !current.bytes.equals(latest.bytes))) error("conflict");
      const latestEffective = await inheritLotusGlobalConfig(root, previous);
      if (!isDeepStrictEqual(effective, latestEffective)) error("conflict");
      assertActive();
    }
    if (next.yaml === undefined) {
      await verifySnapshot();
      return next.value;
    }

    const directory = await mkdtemp(join(dirname(location.file), ".lotus-global-settings-"));
    try {
      const staged = join(directory, "global.yaml");
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
      if (current) renameSync(staged, location.file);
      else {
        try { linkSync(staged, location.file); }
        catch (cause) { if (errno(cause) === "EEXIST") error("conflict"); throw cause; }
      }
      return next.value;
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  } finally {
    database.close();
  }
}
