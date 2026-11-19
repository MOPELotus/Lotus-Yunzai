import { ProfileError, profileGames, type Game } from "@lotus-yunzai/account";
import { HoyoRequestError, ZzzManualGachaLinkRequired, ZzzTuningRateLimitError } from "@lotus-yunzai/hoyo-client";
import type { MessageFallback } from "./commands.ts";
import { segment } from "./messages.ts";

export type GachaGame = Game;
export type GachaUpdater = (qq: string, profileId: number) => Promise<{ readonly uid: string } | undefined>;

type Render = (title: string, lead: string, rows: readonly string[], at: Date) => Promise<{ readonly png: Uint8Array }>;
type Entry = { readonly updater: GachaUpdater };
type Outcome = { readonly status: "done" | "skipped" | "failed"; readonly text: string };

const batchCommand = /^#更新(?:全部|所有)抽卡记录$/u;
const title = "全部抽卡记录";
const maxCardRows = 18;
const names = { gs: "原神", sr: "星铁", zzz: "绝区零" } as const satisfies Record<GachaGame, string>;
const expiredCodes = new Set([-101, -100, 10001, 10101, 10102, 10103]);

function skipped(text: string): Outcome {
  return { status: "skipped", text };
}

function failed(message: string): Outcome {
  return { status: "failed", text: `失败：${message}` };
}

function rejected(error: unknown, profileId: number): Outcome {
  if (error instanceof ZzzManualGachaLinkRequired) {
    const command = `%抽卡链接${profileId === 1 ? "" : profileId}`;
    return skipped(`国际服请私聊发送 ${command}，跳过`);
  }
  if (error instanceof ProfileError) {
    if (error.code === "role-missing") return skipped("未绑定 UID，跳过");
    if (error.code === "missing" || error.code === "login-required") return failed("请先登录该档案");
    if (error.code === "changed") return failed("档案已变更，请重新发起");
  }
  if (error instanceof HoyoRequestError) {
    if (error.code === "profile-changed") return failed("档案已变更，请重新发起");
    if (error instanceof ZzzTuningRateLimitError || error.status === 429) return failed("访问过于频繁，请稍后再试");
    if (error.code === "refresh" || error.status === 401 ||
        (error.code === "api" && error.retcode !== undefined && expiredCodes.has(error.retcode))) {
      return failed("登录凭据已失效，请刷新登录或重新扫码");
    }
  }
  return failed("更新未完成，请稍后再试");
}

async function update(entry: Entry | undefined, qq: string, profileId: number): Promise<Outcome> {
  if (!entry) return skipped("游戏插件未加载，跳过");
  try {
    const result = await entry.updater(qq, profileId);
    if (!result) return skipped("已在更新，跳过");
    if (!/^[1-9]\d*$/u.test(result.uid)) return failed("更新结果缺少有效 UID");
    return { status: "done", text: `UID ${result.uid} · 完成` };
  } catch (error) {
    return rejected(error, profileId);
  }
}

const renderBatch: Render = async (title, lead, rows, at) => {
  const { renderStatusCard } = await import("@lotus-yunzai/skia/status-card");
  return renderStatusCard(title, lead, rows, at);
};

export function createGachaBatch({ listIds, signal, render = renderBatch }: {
  readonly listIds: (qq: string) => Promise<readonly number[]>;
  readonly signal: AbortSignal;
  readonly render?: Render;
}) {
  const providers = new Map<GachaGame, Entry>();
  const active = new Set<string>();

  function register(game: GachaGame, updater: GachaUpdater): () => void {
    const entry = { updater };
    providers.set(game, entry);
    return () => {
      if (providers.get(game) === entry) providers.delete(game);
    };
  }

  const fallback: MessageFallback = async (_message, context) => {
    if (signal.aborted || !batchCommand.test(context.normalizedMessage)) return;
    const { user_id } = context;
    if (typeof user_id !== "number" || !Number.isSafeInteger(user_id) || user_id < 1) {
      return "请从登录档案对应的 QQ 会话更新全部抽卡记录。";
    }
    const qq = String(user_id);
    if (active.has(qq)) return "[gacha] 正在批量更新你的抽卡记录，请稍后再试。";
    active.add(qq);
    try {
      const ids = await listIds(qq).catch(() => undefined);
      if (signal.aborted) return;
      if (!ids) return "[gacha] 读取档案列表失败，请稍后再试。";
      if (!ids.length) return "[gacha] 没有找到你的 profile。";

      await context.reply("[gacha] 开始批量更新所有 profile 的原神/星铁/绝区零抽卡记录。");
      const counts = { done: 0, skipped: 0, failed: 0 };
      const rows: string[] = [];
      for (const profileId of ids) {
        for (const game of profileGames) {
          if (signal.aborted) return;
          const result = await update(providers.get(game), qq, profileId);
          counts[result.status]++;
          rows.push(`P${profileId} ${names[game]}：${result.text}`);
        }
      }
      if (signal.aborted) return;
      const badge = counts.failed ? "部分失败" : "完成";
      const lead = `QQ ${qq}\n${badge} · 完成 ${counts.done} 项，跳过 ${counts.skipped} 项，失败 ${counts.failed} 项。`;
      if (rows.length > maxCardRows) {
        const nodes = [`${title}\n${lead}`];
        for (let start = 0; start < rows.length; start += maxCardRows) {
          nodes.push(rows.slice(start, start + maxCardRows).join("\n"));
        }
        return { type: "forward", nodes };
      }

      try {
        const { png } = await render(title, lead, rows, new Date());
        if (!signal.aborted) return segment.image(png);
      } catch {
        if (!signal.aborted) return [title, lead, ...rows].join("\n");
      }
    } finally {
      active.delete(qq);
    }
  };

  return { register, fallback };
}
