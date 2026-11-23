import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { profileCookieAccountId, rasterImageSize, type createProfileStore } from "@lotus-yunzai/account";
import type { AcquireRoleArchiveLock } from "@lotus-yunzai/storage";
import { readMigrationSourceFile } from "./migration-files.ts";

type Game = "gs" | "sr";
type ProfileStore = Pick<ReturnType<typeof createProfileStore>, "requestContext">;
const root = fileURLToPath(new URL("../", import.meta.url));
const maximum = 8 * 1024 * 1024;
const uidPattern = /^[1-9]\d{8,9}$/u;
const characterId = /^[1-9]\d{0,9}$/u;
const elements = new Set(["anemo", "geo", "electro", "dendro", "hydro", "pyro"]);

function dictionary(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function scalar(value: unknown) {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value)) ? String(value) : "";
}
function safeName(value: unknown): value is string {
  return typeof value === "string" && !!value && Buffer.byteLength(value) <= 255 && value !== "." && value !== ".." &&
    !/[\/\\\p{Cc}\p{Cf}]/u.test(value);
}

async function legacyPlayer(game: Game, uid: string, signal: AbortSignal) {
  if (!uidPattern.test(uid)) return;
  const configured = game === "gs" ? Bun.env.LOTUS_GENSHIN_LEGACY_PANEL_DIR : Bun.env.LOTUS_STAR_RAIL_LEGACY_PANEL_DIR;
  const base = await realpath(resolve(configured?.trim() || join(root, "data", "PlayerData", game))).catch(() => undefined);
  if (!base) return;
  const file = await readMigrationSourceFile(base, join(base, uid + ".json"), maximum, signal);
  if (!file) return;
  const data = dictionary(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)) as unknown);
  const avatars = Array.isArray(data?.avatars) ? data.avatars : dictionary(data?.avatars);
  if (!data || scalar(data.uid) !== uid || !avatars) return;
  const ids = Object.values(avatars).map(value => scalar(dictionary(value)?.id)).filter(value => characterId.test(value));
  const first = ids.sort((a, b) => Number(a) - Number(b))[0];
  return { face: game === "gs" ? scalar(data.face) : "", first };
}

async function sourceArt(directory: string | undefined, game: Game, name: string | undefined, elem: unknown, signal: AbortSignal) {
  const base = directory && await realpath(resolve(directory)).catch(() => undefined);
  if (!base) return;
  const characterDir = join(base, `meta-${game}`, "character");
  async function read(...parts: string[]) {
    const file = await readMigrationSourceFile(base!, join(characterDir, ...parts), maximum, signal).catch(() => undefined);
    if (!file) return;
    const dimensions = rasterImageSize(file.bytes, "image/webp") ?? rasterImageSize(file.bytes, "image/png");
    if (dimensions?.every(side => side > 0 && side <= 4096)) return file.bytes;
  }
  const travelerElement = game === "gs" && (name === "空" || name === "荧" || name === "旅行者") &&
    typeof elem === "string" && elements.has(elem) ? elem : undefined;
  const image = safeName(name) ? read(name, "imgs", "face.webp") : undefined;
  const banner = game === "gs" && safeName(name)
    ? await (travelerElement ? read("旅行者", travelerElement, "imgs", "banner.webp") : read(name, "imgs", "banner.webp"))
    : undefined;
  return { image: await image, banner: banner ?? await read("common", "imgs", "banner.webp") };
}

export function createOwnRoleLegacyArtwork(profiles: ProfileStore, lockFile: AcquireRoleArchiveLock) {
  async function loadGenshin() {
    const [{ createGenshinPanelArchive }, { readPanelTheme }, { findRankCharacter }] = await Promise.all([
      import("../plugins/genshin/panel/panel.ts"), import("../plugins/genshin/panel/theme.ts"),
      import("../plugins/genshin/rank-statistics/stats.ts"),
    ]);
    return { archive: createGenshinPanelArchive(lockFile), theme: await readPanelTheme(), findRankCharacter };
  }
  async function loadStarRail() {
    const [{ createStarRailPanelArchive, panelDiscardedAt }, { readTheme }, { default: names }] = await Promise.all([
      import("../plugins/starrail/panel-discard.ts"), import("../plugins/starrail/panel-card.ts"),
      import("../plugins/starrail/challenge-character-names.json"),
    ]);
    return { archive: createStarRailPanelArchive(lockFile), theme: await readTheme(), panelDiscardedAt,
      names: names as Readonly<Record<string, string>> };
  }
  let genshin: ReturnType<typeof loadGenshin> | undefined;
  let starRail: ReturnType<typeof loadStarRail> | undefined;

  return async (qq: string, id: number, game: "gs" | "sr" | "zzz", uid: string, signal: AbortSignal) => {
    if (game === "zzz" || signal.aborted) return;
    try {
      const source = await profiles.requestContext(qq, id, game, uid);
      const account = profileCookieAccountId(source.account);
      if (!account || source.role.uid !== uid || signal.aborted) return;
      const player = await legacyPlayer(game, uid, signal);
      if (!player || signal.aborted) return;

      let directory: string | undefined;
      let name: string | undefined;
      let elem: unknown;
      let discarded: () => Promise<number>;
      if (game === "gs") {
        const { archive, theme, findRankCharacter } = await (genshin ??= loadGenshin());
        discarded = () => archive.discardedAt(qq, uid);
        directory = theme.resourceRoot;
        for (const character of [player.face, player.first]) {
          if (!character) continue;
          const known = findRankCharacter(character);
          const meta = dictionary(theme.characters[known?.id ?? character]);
          const matched = scalar(meta?.name) || known?.name;
          if (safeName(matched)) {
            name = matched;
            elem = meta?.elem;
            break;
          }
        }
      } else {
        const { archive, theme, panelDiscardedAt, names } = await (starRail ??= loadStarRail());
        discarded = () => archive.read(qq, uid).then(panelDiscardedAt);
        directory = theme.root;
        if (player.first) {
          name = scalar(dictionary(theme.characters[player.first])?.name) || names[player.first];
        }
      }

      if (signal.aborted || await discarded()) return;
      const artwork = await sourceArt(directory, game, name, elem, signal);
      if (!artwork || signal.aborted || await discarded()) return;
      const current = await profiles.requestContext(qq, id, game, uid);
      if (current.revision === source.revision && current.role.uid === uid && profileCookieAccountId(current.account) === account && !signal.aborted) return artwork;
    } catch {
      // 缺档、换绑和旧素材失效都交回现在的 UID 卡头像回退。
    }
  };
}
