import { fileURLToPath } from "node:url";
import { createProfileStore, MAX_PROFILE_ID, ProfileError } from "@lotus-yunzai/account";
import { createProfileHoyoClient, HoyoRequestError } from "@lotus-yunzai/hoyo-client";
import { buildStarRailGachaDetail, type StarRailGachaDetailPool } from "./gacha-detail.ts";
import { renderStarRailGachaDetail } from "./gacha-detail-card.ts";
import { readStarRailGachaItems, starRailGachaThemeDirectory } from "./gacha-detail-source.ts";
import { renderStarRailGachaFailure, renderStarRailGachaResult } from "./gacha-result-card.ts";
import { readStarRailGachaSchedule, resolveStarRailDetailPool } from "./gacha-schedule.ts";
import { createStarRailGachaHistoryStore } from "./gacha-store.ts";
import { createStarRailGachaSync } from "./gacha-sync.ts";

const updateCommand = /^#星铁更新抽卡记录([1-9]\d{0,2})?$/u;
const detailCommand = /^#星铁(?:喵喵)?(全部)?(抽卡|抽奖|角色|光锥|武器|常驻|up)池?(全部)?(?:记录|祈愿|分析)([1-9]\d{0,2})?$/u;
const detailPools = new Map<string, StarRailGachaDetailPool>([
  ["光锥", "GachaType_EquipmentUp"], ["武器", "GachaType_EquipmentUp"], ["常驻", "GachaType_Standard"],
]);
const historyRoot = fileURLToPath(new URL("../../data/starRailGachaJson/", import.meta.url));

interface GachaContext {
  readonly normalizedMessage: string;
  readonly user_id?: number;
  reply(message: string): unknown;
}

export function createModule({ signal, lockFile }: {
  signal: AbortSignal;
  lockFile: Parameters<typeof createStarRailGachaHistoryStore>[1];
}) {
  const profiles = createProfileStore(Bun.env.LOTUS_PROFILE_DIR || undefined);
  const client = createProfileHoyoClient(profiles);
  const history = createStarRailGachaHistoryStore(historyRoot, lockFile);
  const service = createStarRailGachaSync(profiles, client, history);
  const active = new Set<string>();

  async function query(qq: string, profileId: number, pool: StarRailGachaDetailPool, all: boolean) {
    try {
      const { uid, nickname } = await profiles.savedRole(qq, profileId, "sr");
      const snapshot = await history.read(qq, uid);
      if (snapshot === null) {
        return `[荷花插件]profile ${profileId} 暂无星铁抽卡记录，请先使用 *更新抽卡记录${profileId === 1 ? "" : profileId}。`;
      }
      const themeDirectory = starRailGachaThemeDirectory();
      const [resolveItem, schedule] = await Promise.all([
        readStarRailGachaItems(themeDirectory), readStarRailGachaSchedule(themeDirectory),
      ]);
      const options = {
        uid, history: snapshot, pool, face: { name: nickname || "旅行者" }, now: new Date(),
        resolveItem, resolvePool: resolveStarRailDetailPool(schedule),
      };
      const first = buildStarRailGachaDetail({ ...options, page: all ? 1 : undefined });
      if (!first) return `UID:${uid} 本地暂无该卡池抽卡记录。`;
      try {
        const pages = [];
        const total = first.pageInfo?.total ?? 1;
        for (let page = 1; page <= total; page++) {
          if (signal.aborted) return;
          const model = page === 1 ? first : buildStarRailGachaDetail({ ...options, page })!;
          const { png } = await renderStarRailGachaDetail(model, { themeDirectory });
          pages.push({ type: "image" as const, file: png });
        }
        if (signal.aborted) return;
        const role = await profiles.savedRole(qq, profileId, "sr").catch(() => undefined);
        if (role?.uid !== uid) return "星铁档案角色已变化，请重新查询。";
        if (pages.length === 1) return pages[0];
        return { type: "forward" as const, nodes: [
          `UID:${uid} ${first.poolName}池抽卡记录，共${first.gacha.stat.fiveNum}条五星，分${pages.length}张图`,
          ...pages,
        ] };
      } catch {
        if (!signal.aborted) return "星铁抽卡记录已读取，原版详情图暂时无法生成。";
      }
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof ProfileError) {
        if (error.code === "missing") return `[荷花插件]请先登录 profile ${profileId}。`;
        if (error.code === "role-missing") return `[荷花插件]profile ${profileId} 没有同步星铁 UID。`;
      }
      return "星铁抽卡记录读取失败，请检查本地历史文件。";
    }
  }

  return {
    commands: {},
    async fallback(_message: string, context: GachaContext) {
      const matched = updateCommand.exec(context.normalizedMessage);
      const detail = matched ? null : detailCommand.exec(context.normalizedMessage);
      if (!matched && !detail) return;
      const profileId = Number(matched?.[1] ?? detail?.[4] ?? 1);
      if (profileId > MAX_PROFILE_ID) return;
      const { user_id } = context;
      if (typeof user_id !== "number" || !Number.isSafeInteger(user_id) || user_id < 1) {
        return "请从登录档案对应的 QQ 会话使用星铁抽卡记录。";
      }
      const qq = String(user_id);
      if (detail) return query(qq, profileId, detailPools.get(detail[2]!) ?? "GachaType_AvatarUp", !!(detail[1] || detail[3]));
      const key = `${qq}/${profileId}`;
      if (active.has(key)) return "该档案的星铁抽卡记录正在更新，请稍后再试。";
      active.add(key);
      try {
        await context.reply(`[荷花插件]正在为 profile ${profileId} 补齐官方范围内的星铁五星与垫抽记录。`);
        const result = await service.sync(qq, profileId, { signal });
        try {
          const { png } = await renderStarRailGachaResult(result);
          return { type: "image" as const, file: png };
        } catch {
          return `[荷花插件]星铁抽卡记录更新完成，新增 ${result.added} 条五星记录。`;
        }
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof ProfileError) {
          if (error.code === "missing" || error.code === "login-required") {
            return `[荷花插件]请先登录 profile ${profileId}。`;
          }
          if (error.code === "role-missing") return `[荷花插件]profile ${profileId} 没有同步星铁 UID。`;
        }
        const reason = error instanceof HoyoRequestError && error.status === 429 ? "rate-limited"
          : (error instanceof ProfileError && error.code === "changed") ||
            (error instanceof HoyoRequestError && error.code === "profile-changed") ? "profile-changed" : "request-failed";
        try {
          const { png } = await renderStarRailGachaFailure({ qq, profileId, reason });
          return { type: "image" as const, file: png };
        } catch {
          return "[荷花插件]星铁抽卡记录更新失败，请检查档案登录状态与星铁 UID。";
        }
      } finally {
        active.delete(key);
      }
    },
  };
}
