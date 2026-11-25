import "../lib/i18n-preload.ts";
import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, open, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import YAML, { isMap, isNode, isScalar, isSeq } from "yaml";
import { configuredTargets, numberId } from "../plugins/notice/mys-announcement-config.ts";
import { effectiveAnnouncementTargets } from "../plugins/notice/mys-announcement.ts";

const games = ["gs", "sr"] as const;
type Game = typeof games[number];
type Group = number | string;
type Routes = Record<string, Group[]>;
const yamlKey = (game: Game) => `${game}ActivityPush`;
const maxBytes = 512 * 1024;

function mapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readSnapshot(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error($t("scripts.prepare-legacy-activity-notices.text_82c586164c"));
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw new Error($t("scripts.prepare-legacy-activity-notices.text_b3d41656d4"));
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, offset));
  } finally {
    await file.close();
  }
}

function hashSnapshot(text: string): Record<string, string> {
  const data: unknown = JSON.parse(text);
  if (!mapping(data)) throw new Error($t("scripts.prepare-legacy-activity-notices.text_e2ed523e39"));
  for (const [key, state] of Object.entries(data)) {
    const [bot, group, extra] = key.split(":");
    if (!numberId(bot) || !numberId(group) || extra !== undefined || (state !== "on" && state !== "off")) {
      throw new Error($t("scripts.prepare-legacy-activity-notices.text_d0c38f2155"));
    }
  }
  return data as Record<string, string>;
}

function editRoutes(document: ReturnType<typeof YAML.parseDocument>, key: string, original: Routes, next: Routes) {
  const source = document.get(key, true);
  if (!isMap(source)) {
    const replacement = document.createNode(next);
    if (source) {
      replacement.commentBefore = source.commentBefore;
      replacement.comment = source.comment;
    }
    document.set(key, replacement);
    return;
  }

  for (const bot of new Set([...Object.keys(original), ...Object.keys(next)])) {
    const groups = next[bot];
    if (isDeepStrictEqual(original[bot], groups)) continue;
    const pair = source.items.find(({ key }) => isScalar(key) && String(key.value) === bot);
    if (!groups) {
      if (pair) source.delete(pair.key);
      continue;
    }
    const row = pair?.value;
    if (isSeq(row)) {
      row.items = groups.map(group => row.items.find(item => isScalar(item) && item.value === group) ?? document.createNode(group));
    } else if (pair) {
      const replacement = document.createNode(groups);
      if (isNode(row)) {
        replacement.commentBefore = row.commentBefore;
        replacement.comment = row.comment;
      }
      pair.value = replacement;
    } else source.set(bot, document.createNode(groups));
  }
}

async function prepareActivityNotices(yaml: string, overrides: Record<Game, Record<string, string>>) {
  const document = YAML.parseDocument(yaml);
  if (document.errors.length || !isMap(document.contents)) throw new Error($t("scripts.prepare-legacy-activity-notices.text_4d866b1e5b"));
  const original: Record<string, unknown> = document.toJS();
  const oldRoutes = Object.fromEntries(games.map(game => [game, original[yamlKey(game)] ?? {}])) as Record<Game, Routes>;
  const defaults = { gs: configuredTargets(oldRoutes.gs), sr: configuredTargets(oldRoutes.sr) };
  const effective: Record<Game, Routes> = { gs: {}, sr: {} };
  const counts = { gs: 0, sr: 0 };

  for (const game of games) {
    const targets = await effectiveAnnouncementTargets({
      async hGetAll() { return overrides[game]; },
    }, defaults[game], yamlKey(game));
    counts[game] = targets.length;
    for (const { botId, groupId } of targets) {
      const raw = oldRoutes[game][botId]?.find(group => numberId(group) === groupId);
      const other = oldRoutes[game === "gs" ? "sr" : "gs"][botId]?.find(group => numberId(group) === groupId);
      (effective[game][botId] ??= []).push(raw ?? other ?? groupId);
    }
  }
  // The old worker initializes its shared daily queue from the Star Rail list if the bot has both.
  for (const [bot, groups] of Object.entries(effective.gs)) {
    const starRail = effective.sr[bot];
    if (starRail && groups.some(group => !starRail.includes(group))) {
      throw new Error($t("scripts.prepare-legacy-activity-notices.text_96e49a7140", { "bot": bot }));
    }
  }

  const changed = games.filter(game => !isDeepStrictEqual(oldRoutes[game], effective[game]));
  if (!changed.length) return { content: yaml, counts, changed };
  for (const game of changed) editRoutes(document, yamlKey(game), oldRoutes[game], effective[game]);
  const content = document.toString();
  if (Buffer.byteLength(content) > maxBytes) throw new Error($t("scripts.prepare-legacy-activity-notices.text_eb69b61ec2"));
  const rest = (obj: Record<string, unknown>) => Object.fromEntries(Object.entries(obj).filter(([key]) =>
    !games.some(game => key === yamlKey(game))));
  try {
    const exported: Record<string, unknown> = YAML.parse(content);
    if (isDeepStrictEqual(rest(original), rest(exported)) && games.every(game =>
      isDeepStrictEqual(exported[yamlKey(game)] ?? {}, effective[game]))) return { content, counts, changed };
  } catch {}
  throw new Error($t("scripts.prepare-legacy-activity-notices.text_58fc358b09"));
}

async function exportConfig(parent: string, content: string) {
  const directory = await realpath(parent);
  const hash = createHash("sha256").update(content).digest("hex");
  const path = join(directory, `mys-activity-${hash}.yaml`);
  const temporary = join(directory, `.mys-activity-${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(content);
      await file.sync();
    } finally { await file.close(); }
    try { await link(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!Buffer.from(await readSnapshot(path)).equals(Buffer.from(content))) {
        throw new Error($t("scripts.prepare-legacy-activity-notices.text_7247a7951f"));
      }
      return { path, written: false };
    }
    const parentDirectory = await open(directory, constants.O_DIRECTORY);
    try { await parentDirectory.sync(); } finally { await parentDirectory.close(); }
    return { path, written: true };
  } finally { await unlink(temporary); }
}

const args = process.argv.slice(2);
const exporting = args[0] === "--export";
const [parent, yaml, gs, sr] = exporting ? args.slice(1) : [undefined, ...args];
if (!yaml || !gs || !sr || args.length !== (exporting ? 5 : 3) ||
    [yaml, gs, sr, parent].some(arg => arg?.startsWith("--")) || (exporting && !parent)) {
  console.error($t("scripts.prepare-legacy-activity-notices.text_87ba1f0ef6"));
  process.exit(2);
}

try {
  const [source, genshin, starRail] = await Promise.all([readSnapshot(yaml), readSnapshot(gs), readSnapshot(sr)]);
  const { content, counts, changed } = await prepareActivityNotices(source, { gs: hashSnapshot(genshin), sr: hashSnapshot(starRail) });
  const output = parent ? await exportConfig(parent, content) : { written: false };
  console.log(JSON.stringify({ mode: exporting ? "export" : "dry-run", counts, changed, ...output }));
} catch (error) {
  console.error(error instanceof SyntaxError ? $t("scripts.prepare-legacy-activity-notices.text_530038e2aa")
    : error instanceof Error && !("code" in error) ? error.message : $t("scripts.prepare-legacy-activity-notices.text_c3682a82db"));
  process.exitCode = 1;
}
