import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { gameCommandProfileId, MAX_PROFILE_ID, ProfileError, type createProfileStore } from "@lotus-yunzai/account";
import { previewRedeemIdentity } from "@lotus-yunzai/hoyo-client/redeem-submit";
import { lockFile } from "./file-lock.ts";
import { postArkQuery, type RankStatsTransport } from "./rank-statistics.ts";

type Game = "gs" | "sr";
type ProfileStore = Pick<ReturnType<typeof createProfileStore>, "requestSelectedContext">;
type SavedCharacter = { readonly id: string | number; readonly name: string };
type ReadCharacters = (game: Game, qq: string, uid: string) => Promise<readonly SavedCharacter[] | undefined>;

const rankCommand = /^(\*|#(?:原神|星铁)?)总排名([\s\S]*)$/u;
const rankArguments = /^(?:(?:(?:UID\s*)?([1-9]\d{8,9})(?:\s+档案\s*([1-9]\d{0,2}))?|(?:档案\s*)?([1-9]\d{0,2}))\s*)?(确认)?$/iu;
const maxCharacters = 256;
const uidPattern = /^[1-9]\d{8,9}$/u;

export const arkSelfRankFeatures = {
  gs: [$t("lib.ark-self-rank.text_02d840296f"), "genshin", "@lotus-yunzai/genshin"],
  sr: [$t("lib.ark-self-rank.text_32b3c5b01c"), "starrail", "@lotus-yunzai/starrail"],
} as const;

export function matchArkSelfRank(message: string) {
  const input = rankCommand.exec(message);
  if (!input) return;
  const game: Game = input[1] === "#星铁" || input[1] === "*" ? "sr" : "gs";
  const args = rankArguments.exec(input[2]!.trim());
  const profileId = gameCommandProfileId(game, args?.[2] ?? args?.[3]);
  return { game, profileId, ...(args?.[1] && { uid: args[1] }), valid: Boolean(args) && profileId <= MAX_PROFILE_ID,
    confirmed: args?.[4] === "确认" };
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function number(value: unknown) {
  return typeof value === "string" && /^\d{1,16}(?:\.\d{1,16})?$/u.test(value) ? Number(value) : value;
}

function businessError(code: unknown) {
  switch (code) {
    case -1: return $t("lib.ark-self-rank.text_7d9893c56b");
    case 104:
    case 201: return $t("lib.ark-self-rank.text_e741543f56");
    case 101:
    case 102:
    case 202: return $t("lib.ark-self-rank.text_2cde3022ac");
    case 103:
    case 301: return $t("lib.ark-self-rank.text_34cf4038d4");
    default: return $t("lib.ark-self-rank.text_8b092e2cd0");
  }
}

function characterList(avatars: readonly SavedCharacter[]) {
  const ids = new Map<string, string>();
  for (const { id, name } of avatars) {
    const key = String(id);
    if (!/^[1-9]\d{0,11}$/u.test(key) || ids.has(key)) continue;
    const label = typeof name === "string" ? name.toWellFormed().replace(/[\p{Cc}\p{Cf}]/gu, " ").trim().slice(0, 40) : "";
    ids.set(key, label || $t("lib.ark-self-rank.text_954cad9970", { "key": key }));
  }
  return ids;
}

function readRanking(payload: unknown, gameName: string, uid: string, characters: ReadonlyMap<string, string>) {
  const response = record(payload);
  if (response?.retcode !== 100) return businessError(response?.retcode);
  if (!Array.isArray(response.rank) || response.rank.length !== characters.size) return $t("lib.ark-self-rank.text_e7d5d19b03");
  const result: string[] = [];
  let unknown = 0;
  let missing = 0;
  let limited = false;
  for (const [index, [id, name]] of [...characters].entries()) {
    const row = record(response.rank[index]);
    if (!row || (row.id !== undefined && String(row.id) !== id)) { unknown++; continue; }
    if (row.retcode === 101 || row.retcode === 102) { missing++; continue; }
    if (row.retcode === 104 || row.retcode === 201) { unknown++; limited = true; continue; }
    const rank = number(row.rank);
    const score = number(row.score);
    if (row.retcode !== 100 || typeof rank !== "number" || !Number.isSafeInteger(rank) || rank < 1 ||
        typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > Number.MAX_SAFE_INTEGER) {
      unknown++;
      continue;
    }
    result.push($t("lib.ark-self-rank.text_462efd86da", { "name": name, "rank": rank, "value3": score.toFixed(2) }));
  }
  if (!result.length) {
    if (limited) return businessError(104);
    return unknown ? $t("lib.ark-self-rank.text_275e4c6bc4") : $t("lib.ark-self-rank.text_8d2bef1a3a");
  }
  const heading = $t("lib.ark-self-rank.text_264768d4c7", { "uid": uid, "gameName": gameName });
  if (missing) result.push($t("lib.ark-self-rank.text_ac9fed8345", { "missing": missing }));
  if (unknown) result.push($t("lib.ark-self-rank.text_51a40cbd04", { "unknown": unknown, "value2": limited ? $t("lib.ark-self-rank.text_52a0c88f8e") : "" }));
  const rowsPerMessage = 30;
  if (result.length <= rowsPerMessage) return [heading, ...result].join("\n");
  const pages = Math.ceil(result.length / rowsPerMessage);
  return Array.from({ length: pages }, (_, i) =>
    [`${heading}（${i + 1}/${pages}）`, ...result.slice(i * rowsPerMessage, (i + 1) * rowsPerMessage)].join("\n"));
}

async function readSavedCharacters(game: Game, qq: string, uid: string): Promise<readonly SavedCharacter[] | undefined> {
  if (game === "gs") {
    const [{ createGenshinPanelArchive }, { readPanelTheme }] = await Promise.all([
      import("../plugins/genshin/panel/panel.ts"), import("../plugins/genshin/panel/theme.ts"),
    ]);
    const archive = createGenshinPanelArchive(lockFile);
    const snapshot = await archive.readPanel(qq, uid, await readPanelTheme());
    if (snapshot?.uid === uid) return Object.values(snapshot.avatars).filter(avatar =>
      avatar.weapon?.promote !== undefined && Object.keys(avatar.talent).length > 0);
    return;
  }
  const { createStarRailPersonalPanelReader } = await import("../plugins/starrail/panel.ts");
  const snapshot = await createStarRailPersonalPanelReader(lockFile)(qq, uid);
  if (snapshot?.uid === uid) return snapshot.avatars;
}

export function createArkSelfRankCommand(profiles: ProfileStore,
  { readCharacters = readSavedCharacters, transport = fetch }: { readCharacters?: ReadCharacters; transport?: RankStatsTransport } = {}) {
  const running = new Set<string>();
  return async (command: NonNullable<ReturnType<typeof matchArkSelfRank>>, session?: {
    readonly user: number;
    readonly signal: AbortSignal;
    readonly isCurrent: () => boolean;
    readonly privateFriend: boolean;
  }) => {
    const { game, profileId } = command;
    const prefix = game === "gs" ? "#" : "*";
    const gameName = game === "gs" ? $t("lib.ark-self-rank.text_d1597c51ed") : $t("lib.ark-self-rank.text_a2927891f0");
    if (!session || !Number.isSafeInteger(session.user) || session.user < 1) return $t("lib.ark-self-rank.text_344506218b");
    const { signal } = session;
    const active = () => !signal.aborted && session.isCurrent();
    if (!active()) return;
    if (!command.valid) return $t("lib.ark-self-rank.text_8f6c9f81aa", { "prefix": prefix, "MAX_PROFILE_ID": MAX_PROFILE_ID });
    if (!command.confirmed) {
      const selection = command.uid ? $t("lib.ark-self-rank.text_668af29d71", { "uid": command.uid, "profileId": profileId }) : ` ${profileId}`;
      const confirmation = $t("lib.ark-self-rank.text_25e20c199d", { "prefix": prefix, "selection": selection });
      return $t("lib.ark-self-rank.text_259a41251d", { "gameName": gameName, "confirmation": confirmation });
    }
    const qq = String(session.user);
    const key = `${qq}:${game}`;
    if (running.has(key)) return $t("lib.ark-self-rank.text_9f28f04e3d");
    running.add(key);
    try {
      const selected = await profiles.requestSelectedContext(qq, profileId, game);
      const account = previewRedeemIdentity(selected);
      const { uid, region, gameBiz } = selected.role;
      if (!active()) return;
      if (!account || !uidPattern.test(uid) || !region || !gameBiz) return $t("lib.ark-self-rank.text_5a10697d75", { "gameName": gameName });
      if (command.uid && command.uid !== uid) return $t("lib.ark-self-rank.text_56e00b1584", { "gameName": gameName });
      const avatars = await readCharacters(game, qq, uid);
      const verify = async () => {
        if (!active()) return false;
        const latest = await profiles.requestSelectedContext(qq, profileId, game).catch(() => undefined);
        return active() && latest?.revision === selected.revision && latest.role.uid === uid && latest.role.region === region &&
          latest.role.gameBiz === gameBiz && previewRedeemIdentity(latest) === account;
      };
      const changed = $t("lib.ark-self-rank.text_1f49cbffeb");
      if (!await verify()) return active() ? changed : undefined;
      if (!avatars?.length) return $t("lib.ark-self-rank.text_2a9757d6c3", { "gameName": gameName, "prefix": prefix });
      const characters = characterList(avatars);
      if (!characters.size || characters.size > maxCharacters) return $t("lib.ark-self-rank.text_76d0cf6302");
      const result = await postArkQuery("rank/self", { ids: [...characters.keys()], uid, type: game }, signal, transport);
      if (!await verify()) return active() ? changed : undefined;
      return "message" in result ? result.message : readRanking(result.payload, gameName, uid, characters);
    } catch (error) {
      if (!active()) return;
      if (error instanceof ProfileError) {
        if (error.code === "missing" || error.code === "login-required") return $t("lib.ark-self-rank.text_76720712c8", { "profileId": profileId });
        if (error.code === "role-missing" || error.code === "invalid") return $t("lib.ark-self-rank.text_e84d11746b", { "gameName": gameName });
        if (error.code === "changed") return $t("lib.ark-self-rank.text_1f49cbffeb");
      }
      return $t("lib.ark-self-rank.text_4d1e3bc26e");
    } finally {
      running.delete(key);
    }
  };
}
