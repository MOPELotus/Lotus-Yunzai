import { lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { importProfiles, MAX_PROFILE_ID } from "../packages/account/index.ts";
import { legacyLotusDirectories, normalizeLotusGlobalConfig } from "./lotus-global-config.ts";
import { MigrationSourceFileError, readMigrationSourceFile } from "./migration-files.ts";

export const firstGenerationPrefixes = ["", ...legacyLotusDirectories.map(name => `plugins/${name}`)] as const;
type Fields = Record<string, unknown>;
function fields(value: unknown): Fields { return value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {}; }
function invalid(): never { throw new MigrationSourceFileError("unsafe"); }
function parse(bytes: Buffer): Fields {
  let value: unknown;
  try { value = Bun.YAML.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { invalid(); }
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Fields;
}

/** A directory name alone cannot distinguish Lotus 1 from a renamed ReFactor checkout. */
export async function hasFirstGenerationLayout(source: string, prefix: string) {
  const path = join(source, prefix, "MihoyoBBSTools/config");
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  if (!info) return false;
  if (!info.isDirectory() || await realpath(path) !== path) invalid();
  return true;
}

async function preserve(stage: string, prefix: string, path: string, bytes: Buffer) {
  const destination = join(stage, "backup/legacy-lotus-v1", prefix, path);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, bytes, { mode: 0o600, flag: "wx" });
}

export async function readFirstGenerationGlobal(source: string, prefix: string, stage?: string, signal?: AbortSignal) {
  if (!await hasFirstGenerationLayout(source, prefix)) return;
  const path = "config/config.yaml";
  const file = await readMigrationSourceFile(source, join(source, prefix, path), 256 * 1024, signal);
  if (!file) return;
  const raw = parse(file.bytes);
  if (stage) await preserve(stage, prefix, path, file.bytes);
  const projected = normalizeLotusGlobalConfig(raw);
  const partner = fields(raw.neteasePartner);
  if (Object.keys(partner).length && !Object.hasOwn(projected, "netease_partner")) {
    projected.netease_partner = { ...partner, auto_catch_up: partner.autoCatchUp ?? partner.auto_catch_up };
  }
  return { raw, projected };
}

function projectProfile(raw: Fields, qq: string, id: number) {
  const account = fields(raw.account), device = fields(raw.device), community = fields(raw.mihoyobbs);
  const oldUser = fields(raw.user), oldProfile = fields(raw.profile);
  if (oldUser.qq !== undefined && String(oldUser.qq) !== qq || oldProfile.id !== undefined && Number(oldProfile.id) !== id) invalid();
  const schedule = typeof raw.schedule === "string" ? fields(normalizeLotusGlobalConfig({ schedule: raw.schedule }).scheduler) : fields(raw.schedule);
  const tasks = Object.keys(fields(community.tasks)).length ? fields(community.tasks) : {
    checkin: community.checkin === true, read: community.read !== false, like: community.like !== false,
    cancel_like: community.cancel_like !== false, share: community.share !== false,
  };
  return { ...raw, version: 1, enabled: raw.enable !== false,
    user: { ...oldUser, qq }, profile: { ...oldProfile, id,
      notify: { enable: true, prefer: "private", fallback_groups: [], ...fields(oldProfile.notify) } },
    account: { ...account, ltuid: account.ltuid ?? account.stuid ?? "" },
    device: { ...device, bound: Boolean(device.id && device.fp), raw: device.raw ?? { ...device } },
    mihoyobbs: { ...community, enable: community.enable !== false, tasks },
    ...(Object.keys(schedule).length && { schedule }),
  };
}

/** Convert only recognized first-generation YAML leaves, and keep their exact source bytes privately. */
export async function stageFirstGenerationProfiles(source: string, stage: string, signal?: AbortSignal) {
  const result = { sources: 0, imported: 0, unchanged: 0, deferredPush: 0 };
  for (const prefix of firstGenerationPrefixes) {
    if (!await hasFirstGenerationLayout(source, prefix)) continue;
    signal?.throwIfAborted();
    const path = "MihoyoBBSTools/config";
    const temporary = await mkdtemp(join(stage, ".lotus-v1-profiles-"));
    let count = 0;
    try {
      for (const name of (await readdir(join(source, prefix, path))).sort()) {
        const match = /^([1-9]\d{0,18})(?:-([1-9]\d{0,2}))?\.ya?ml$/iu.exec(name);
        if (!match) continue;
        const qq = match[1]!, id = Number(match[2] ?? 1);
        if (id > MAX_PROFILE_ID) invalid();
        const file = await readMigrationSourceFile(source, join(source, prefix, path, name), 4 * 1024 * 1024, signal);
        if (!file) throw new MigrationSourceFileError("changed");
        const raw = parse(file.bytes);
        const projected = projectProfile(raw, qq, id);
        await preserve(stage, prefix, join(path, name), file.bytes);
        // Nonempty `push` is an external push-provider configuration, not a QQ group ID.
        // Keep it intact; do not silently reinterpret it as a recipient or send to it.
        if (raw.push !== undefined && raw.push !== "" && raw.push !== null) result.deferredPush++;
        const targetName = `${qq}${id === 1 ? "" : `-${id}`}.yaml`;
        const existing = await readMigrationSourceFile(stage, join(temporary, targetName), 4 * 1024 * 1024, signal);
        if (existing && !isDeepStrictEqual(parse(existing.bytes), projected)) invalid();
        if (!existing) await writeFile(join(temporary, targetName), Bun.YAML.stringify(projected), { mode: 0o600, flag: "wx" });
        count++;
      }
      if (count) {
        const imported = await importProfiles(temporary, join(stage, "data/users"), true);
        if (imported.invalid || imported.conflict) invalid();
        result.sources++;
        result.imported += imported.imported;
        result.unchanged += imported.unchanged;
      }
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  return result;
}
