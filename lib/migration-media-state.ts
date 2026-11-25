import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseBiliLocal } from "../plugins/media/services/subscriptions/session.ts";
import { TuneWeaveService } from "../plugins/media/services/tuneweave/service.ts";
import { legacyLotusDirectories } from "./lotus-global-config.ts";
import { readMigrationSourceFile } from "./migration-files.ts";
import { projectLegacyMediaConfig } from "./migration-media-config.ts";
import { withinInstallation } from "./plugins/migration-plan.ts";
import { readFirstGenerationGlobal } from "./migration-lotus-v1.ts";

type Fields = Record<string, unknown>;
type MediaStateOptions = { tuneweaveUrl?: string; signal?: AbortSignal };
type Found = { readonly prefix: string; readonly bytes: Buffer };
type StateRule = { readonly limit: number; readonly validate: (value: unknown) => boolean;
  readonly tuneweaveBound?: (value: unknown) => boolean };

const defaultTuneWeave = "http://127.0.0.1:7832";
const localStore = "data/tuneweave/accounts";
const prefixes = ["", ...legacyLotusDirectories.map(id => "plugins/" + id)];
const subscriptionFiles = ["config", "push", "config.guoba.support", "push.guoba.support"]
  .flatMap(name => ["bilibili", "weibo"].map(provider => `data/yuki-plugin/config/${provider}/${name}.yaml`));
const maxAccounts = 4 * 1024 * 1024;
const maxLocalTotal = 128 * 1024 * 1024;

function mapping(value: unknown): value is Fields {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function optionalStrings(value: Fields, keys: readonly string[]) {
  return keys.every(key => value[key] == null || typeof value[key] === "string");
}

function optionalIdentifier(value: unknown) {
  return value == null || typeof value === "string" || typeof value === "number" && Number.isSafeInteger(value);
}

function partnerAccounts(value: unknown) {
  if (!mapping(value) || value.accounts != null && !Array.isArray(value.accounts)) return false;
  const uids = new Set<string>();
  const aliases = new Set<string>();
  for (const account of (value.accounts ?? []) as unknown[]) {
    if (!mapping(account) || !optionalStrings(account, ["tuneweave_account", "cookie", "nickname"]) ||
        !optionalIdentifier(account.uid) || !optionalIdentifier(account.qq)) return false;
    const uid = String(account.uid ?? "");
    const alias = String(account.tuneweave_account ?? "");
    if (uid && uids.has(uid) || alias && aliases.has(alias)) return false;
    if (uid) uids.add(uid);
    if (alias) aliases.add(alias);
  }
  return true;
}

const rules: Record<string, StateRule> = {
  "data/bilibili/account.yaml": {
    limit: 64 * 1024,
    validate: value => mapping(value) && optionalStrings(value, ["cookie", "tuneweave_account"]),
    tuneweaveBound: value => mapping(value) && !!value.tuneweave_account,
  },
  "data/music/accounts.yaml": {
    limit: maxAccounts,
    validate: value => mapping(value) && (value.accounts == null ||
      mapping(value.accounts) && Object.values(value.accounts).every(item => item == null ||
        mapping(item) && optionalStrings(item, ["alias", "nickname", "credential"]) && optionalIdentifier(item.uid))),
    tuneweaveBound: () => true,
  },
  "data/netease/accounts.yaml": {
    limit: maxAccounts,
    validate: partnerAccounts,
    tuneweaveBound: () => true,
  },
  "data/netease/state.yaml": { limit: maxAccounts, validate: mapping },
  "data/yuki-plugin/biliCookie.yaml": { limit: 32_768, validate: value => !!parseBiliLocal(value) },
  ...Object.fromEntries(subscriptionFiles.map(path => [path, { limit: maxAccounts, validate: mapping }])),
};

function decode(bytes: Buffer) {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function endpoint(value: unknown) {
  const raw = typeof value === "string" && value ? value : defaultTuneWeave;
  const url = URL.parse(raw);
  if (url && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash) {
    const identity = url.href.replace(/\/+$/u, "");
    try {
      new TuneWeaveService({ config: { api_url: raw } }).localUrl();
      return { identity, local: true };
    } catch {
      return { identity, local: false };
    }
  }
}

/** Writes verified media state under the migration's private stage. */
export async function stageLegacyMediaState(sourcePath: string, stagePath: string, { tuneweaveUrl, signal }: MediaStateOptions = {}) {
  const [source, stage] = await Promise.all([realpath(sourcePath), realpath(stagePath)]);
  const info = await lstat(stage);
  if (withinInstallation(source, stage) || withinInstallation(stage, source) || !info.isDirectory() || info.mode & 0o077) {
    throw new Error($t("lib.migration-media-state.text_0cc4bc3ac1"));
  }
  const destinationEndpoint = endpoint(tuneweaveUrl);
  const active: { path: string; files: number }[] = [];
  const held: { path: string; files: number; reason: "format" | "endpoint" | "conflict" }[] = [];
  const read = (path: string, maximum: number) => readMigrationSourceFile(source, join(source, path), maximum, signal);
  const sourceSettings = new Map<string, Fields | undefined>();
  const firstGenerationSettings = new Map<string, Awaited<ReturnType<typeof readFirstGenerationGlobal>>>();
  async function firstGenerationBytes(prefix: string, path: string) {
    if (path !== "data/netease/accounts.yaml" && path !== "data/bilibili/account.yaml") return;
    if (!firstGenerationSettings.has(prefix)) {
      firstGenerationSettings.set(prefix, await readFirstGenerationGlobal(source, prefix, undefined, signal));
    }
    const raw = firstGenerationSettings.get(prefix)?.raw;
    if (!raw) return;
    if (path === "data/netease/accounts.yaml") {
      const partner = mapping(raw.neteasePartner) ? raw.neteasePartner : undefined;
      if (Array.isArray(partner?.accounts) && partner.accounts.length) {
        return Buffer.from(Bun.YAML.stringify({ accounts: partner.accounts }));
      }
    } else {
      const bilibili = mapping(raw.bilibili) ? raw.bilibili : undefined;
      const cookie = bilibili?.cookie ?? bilibili?.sessdata ?? bilibili?.sessData;
      if (typeof cookie === "string" && cookie.trim()) {
        return Buffer.from(Bun.YAML.stringify({ cookie: cookie.includes("=") ? cookie : `SESSDATA=${cookie}` }));
      }
    }
  }
  async function readGlobal(prefix: string): Promise<Fields | undefined> {
    if (sourceSettings.has(prefix)) return sourceSettings.get(prefix);
    for (const name of ["config/global.yaml", "config/config/global.yaml"]) {
      const snapshot = await read(join(prefix, name), 256 * 1024);
      if (!snapshot) continue;
      try {
        const root: unknown = Bun.YAML.parse(decode(snapshot.bytes));
        if (mapping(root) || root == null) {
          const result = root ?? {};
          sourceSettings.set(prefix, result);
          return result;
        }
      } catch {}
      sourceSettings.set(prefix, undefined);
      return;
    }
    const missing = {};
    sourceSettings.set(prefix, missing);
    return missing;
  }

  async function sourceEndpoint(prefix: string) {
    const current = await readGlobal(prefix);
    if (!current) return;
    if (prefix || Object.hasOwn(current, "tuneweave")) {
      return endpoint(mapping(current.tuneweave) ? current.tuneweave.api_url : undefined);
    }
    const legacy = await Promise.all(prefixes.slice(1).map(readGlobal));
    if (legacy.some(value => !value)) return;
    try {
      const { config } = projectLegacyMediaConfig(current, legacy as Fields[]);
      return endpoint(mapping(config.tuneweave) ? config.tuneweave.api_url : undefined);
    } catch {
      return;
    }
  }

  async function ensureDirectory(directory: string): Promise<void> {
    if (directory === stage) return;
    await ensureDirectory(dirname(directory));
    await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const details = await lstat(directory);
    if (!details.isDirectory() || details.mode & 0o077 || await realpath(directory) !== directory) {
      throw new Error($t("lib.migration-media-state.text_2731c4a2cd"));
    }
  }

  async function write(relativePath: string, bytes: Buffer) {
    signal?.throwIfAborted();
    const path = join(stage, relativePath);
    await ensureDirectory(dirname(path));
    await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
  }

  for (const [path, rule] of Object.entries(rules)) {
    const candidates: Found[] = [];
    // Subscription files have only ever been exposed under the shared data root.
    const roots = path.startsWith("data/yuki-plugin/") ? [""] : prefixes;
    for (const prefix of roots) {
      const current = await read(join(prefix, path), rule.limit);
      if (current) candidates.push({ prefix, bytes: current.bytes });
      else {
        const bytes = await firstGenerationBytes(prefix, path);
        if (bytes) candidates.push({ prefix, bytes });
      }
    }
    if (!candidates.length) continue;
    const first = candidates[0]!;
    const considered = first.prefix === "" ? [first] : candidates;
    let reason: (typeof held)[number]["reason"] | undefined;
    for (const candidate of considered) {
      let value: unknown;
      try {
        value = Bun.YAML.parse(decode(candidate.bytes));
        if (!rule.validate(value)) { reason = "format"; break; }
      } catch { reason = "format"; break; }
      if (rule.tuneweaveBound?.(value) &&
          (!destinationEndpoint || (await sourceEndpoint(candidate.prefix))?.identity !== destinationEndpoint.identity)) {
        reason = "endpoint";
        break;
      }
      if (!first.bytes.equals(candidate.bytes)) { reason = "conflict"; break; }
    }
    if (reason) {
      for (const file of considered) await write(join("backup/media-state", file.prefix, path), file.bytes);
      held.push({ path, files: considered.length, reason });
    } else {
      await write(path, first.bytes);
      active.push({ path, files: 1 });
    }
  }

  // A managed TuneWeave binary persists only its account data here; PID files and binaries are installation-specific.
  const snapshots: { prefix: string; entries: Map<string, Buffer>; supported: boolean }[] = [];
  let bytesRead = 0;
  for (const prefix of prefixes) {
    const root = join(source, prefix, localStore);
    const stats = await lstat(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (!stats) continue;
    const entries = new Map<string, Buffer>();
    let supported = true;
    async function visit(path: string, depth: number) {
      signal?.throwIfAborted();
      const directory = join(root, path);
      if (depth > 8 || await realpath(directory) !== directory || !(await lstat(directory)).isDirectory()) {
        throw new Error($t("lib.migration-media-state.text_f696581a6d"));
      }
      for (const name of (await readdir(directory)).sort()) {
        const relativePath = join(path, name);
        const file = join(directory, name);
        if ((await lstat(file)).isDirectory()) await visit(relativePath, depth + 1);
        else {
          const record = await read(join(prefix, localStore, relativePath), maxAccounts);
          if (!record) throw new Error($t("lib.migration-media-state.text_a7e096f7bf"));
          bytesRead += record.bytes.length;
          if (entries.size >= 4096 || bytesRead > maxLocalTotal) throw new Error($t("lib.migration-media-state.text_4bdcee847c"));
          // TuneWeave leaves an empty flock inode beside its credential JSON files.
          // Preserve the original for audit, but let the new process create its own lock.
          if (relativePath === join("accounts", ".credential-store.lock") && !record.bytes.length) {
            await write(join("backup/media-state", prefix, localStore, relativePath), record.bytes);
            continue;
          }
          if (!name.endsWith(".json")) supported = false;
          else try { JSON.parse(decode(record.bytes)); } catch { supported = false; }
          entries.set(relativePath, record.bytes);
        }
      }
    }
    await visit("", 0);
    if (entries.size) snapshots.push({ prefix, entries, supported });
  }
  const first = snapshots[0];
  if (first) {
    const considered = first.prefix === "" ? [first] : snapshots;
    let reason: (typeof held)[number]["reason"] | undefined;
    for (const candidate of considered) {
      if (!candidate.supported) { reason = "format"; break; }
      const previous = await sourceEndpoint(candidate.prefix);
      if (!destinationEndpoint?.local || !previous?.local || previous.identity !== destinationEndpoint.identity) {
        reason = "endpoint";
        break;
      }
      if (first.entries.size !== candidate.entries.size ||
          [...candidate.entries].some(([name, bytes]) => !first.entries.get(name)?.equals(bytes))) {
        reason = "conflict";
        break;
      }
    }
    if (reason) {
      for (const { prefix, entries } of considered) {
        for (const [name, bytes] of entries) await write(join("backup/media-state", prefix, localStore, name), bytes);
      }
      held.push({ path: localStore, files: considered.reduce((total, item) => total + item.entries.size, 0), reason });
    } else {
      for (const [name, bytes] of first.entries) await write(join(localStore, name), bytes);
      active.push({ path: localStore, files: first.entries.size });
    }
  }
  return { active, held };
}
