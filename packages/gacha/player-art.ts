import { createTranslator as createTextTranslator } from "../i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("gacha", messageCatalog.messages);
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { rasterImageSize } from "../account/index.ts";
import { readMigrationSourceFile } from "../../lib/migration-files.ts";
import { loadOfficialArtwork } from "../account/official-artwork.ts";

type Game = "gs" | "sr";
type Character = { readonly id: string | number; readonly name: string; readonly abbr?: string };

const defaults = { gs: [$t("player-art.text_ef09301bf5"), $t("player-art.text_8dac86c16f")], sr: [$t("player-art.text_6cc5e43b1b")] } as const;

export function gachaPortraitCharacter(characters: Iterable<Character>, hint: unknown) {
  if (typeof hint !== "number" && typeof hint !== "string") return;
  const text = String(hint).trim();
  if (!text) return;
  const rows = [...characters];
  const exact = rows.find(({ id, name }) => String(id) === text || name === text);
  if (exact) return exact.name;
  const abbreviated = rows.filter(({ abbr }) => abbr === text);
  if (abbreviated.length === 1) return abbreviated[0]!.name;
}

export async function readGachaPlayerArt(directory: string, game: Game, name: string,
  character?: string, officialAvatar?: string, signal?: AbortSignal, qFace = true) {
  const root = await realpath(directory).catch(() => undefined);
  function characterPath(character: string, file: string) {
    return `/meta-${game}/character/${character}/imgs/${file}`;
  }
  async function art(character: string | undefined, file: string) {
    if (!root || !character || character === "." || character === ".." || /[\/\\\p{Cc}\p{Cf}]/u.test(character)) return;
    const path = characterPath(character, file);
    const image = await readMigrationSourceFile(root, join(root, path.slice(1)), 8 * 1024 * 1024, signal).catch(() => undefined);
    if (!image) return;
    const size = rasterImageSize(image.bytes, "image/webp") ?? rasterImageSize(image.bytes, "image/png");
    if (size?.every(side => side > 0 && side <= 4096)) return path;
  }
  async function icon(candidate: string | undefined) {
    return (qFace ? await art(candidate, "face-q.webp") : undefined) ?? await art(candidate, "face.webp");
  }

  const selected = await icon(character);
  if (selected) {
    return {
      face: { name, face: selected, banner: game === "gs" ? await art(character, "banner.webp") : undefined },
      avatar: undefined,
    };
  }
  for (const fallback of defaults[game]) {
    const face = await icon(fallback);
    if (face) return { face: { name, face, banner: game === "gs" ? await art(fallback, "banner.webp") : undefined }, avatar: undefined };
  }
  const avatar = officialAvatar ? (await loadOfficialArtwork([officialAvatar], { signal })).values().next().value : undefined;
  return { face: { name }, avatar };
}
