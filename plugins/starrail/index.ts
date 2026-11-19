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
import { buildStarRailGachaVersion, type StarRailGachaVersionOptions } from "./gacha-version.ts";
import { renderStarRailGachaVersion } from "./gacha-version-card.ts";

const updateCommand = /^#星铁更新抽卡记录([1-9]\d{0,2})?$/u;
const poolCommand = /^#星铁(?:喵喵)?(全部)?(抽卡|抽奖|角色|光锥|武器|常驻|up)池?(全部)?(记录|祈愿|分析|统计)([1-9]\d{0,2})?$/u;
const versionCommand = /^#星铁(?:喵喵)?(版本|全部)(全部)?统计([1-9]\d{0,2})?$/u;
const detailPools = new Map<string, StarRailGachaDetailPool>([
  ["光锥", "GachaType_EquipmentUp"], ["武器", "GachaType_EquipmentUp"], ["常驻", "GachaType_Standard"],
]);
type VersionPool = NonNullable<StarRailGachaVersionOptions["type"]>;
const versionPools = new Map<string, VersionPool>([
  ["角色", "char"], ["光锥", "weapon"], ["武器", "weapon"], ["常驻", "normal"], ["全部", "all"],
]);
const historyRoot = fileURLToPath(new URL("../../data/starRailGachaJson/", import.meta.url));

type GachaView = { readonly detail: StarRailGachaDetailPool } | { readonly version: VersionPool };

function matchGachaQuery(message: string): { profileId: number; view: GachaView; all: boolean } | undefined {
  const version = versionCommand.exec(message);
  if (version && !(version[1] === "全部" && version[2])) {
    return { profileId: Number(version[3] ?? 1), view: { version: versionPools.get(version[1]!) ?? "up" }, all: !!version[2] };
  }
  const pool = poolCommand.exec(message);
  if (!pool) return;
  const name = pool[2]!;
  const view = pool[4] === "统计" ? { version: versionPools.get(name) ?? "up" }
    : { detail: detailPools.get(name) ?? "GachaType_AvatarUp" };
  return { profileId: Number(pool[5] ?? 1), view, all: !!(pool[1] || pool[3]) };
}

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

  async function query(qq: string, { profileId, view, all }: NonNullable<ReturnType<typeof matchGachaQuery>>) {
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
        uid, history: snapshot, face: { name: nickname || "旅行者" }, now: new Date(), resolveItem,
      };
      const resolvePool = resolveStarRailDetailPool(schedule);
      function buildPage(page?: number) {
        if ("detail" in view) {
          const model = buildStarRailGachaDetail({ ...options, pool: view.detail, resolvePool, page });
          return model && { kind: "detail" as const, model };
        }
        const model = buildStarRailGachaVersion({ ...options, type: view.version, schedule, page });
        return model && { kind: "version" as const, model };
      }
      const first = buildPage(all ? 1 : undefined);
      if (!first) return `UID:${uid} 本地暂无该卡池抽卡记录。`;
      try {
        const pages = [];
        const total = first.model.pageInfo?.total ?? 1;
        for (let page = 1; page <= total; page++) {
          if (signal.aborted) return;
          const result = page === 1 ? first : buildPage(page);
          if (!result) throw new Error("星铁抽卡记录缺少分页。");
          const { png } = result.kind === "detail" ? await renderStarRailGachaDetail(result.model, { themeDirectory })
            : await renderStarRailGachaVersion(result.model, { themeDirectory });
          pages.push({ type: "image" as const, file: png });
        }
        if (signal.aborted) return;
        const role = await profiles.savedRole(qq, profileId, "sr").catch(() => undefined);
        if (role?.uid !== uid) return "星铁档案角色已变化，请重新查询。";
        if (pages.length === 1) return pages[0];
        const title = first.kind === "detail"
          ? `${first.model.poolName}池抽卡记录，共${first.model.gacha.stat.fiveNum}条五星`
          : `${first.model.poolName}统计，共${first.model.pageInfo!.count}期卡池`;
        return { type: "forward" as const, nodes: [`UID:${uid} ${title}，分${pages.length}张图`, ...pages] };
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
      const view = matched ? undefined : matchGachaQuery(context.normalizedMessage);
      if (!matched && !view) return;
      const profileId = view?.profileId ?? Number(matched?.[1] ?? 1);
      if (profileId > MAX_PROFILE_ID) return;
      const { user_id } = context;
      if (typeof user_id !== "number" || !Number.isSafeInteger(user_id) || user_id < 1) {
        return "请从登录档案对应的 QQ 会话使用星铁抽卡记录。";
      }
      const qq = String(user_id);
      if (view) return query(qq, view);
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
