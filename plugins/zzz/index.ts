import { fileURLToPath } from "node:url";
import { createProfileStore, MAX_PROFILE_ID, ProfileError } from "@lotus-yunzai/account";
import { createGachaUpdater } from "@lotus-yunzai/gacha/update";
import { createProfileHoyoClient, HoyoRequestError, resolveZzzTuningRegion, ZzzTuningRateLimitError } from "@lotus-yunzai/hoyo-client";
import { createZzzTuningArtwork } from "./tuning-artwork.ts";
import { buildZzzTuningDetail, buildZzzTuningInventoryReply } from "./tuning-detail.ts";
import { renderZzzTuningDetail } from "./tuning-detail-card.ts";
import { renderZzzTuningFailure, renderZzzTuningResult } from "./tuning-result-card.ts";
import { createZzzTuningSync, ZzzTuningHistoryChangedError } from "./tuning-sync.ts";

const updateCommand = /^#绝区零(?:更新|刷新)抽卡(?:记录|链接)?([1-9]\d{0,2})?$/u;
const viewCommand = /^#绝区零抽卡(?:记录|分析|统计)([1-9]\d{0,2})?$/u;
const helpCommand = /^#绝区零抽卡帮助$/u;
const legacyPrefix = /^(?:[#/](?:zzz|绝区零)(?:zzz|绝区零)?|[%％](?:zzz|绝区零)?|zzz|绝区零)(?=(?:更新|刷新)?抽卡)/iu;
const help = [
  "绝区零抽卡记录",
  "%更新抽卡记录 同步国服米游社的六个频段。",
  "%抽卡记录 查看调频记录，当前登录可用时另发实时库存。",
  "命令末尾可加档案编号，例如 %抽卡记录2。",
].join("\n");
const historyDirectory = fileURLToPath(new URL("../../data/zzzTuningStats/", import.meta.url));

interface GachaContext {
  readonly normalizedMessage: string;
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

  async function view(qq: string, profileId: number, context: GachaContext) {
    try {
      const role = await profiles.savedRole(qq, profileId, "zzz");
      const { uid } = role;
      const region = resolveZzzTuningRegion({ game: "zzz", role });
      const cached = await sync.read(qq, { uid, region });
      const stats = cached ?? await client.fetchZzzTuning(await profiles.requestContext(qq, profileId, "zzz", uid), { signal });

      async function roleMatches() {
        try {
          const current = await profiles.savedRole(qq, profileId, "zzz");
          return current.uid === uid && resolveZzzTuningRegion({ game: "zzz", role: current }) === region;
        } catch {
          return false;
        }
      }

      const { avatar, resolveIcon, loadArtwork } = createZzzTuningArtwork(stats, qq, signal);
      const model = buildZzzTuningDetail({ stats, player: { nickname: role.nickname || "绳匠", avatar }, resolveIcon });
      const level = role.level === undefined ? undefined : Number(role.level);
      const { png } = await renderZzzTuningDetail(model, {
        loadArtwork, level: Number.isFinite(level) ? level : undefined, regionName: role.regionName || region,
      });
      if (signal.aborted) return [];
      if (!await roleMatches()) return "绝区零档案角色已变化，请重新查询。";
      if (await context.reply({ type: "image", file: png }) === false) return [];

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
      return "绝区零抽卡记录暂时无法查看。";
    }
  }

  return {
    commands: {},
    gachaUpdate,
    async fallback(_message: string, context: GachaContext) {
      const command = context.normalizedMessage.replace(legacyPrefix, "#绝区零");
      if (helpCommand.test(command)) return help;
      const update = updateCommand.exec(command);
      const matched = update ?? viewCommand.exec(command);
      if (!matched) return;
      const profileId = Number(matched[1] ?? 1);
      if (profileId > MAX_PROFILE_ID) return;
      const { user_id } = context;
      if (typeof user_id !== "number" || !Number.isSafeInteger(user_id) || user_id < 1) {
        return "请从登录档案对应的 QQ 会话使用绝区零抽卡记录。";
      }
      const qq = String(user_id);
      if (!update) return view(qq, profileId, context);
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
