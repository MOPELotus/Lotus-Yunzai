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
  gs: ["原神全服总排名", "genshin", "@lotus-yunzai/genshin"],
  sr: ["星铁全服总排名", "starrail", "@lotus-yunzai/starrail"],
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
    case -1: return "全服排名服务要求更新客户端版本。";
    case 104:
    case 201: return "全服排名查询过于频繁，请稍后重试。";
    case 101:
    case 102:
    case 202: return "全服排名服务暂无该档案的排名数据。";
    case 103:
    case 301: return "全服排名服务拒绝了本次查询。";
    default: return "全服排名服务暂时无法返回结果。";
  }
}

function characterList(avatars: readonly SavedCharacter[]) {
  const ids = new Map<string, string>();
  for (const { id, name } of avatars) {
    const key = String(id);
    if (!/^[1-9]\d{0,11}$/u.test(key) || ids.has(key)) continue;
    const label = typeof name === "string" ? name.toWellFormed().replace(/[\p{Cc}\p{Cf}]/gu, " ").trim().slice(0, 40) : "";
    ids.set(key, label || `角色 ${key}`);
  }
  return ids;
}

function readRanking(payload: unknown, gameName: string, uid: string, characters: ReadonlyMap<string, string>) {
  const response = record(payload);
  if (response?.retcode !== 100) return businessError(response?.retcode);
  if (!Array.isArray(response.rank) || response.rank.length !== characters.size) return "全服排名服务返回的角色条数与档案不符。";
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
    result.push(`${name}全服伤害排名为 ${rank}，伤害评分 ${score.toFixed(2)}`);
  }
  if (!result.length) {
    if (limited) return businessError(104);
    return unknown ? "全服排名服务未能确认本次查询的排名结果。" : "当前档案的角色暂无全服伤害排名。";
  }
  const heading = `UID ${uid} 的${gameName}全服排名`;
  if (missing) result.push(`${missing} 个角色暂无排名。`);
  if (unknown) result.push(`${unknown} 个角色查询未确认${limited ? "，部分请求受速率限制" : ""}。`);
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
    const gameName = game === "gs" ? "原神" : "星铁";
    if (!session?.privateFriend) return "请在当前机器人的好友私聊查询本人全服排名。";
    const { signal } = session;
    const active = () => !signal.aborted && session.isCurrent();
    if (!active()) return;
    if (!command.valid) return `用法 ${prefix}总排名 [档案编号]，档案编号须为 1–${MAX_PROFILE_ID}。`;
    if (!command.confirmed) {
      const selection = command.uid ? ` ${command.uid} 档案${profileId}` : ` ${profileId}`;
      const confirmation = `${prefix}总排名${selection} 确认`;
      return `这项查询会向 Ark 排名服务（ark.ivny.cn）发送所选${gameName}档案的 UID、游戏类型和本地已保存的角色编号。确认查询请发送 ${confirmation}。`;
    }
    const qq = String(session.user);
    const key = `${qq}:${game}`;
    if (running.has(key)) return "该游戏的全服排名正在查询，请稍后再试。";
    running.add(key);
    try {
      const selected = await profiles.requestSelectedContext(qq, profileId, game);
      const account = previewRedeemIdentity(selected);
      const { uid, region, gameBiz } = selected.role;
      if (!active()) return;
      if (!account || !uidPattern.test(uid) || !region || !gameBiz) return `请先登录并同步所选档案的本人${gameName}角色。`;
      if (command.uid && command.uid !== uid) return `输入的 UID 与所选档案的本人${gameName}角色不一致。`;
      const avatars = await readCharacters(game, qq, uid);
      const verify = async () => {
        if (!active()) return false;
        const latest = await profiles.requestSelectedContext(qq, profileId, game).catch(() => undefined);
        return active() && latest?.revision === selected.revision && latest.role.uid === uid && latest.role.region === region &&
          latest.role.gameBiz === gameBiz && previewRedeemIdentity(latest) === account;
      };
      const changed = "查询期间档案已变更，请重新发送查询指令。";
      if (!await verify()) return active() ? changed : undefined;
      if (!avatars?.length) return `暂无本人${gameName}角色面板，请先发送 ${prefix}更新面板。`;
      const characters = characterList(avatars);
      if (!characters.size || characters.size > maxCharacters) return "本地档案没有可查询的角色编号。";
      const result = await postArkQuery("rank/self", { ids: [...characters.keys()], uid, type: game }, signal, transport);
      if (!await verify()) return active() ? changed : undefined;
      return "message" in result ? result.message : readRanking(result.payload, gameName, uid, characters);
    } catch (error) {
      if (!active()) return;
      if (error instanceof ProfileError) {
        if (error.code === "missing" || error.code === "login-required") return `请先登录档案 ${profileId}。`;
        if (error.code === "role-missing" || error.code === "invalid") return `请先同步并选择所选档案的本人${gameName}角色。`;
        if (error.code === "changed") return "查询期间档案已变更，请重新发送查询指令。";
      }
      return "本人角色面板暂时无法读取。";
    } finally {
      running.delete(key);
    }
  };
}
