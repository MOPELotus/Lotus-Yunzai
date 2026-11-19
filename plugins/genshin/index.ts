import { fileURLToPath } from "node:url";
import { createProfileStore, MAX_PROFILE_ID, ProfileError } from "@lotus-yunzai/account";
import { createProfileHoyoClient, HoyoRequestError, type GenshinGachaPool } from "@lotus-yunzai/hoyo-client";
import { buildGenshinGachaDetail } from "./gacha-detail.ts";
import { renderGenshinGachaDetail } from "./gacha-detail-card.ts";
import { genshinGachaThemeDirectory, readGenshinGachaSources } from "./gacha-detail-source.ts";
import { renderGenshinGachaFailure, renderGenshinGachaResult } from "./gacha-result-card.ts";
import { createGenshinGachaHistoryStore } from "./gacha-store.ts";
import { createGenshinGachaSync } from "./gacha-sync.ts";
import { buildGenshinGachaVersion, type GenshinGachaVersionOptions } from "./gacha-version.ts";
import { renderGenshinGachaVersion } from "./gacha-version-card.ts";

const updateCommand = /^#(?:原神)?更新抽卡记录([1-9]\d{0,2})?$/u;
const poolCommand = /^#(?:原神)?(?:喵喵)?(全部)?(抽卡|抽奖|角色|武器|常驻|集录|up)池?(全部)?(记录|祈愿|分析|统计)([1-9]\d{0,2})?$/u;
const versionCommand = /^#(?:原神)?(?:喵喵)?(版本(?:全部)?|全部)统计([1-9]\d{0,2})?$/u;
const helpCommand = /^#(?:原神)?(?:抽卡|记录)帮助$/u;
const detailPools = new Map<string, GenshinGachaPool>([["武器", 302], ["常驻", 200], ["集录", 500]]);
type VersionPool = NonNullable<GenshinGachaVersionOptions["type"]>;
const versionPools = new Map<string, VersionPool>([["角色", "char"], ["武器", "weapon"], ["常驻", "normal"], ["集录", "mix"]]);
type GachaView = { readonly detail: GenshinGachaPool } | { readonly version: VersionPool };
const historyDirectory = fileURLToPath(new URL("../../data/gachaJson/", import.meta.url));
const help = [
  "原神抽卡记录",
  "#登录列表 可查看档案，#同步角色 可同步原神角色。",
  "#更新抽卡记录 可补齐官方可查询范围内的记录。",
  "#抽卡记录、#武器记录、#常驻记录、#集录记录 可查看对应卡池。",
  "#版本统计 按期次查看角色和武器池，#全部统计 查看各池汇总。",
  "末尾加档案编号可选档案。单池可加「全部」查看各页，如 #角色全部记录2。",
].join("\n");

function matchGachaQuery(message: string): { profileId: number; view: GachaView; all: boolean } | undefined {
  const version = versionCommand.exec(message);
  if (version) {
    return {
      profileId: Number(version[2] ?? 1),
      view: { version: version[1] === "全部" ? "all" : "up" },
      all: version[1] === "版本全部",
    };
  }
  const pool = poolCommand.exec(message);
  if (!pool) return;
  const name = pool[2]!;
  const view = pool[4] === "统计" ? { version: versionPools.get(name) ?? "up" }
    : { detail: detailPools.get(name) ?? 301 };
  return { profileId: Number(pool[5] ?? 1), view, all: !!(pool[1] || pool[3]) };
}

interface GachaContext {
  readonly normalizedMessage: string;
  readonly user_id?: number;
  reply(message: string): unknown;
}

export function createModule({ signal, lockFile }: {
  signal: AbortSignal;
  lockFile: Parameters<typeof createGenshinGachaHistoryStore>[1];
}) {
  const profiles = createProfileStore(Bun.env.LOTUS_PROFILE_DIR || undefined);
  const history = createGenshinGachaHistoryStore(historyDirectory, lockFile);
  const sync = createGenshinGachaSync(profiles, createProfileHoyoClient(profiles), history);
  const updating = new Set<string>();

  async function view(qq: string, profileId: number, selection: GachaView, all: boolean) {
    try {
      const { uid, nickname } = await profiles.savedRole(qq, profileId, "gs");
      const records = await history.read(qq, uid);
      const themeDirectory = genshinGachaThemeDirectory();
      const face = {
        name: nickname || "旅行者", face: "/meta-gs/character/芙宁娜/imgs/face-q.webp",
        banner: "/meta-gs/character/芙宁娜/imgs/banner.webp",
      };
      const options = { uid, records, face, now: new Date(), ...await readGenshinGachaSources(themeDirectory, records) };
      function buildPage(page?: number) {
        if ("detail" in selection) {
          const model = buildGenshinGachaDetail({ ...options, pool: selection.detail, page });
          return model && { kind: "detail" as const, model };
        }
        const model = buildGenshinGachaVersion({ ...options, type: selection.version, page });
        return model && { kind: "version" as const, model };
      }
      const first = buildPage(all ? 1 : undefined);
      if (!first) return `UID:${uid} 本地暂无该卡池抽卡记录，请先使用 #更新抽卡记录${profileId === 1 ? "" : profileId}。`;
      try {
        const pages = [];
        const total = first.model.pageInfo?.total ?? 1;
        for (let page = 1; page <= total; page++) {
          if (signal.aborted) return;
          const result = page === 1 ? first : buildPage(page);
          if (!result) throw new Error("原神抽卡记录缺少分页。");
          const { png } = await (result.kind === "detail" ? renderGenshinGachaDetail(result.model, { themeDirectory })
            : renderGenshinGachaVersion(result.model, { themeDirectory }));
          pages.push({ type: "image" as const, file: png });
        }
        if (signal.aborted) return;
        const current = await profiles.savedRole(qq, profileId, "gs").catch(() => undefined);
        if (current?.uid !== uid) return "原神档案角色已变化，请重新查询。";
        if (pages.length === 1) return pages[0];
        const title = first.kind === "version" ? `${first.model.poolName}统计，共${first.model.pageInfo!.count}期卡池`
          : `${first.model.poolName}池抽卡记录，共${first.model.gacha.stat.fiveNum}条五星`;
        return { type: "forward" as const, nodes: [`UID:${uid} ${title}，分${pages.length}张图`, ...pages] };
      } catch {
        if (!signal.aborted) return "原神抽卡记录已读取，原版详情图暂时无法生成。";
      }
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof ProfileError) {
        if (error.code === "missing") return `[荷花插件]请先登录 profile ${profileId}。`;
        if (error.code === "role-missing") return `[荷花插件]profile ${profileId} 没有同步原神 UID。`;
      }
      return "原神抽卡记录读取失败，请检查本地历史文件。";
    }
  }

  return {
    commands: {},
    async fallback(_message: string, context: GachaContext) {
      if (helpCommand.test(context.normalizedMessage)) return help;
      const matched = updateCommand.exec(context.normalizedMessage);
      const query = matched ? undefined : matchGachaQuery(context.normalizedMessage);
      if (!matched && !query) return;
      const profileId = query?.profileId ?? Number(matched?.[1] ?? 1);
      if (profileId > MAX_PROFILE_ID) return;
      const { user_id } = context;
      if (typeof user_id !== "number" || !Number.isSafeInteger(user_id) || user_id < 1) {
        return "请从登录档案对应的 QQ 会话使用原神抽卡记录。";
      }
      const qq = String(user_id);
      if (query) return view(qq, profileId, query.view, query.all);
      const key = `${qq}/${profileId}`;
      if (updating.has(key)) return "该档案的原神抽卡记录正在更新，请稍后再试。";
      updating.add(key);
      try {
        await context.reply(`[荷花插件]正在更新 Profile ${profileId} 的抽卡记录，会补齐官方范围内的缺档。`);
        const result = await sync.sync(qq, profileId, { signal });
        try {
          const { png } = await renderGenshinGachaResult(qq, result);
          return { type: "image" as const, file: png };
        } catch {
          return "[荷花插件]抽卡记录更新完成。";
        }
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof ProfileError) {
          if (error.code === "missing" || error.code === "login-required") return `[荷花插件]请先登录 profile ${profileId}。`;
          if (error.code === "role-missing") return `[荷花插件]profile ${profileId} 没有同步原神 UID。`;
        }
        const reason = error instanceof HoyoRequestError && error.status === 429 ? "rate-limited"
          : (error instanceof ProfileError && error.code === "changed") ||
            (error instanceof HoyoRequestError && error.code === "profile-changed") ? "profile-changed" : "request-failed";
        try {
          const { png } = await renderGenshinGachaFailure({ qq, profileId, reason });
          return { type: "image" as const, file: png };
        } catch {
          return "[荷花插件]抽卡记录更新失败，请检查档案登录状态与原神 UID。";
        }
      } finally {
        updating.delete(key);
      }
    },
  };
}
