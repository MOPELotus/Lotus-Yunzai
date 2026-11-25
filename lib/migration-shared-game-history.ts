import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { starRailGachaPools, type StarRailGachaPool } from "../packages/hoyo-client/starrail-gacha.ts";
import { mergeStarRailGachaHistory } from "../plugins/starrail/gacha-history.ts";
import { readZzzFlatLegacyGacha } from "../plugins/zzz/gacha-legacy.ts";
import { readZzzTuningHistory } from "../plugins/zzz/tuning-history.ts";
import { legacyLotusDirectories } from "./lotus-global-config.ts";
import { withinInstallation } from "./plugins/migration-plan.ts";

const migrationRoot = "data/legacy-game-history";
const families = {
  starRailGachaJson: /^[1-9]\d{8,9}\.json$/u,
  zzzGachaJson: /^[1-9]\d{7,9}\.json$/u,
  zzzTuningStats: /^[1-9]\d{7,9}\.json$/u,
} as const;
type Family = keyof typeof families;
type Source = typeof legacyLotusDirectories[number];
type Summary = { readonly path: string; files: number; bytes: number };

const qqDirectory = /^[1-9]\d{0,18}$/u;
const maxFileBytes = 32 * 1024 * 1024;
const poolTypes = Object.keys(starRailGachaPools) as StarRailGachaPool[];
const secretFields = /^(?:cookie|stoken(?:_v2)?|ltoken(?:_v2)?|authkey|login_ticket|cookie_token(?:_v2)?)$/iu;

interface HistoryLeaf {
  readonly family: Family;
  readonly plugin: Source;
  readonly qq: string;
  readonly name: string;
  readonly absolute: string;
  readonly info: Stats;
}

function sourceChanged(): never {
  throw new Error($t("lib.migration-shared-game-history.text_a8f9da3f0a"));
}

async function statIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function unchanged(before: Stats, after: Stats | undefined) {
  return after && before.ino === after.ino && before.dev === after.dev && before.size === after.size &&
    before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && before.mode === after.mode &&
    before.nlink === after.nlink;
}

async function readLeaf({ absolute, info }: HistoryLeaf, signal?: AbortSignal) {
  if (await realpath(absolute) !== absolute) sourceChanged();
  const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!unchanged(info, await file.stat())) sourceChanged();
    const bytes = Buffer.alloc(info.size);
    for (let offset = 0; offset < bytes.length;) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) sourceChanged();
      offset += bytesRead;
    }
    if (!unchanged(info, await file.stat()) || !unchanged(info, await statIfPresent(absolute)) ||
        await realpath(absolute) !== absolute) sourceChanged();
    return bytes;
  } finally {
    await file.close();
  }
}

function object(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parseHistory(bytes: Buffer) {
  const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes), (key, value: unknown) => {
    if (secretFields.test(key)) throw new Error();
    return value;
  });
  const row = object(raw);
  if (!row) throw new Error();
  return row;
}

function checkStarRail(row: Record<string, unknown>, qq: string, uid: string) {
  if (row.version !== 1 || row.qq !== qq || row.uid !== uid) throw new Error();
  const region = row.region ?? "prod_gf_cn";
  if (region !== "prod_gf_cn" && region !== "prod_qd_cn") throw new Error();
  // Validate the first normal refresh against all six pools without replacing the archived document.
  mergeStarRailGachaHistory(row, {
    uid, region, revision: "", refreshedCookie: false, brief: { version_id: "", items: [] },
    pools: poolTypes.map(type => ({ type, name: starRailGachaPools[type], pity: null, cards: [], fiveStars: [] })),
  }, { qq, profileId: 1 }, new Date(0));
}

/** Preserves only the old QQ/UID gameplay leaves in the new runtime's read-only fallback roots. */
export async function stageLegacySharedGameHistory(sourcePath: string, stateDirectory: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const [source, stage] = await Promise.all([realpath(sourcePath), realpath(stateDirectory)]);
  const [sourceInfo, stageInfo] = await Promise.all([lstat(source), lstat(stage)]);
  if (!sourceInfo.isDirectory() || !stageInfo.isDirectory() || stage !== resolve(stateDirectory) ||
      (stageInfo.mode & 0o077) || withinInstallation(source, stage) || withinInstallation(stage, source)) {
    throw new Error($t("lib.migration-shared-game-history.text_f779b2b296"));
  }
  const seenDirectories = new Map<string, Stats>([[source, sourceInfo]]);
  const leaves = new Map<string, HistoryLeaf[]>();
  const totals = new Map<string, Summary>();

  async function oldDirectory(path: string): Promise<boolean> {
    if (seenDirectories.has(path)) return true;
    if (!await oldDirectory(dirname(path))) return false;
    const info = await statIfPresent(path);
    if (!info) return false;
    if (!info.isDirectory() || await realpath(path) !== path) throw new Error($t("lib.migration-shared-game-history.text_db066fc62a"));
    seenDirectories.set(path, info);
    return true;
  }

  async function privateDirectory(path: string) {
    if (path === stage) return;
    await privateDirectory(dirname(path));
    let info = await statIfPresent(path);
    if (!info) {
      await mkdir(path, { mode: 0o700 });
      info = await lstat(path);
    }
    if (!info.isDirectory() || (info.mode & 0o077) || await realpath(path) !== path) {
      throw new Error($t("lib.migration-shared-game-history.text_48deb323e9"));
    }
  }

  for (const plugin of legacyLotusDirectories) {
    for (const family of Object.keys(families) as Family[]) {
      const root = join(source, "plugins", plugin, "data", family);
      if (!await oldDirectory(root)) continue;
      for (const qq of (await readdir(root)).sort()) {
        signal?.throwIfAborted();
        if (!qqDirectory.test(qq) || !await oldDirectory(join(root, qq))) continue;
        for (const name of (await readdir(join(root, qq))).sort()) {
          signal?.throwIfAborted();
          if (!families[family].test(name)) continue;
          const absolute = join(root, qq, name);
          const info = await statIfPresent(absolute);
          if (!info) sourceChanged();
          if (!info.isFile() || info.nlink !== 1 || info.size > maxFileBytes) {
            throw new Error($t("lib.migration-shared-game-history.text_3ef85f80f5", { "family": family }));
          }
          const key = join(family, qq, name);
          const group = leaves.get(key) ?? [];
          group.push({ family, plugin, qq, name, absolute, info });
          leaves.set(key, group);
        }
      }
    }
  }

  for (const group of leaves.values()) {
    const { qq, name, family } = group[0]!;
    const uid = name.slice(0, -5);
    const documents: Record<string, unknown>[] = [];
    const roots: string[] = [];
    for (const item of group) {
      signal?.throwIfAborted();
      const bytes = await readLeaf(item, signal);
      try {
        documents.push(parseHistory(bytes));
      } catch {
        throw new Error($t("lib.migration-shared-game-history.text_5cba2e0a77", { "family": family }));
      }
      const relative = join(migrationRoot, item.plugin, family);
      const root = join(stage, relative);
      const destination = join(root, qq, name);
      await privateDirectory(dirname(destination));
      await writeFile(destination, bytes, { mode: 0o600, flag: "wx" });
      roots.push(root);
      const total = totals.get(relative) ?? { path: relative, files: 0, bytes: 0 };
      total.files++;
      total.bytes += bytes.length;
      totals.set(relative, total);
    }
    try {
      if (family === "starRailGachaJson") {
        for (const row of documents) checkStarRail(row, qq, uid);
        if (documents.some(row => !isDeepStrictEqual(row, documents[0]))) throw new Error();
      } else if (family === "zzzGachaJson") {
        // This family is never published as a primary archive. Use the actual fallback merge and validation.
        if (!await readZzzFlatLegacyGacha(roots.map(root => join(root, qq)), uid)) throw new Error();
      } else {
        const region = documents[0]!.region;
        if (region !== "prod_gf_cn" && region !== "prod_qd_cn") throw new Error();
        const snapshots = documents.map(row => readZzzTuningHistory(row, { uid, region })!);
        const first = snapshots[0]!;
        if (snapshots.some(row => row.updatedAt === first.updatedAt && !isDeepStrictEqual(row, first))) throw new Error();
      }
    } catch {
      throw new Error($t("lib.migration-shared-game-history.text_a7e9a99df0", { "family": family }));
    }
  }
  for (const [path, info] of seenDirectories) {
    signal?.throwIfAborted();
    if (!unchanged(info, await statIfPresent(path)) || await realpath(path) !== path) sourceChanged();
  }
  for (const group of leaves.values()) {
    for (const { absolute, info } of group) {
      signal?.throwIfAborted();
      if (!unchanged(info, await statIfPresent(absolute))) sourceChanged();
    }
  }
  return [...totals.values()].sort((a, b) => a.path.localeCompare(b.path, "en"));
}
