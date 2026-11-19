import { fileURLToPath } from "node:url";
import { createProfileStore, MAX_PROFILE_ID, ProfileError, type GameRole } from "@lotus-yunzai/account";
import { createGachaUpdater } from "@lotus-yunzai/gacha/update";
import {
  createProfileHoyoClient, HoyoRequestError, readZzzGachaLink, resolveZzzGachaLinkRole, resolveZzzTuningRegion,
  ZzzTuningRateLimitError,
} from "@lotus-yunzai/hoyo-client";
import { readZzzLegacyGacha, ZzzLegacyGachaError } from "./gacha-legacy.ts";
import { buildZzzLegacyDetail } from "./gacha-legacy-detail.ts";
import { createZzzLinkHistory, mergeZzzLegacyWithLinked } from "./gacha-link-history.ts";
import { createZzzGachaLinkSession } from "./gacha-link-session.ts";
import { createZzzLegacyGachaArtwork, createZzzTuningArtwork } from "./tuning-artwork.ts";
import { buildZzzTuningDetail, buildZzzTuningInventoryReply } from "./tuning-detail.ts";
import { renderZzzTuningDetail } from "./tuning-detail-card.ts";
import { renderZzzTuningFailure, renderZzzTuningResult } from "./tuning-result-card.ts";
import { createZzzTuningSync, ZzzTuningHistoryChangedError } from "./tuning-sync.ts";

const updateCommand = /^#绝区零(?:更新|刷新)抽卡(?:记录|链接)?([1-9]\d{0,2})?$/u;
const viewCommand = /^#绝区零抽卡(?:记录|分析|统计)([1-9]\d{0,2})?$/u;
const linkedViewCommand = /^#绝区零逐抽记录([1-9]\d{0,2})?$/u;
const linkCommand = /^#绝区零抽卡链接([1-9]\d{0,2})?$/u;
const helpCommand = /^#绝区零抽卡帮助$/u;
const legacyPrefix = /^(?:[#/](?:zzz|绝区零)(?:zzz|绝区零)?|[%％](?:zzz|绝区零)?|zzz|绝区零)(?=(?:更新|刷新)?抽卡|逐抽记录)/iu;
const help = [
  "绝区零抽卡记录",
  "%更新抽卡记录 同步国服米游社的六个频段。",
  "%抽卡记录 查看调频记录，当前登录可用时另发实时库存。",
  "%抽卡链接 私聊录入有效的绝区零官方抽卡链接。",
  "%逐抽记录 查看录入的记录和已有旧档案。",
  "国际服绑定档案可查看已有的旧调频记录。",
  "命令末尾可加档案编号，例如 %抽卡记录2。",
].join("\n");
const historyDirectory = fileURLToPath(new URL("../../data/zzzTuningStats/", import.meta.url));
const legacyHistoryDirectory = fileURLToPath(new URL("../../data/zzzGachaJson/", import.meta.url));
const linkHistoryDirectory = fileURLToPath(new URL("../../data/zzzGachaRows/", import.meta.url));

function overseasRegion({ uid, region, gameBiz }: GameRole) {
  if (!/^\d{10}$/u.test(uid)) return;
  try {
    return resolveZzzGachaLinkRole({ uid, region, gameBiz }).region;
  } catch {
    return;
  }
}

interface GachaContext {
  readonly adapter?: string;
  readonly normalizedMessage: string;
  readonly self_id?: number;
  readonly user_id?: number;
  readonly message_type?: string;
  reply(message: string | { readonly type: "image"; readonly file: Uint8Array }): unknown;
}

export function createModule({ signal, lockFile }: {
  signal: AbortSignal;
  lockFile: Parameters<typeof createZzzTuningSync>[3];
}) {
  const profiles = createProfileStore(Bun.env.LOTUS_PROFILE_DIR || undefined);
  const client = createProfileHoyoClient(profiles);
  const sync = createZzzTuningSync(profiles, client, historyDirectory, lockFile);
  const gachaUpdate = createGachaUpdater((qq, profileId) => sync.sync(qq, profileId, { signal }));
  const legacyHistory = Bun.env.LOTUS_ZZZ_LEGACY_HISTORY_DIR || legacyHistoryDirectory;
  const linkHistory = createZzzLinkHistory(linkHistoryDirectory, lockFile);
  const linkSession = createZzzGachaLinkSession({
    signal,
    savedRole: (qq, profileId) => profiles.savedRole(qq, profileId, "zzz"),
    async importLink(qq, profileId, link, verifyProfile) {
      const snapshot = await readZzzGachaLink(link, fetch, { signal }, verifyProfile);
      const identity = { qq, uid: snapshot.uid, region: snapshot.region };
      const legacy = await readZzzLegacyGacha(legacyHistory, qq, identity.uid);
      mergeZzzLegacyWithLinked(legacy, snapshot);
      const { stats, added } = await linkHistory.merge(identity, snapshot, verifyProfile);
      const records = mergeZzzLegacyWithLinked(legacy, stats)!.pools;
      const lines = stats.pools.map(({ name, type }) =>
        `${name} · 本次录入 ${added[type]} 条，合并旧档共 ${records.find((pool) => pool.type === type)?.records.length ?? 0} 条`);
      const command = `%逐抽记录${profileId === 1 ? "" : profileId}`;
      return { type: "forward", nodes: ["绝区零抽卡链接录入完成。", ...lines, `发送 ${command} 查看。`] };
    },
  });

  async function view(qq: string, profileId: number, context: GachaContext, linkedOnly: boolean) {
    try {
      const role = await profiles.savedRole(qq, profileId, "zzz");
      const { uid } = role;
      const regionOf = (current: GameRole) => linkedOnly ? resolveZzzGachaLinkRole(current).region
        : overseasRegion(current) ?? resolveZzzTuningRegion({ game: "zzz", role: current });
      const region = regionOf(role);
      const useOfficial = !linkedOnly && (region === "prod_gf_cn" || region === "prod_qd_cn");

      async function roleMatches() {
        try {
          const current = await profiles.savedRole(qq, profileId, "zzz");
          return current.uid === uid && regionOf(current) === region;
        } catch {
          return false;
        }
      }

      const nickname = role.nickname || "绳匠";
      const level = role.level === undefined ? undefined : Number(role.level);
      const display = { level: Number.isFinite(level) ? level : undefined, regionName: role.regionName || region };
      let png: Uint8Array;
      if (useOfficial) {
        const cached = await sync.read(qq, { uid, region });
        const stats = cached ?? await client.fetchZzzTuning(await profiles.requestContext(qq, profileId, "zzz", uid), { signal });
        const { avatar, resolveIcon, loadArtwork } = createZzzTuningArtwork(stats, qq, signal);
        const model = buildZzzTuningDetail({ stats, player: { nickname, avatar }, resolveIcon });
        ({ png } = await renderZzzTuningDetail(model, { ...display, loadArtwork }));
      } else {
        const [legacy, linked] = await Promise.all([
          readZzzLegacyGacha(legacyHistory, qq, uid), linkHistory.read(qq, { uid, region }),
        ]);
        const stats = mergeZzzLegacyWithLinked(legacy, linked);
        if (!stats) return linkedOnly ? "该角色还没有绝区零逐抽记录。" : "该角色还没有绝区零旧调频记录。";
        const { avatar, resolveIcon, loadArtwork } = createZzzLegacyGachaArtwork(qq, signal);
        const model = buildZzzLegacyDetail({ stats, player: { nickname, avatar }, resolveIcon });
        ({ png } = await renderZzzTuningDetail(model, { ...display, loadArtwork }));
      }
      if (signal.aborted) return [];
      if (!await roleMatches()) return "绝区零档案角色已变化，请重新查询。";
      if (await context.reply({ type: "image", file: png }) === false) return [];
      if (!useOfficial) return [];

      const live = await profiles.requestContext(qq, profileId, "zzz", uid)
        .then((current) => client.fetchZzzTuningInventory(current, { signal })).catch(() => undefined);
      const inventory = buildZzzTuningInventoryReply({ uid, profileId, live });
      if (signal.aborted || !inventory || !await roleMatches()) return [];
      return context.message_type === "group" ? [{ type: "at" as const, qq }, inventory] : inventory;
    } catch (error) {
      if (signal.aborted) return [];
      if (error instanceof ProfileError) {
        if (error.code === "missing" || error.code === "login-required") return `[荷花插件]请先登录 profile ${profileId}。`;
        if (error.code === "role-missing") return `[荷花插件]profile ${profileId} 没有同步绝区零 UID。`;
      }
      if (error instanceof HoyoRequestError && error.code === "invalid-input") return error.message;
      if (error instanceof HoyoRequestError && error.code === "profile-changed") return "绝区零档案角色已变化，请重新查询。";
      if (error instanceof ZzzTuningRateLimitError) return "访问过于频繁，请稍后再试。";
      if (error instanceof ZzzLegacyGachaError) return error.message;
      return "绝区零抽卡记录暂时无法查看。";
    }
  }

  return {
    commands: {},
    gachaUpdate,
    async fallback(_message: string, context: GachaContext) {
      const command = context.normalizedMessage.replace(legacyPrefix, "#绝区零");
      if (helpCommand.test(command)) return help;
      const link = linkCommand.exec(command);
      if (link) {
        const profileId = Number(link[1] ?? 1);
        if (profileId <= MAX_PROFILE_ID) return linkSession(context, profileId);
        return;
      }
      const continuation = await linkSession(context);
      if (continuation !== undefined) return continuation;
      const update = updateCommand.exec(command);
      const linkedOnly = linkedViewCommand.exec(command);
      const matched = update ?? linkedOnly ?? viewCommand.exec(command);
      if (!matched) return;
      const profileId = Number(matched[1] ?? 1);
      if (profileId > MAX_PROFILE_ID) return;
      const { user_id } = context;
      if (typeof user_id !== "number" || !Number.isSafeInteger(user_id) || user_id < 1) {
        return "请从登录档案对应的 QQ 会话使用绝区零抽卡记录。";
      }
      const qq = String(user_id);
      if (!update) return view(qq, profileId, context, linkedOnly !== null);
      try {
        const result = await gachaUpdate(qq, profileId, () =>
          context.reply(`[荷花插件]正在为 profile ${profileId} 更新绝区零抽卡记录。`));
        if (!result) return "该档案的绝区零抽卡记录正在更新，请稍后再试。";
        try {
          const { png } = await renderZzzTuningResult(qq, result);
          return { type: "image" as const, file: png };
        } catch {
          return "[荷花插件]绝区零抽卡记录更新完成。";
        }
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof ZzzTuningHistoryChangedError) return "该角色的绝区零抽卡记录已由另一条请求更新。";
        if (error instanceof ProfileError) {
          if (error.code === "missing" || error.code === "login-required") return `[荷花插件]请先登录 profile ${profileId}。`;
          if (error.code === "role-missing") return `[荷花插件]profile ${profileId} 没有同步绝区零 UID。`;
        }
        const reason = error instanceof ZzzTuningRateLimitError ? "rate-limited"
          : (error instanceof ProfileError && error.code === "changed") ||
            (error instanceof HoyoRequestError && error.code === "profile-changed") ? "profile-changed" : "request-failed";
        try {
          const { png } = await renderZzzTuningFailure({ qq, profileId, reason });
          return { type: "image" as const, file: png };
        } catch {
          return "[荷花插件]绝区零抽卡记录更新失败，请检查档案登录状态与绝区零 UID。";
        }
      }
    },
  };
}
