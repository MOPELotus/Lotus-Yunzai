import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { ProfileError, profileGames, type Game } from "@lotus-yunzai/account";
import { GameRecordRequestError, HoyoRequestError, ZzzManualGachaLinkRequired, ZzzTuningRateLimitError } from "@lotus-yunzai/hoyo-client";
import { nativeImageRasterScale } from "@lotus-yunzai/skia";
import type { MessageFallback } from "./commands.ts";
import { segment } from "./messages.ts";

export type GachaGame = Game;
export type GachaUpdater = (qq: string, profileId: number, notify?: () => unknown,
  isDelegated?: boolean, signal?: AbortSignal) => Promise<{ readonly uid: string } | undefined>;

type Render = (title: string, lead: string, rows: readonly string[], at: Date,
  scale: 1 | 2 | 4) => Promise<{ readonly png: Uint8Array }>;
type Entry = { readonly updater: GachaUpdater };
type Outcome = { readonly status: "done" | "skipped" | "failed"; readonly text: string };

const batchCommand = /^#更新(?:全部|所有)抽卡记录$/u;
const title = $t("lib.gacha-batch.text_fb904077ad");
const maxCardRows = 18;
const names = { gs: $t("lib.gacha-batch.text_d1597c51ed"), sr: $t("lib.gacha-batch.text_a2927891f0"), zzz: $t("lib.gacha-batch.text_b1110352c9") } as const satisfies Record<GachaGame, string>;
const expiredCodes = new Set([-101, -100, 10001, 10101, 10102, 10103]);

function skipped(text: string): Outcome {
  return { status: "skipped", text };
}

function failed(message: string): Outcome {
  return { status: "failed", text: $t("lib.gacha-batch.text_e09c1fe6be", { "message": message }) };
}

function rejected(error: unknown, profileId: number): Outcome {
  if (error instanceof ZzzManualGachaLinkRequired) {
    const command = $t("lib.gacha-batch.text_c4df79e596", { "value1": profileId === 1 ? "" : profileId });
    return skipped($t("lib.gacha-batch.text_e0128939ff", { "command": command }));
  }
  if (error instanceof ProfileError) {
    if (error.code === "role-missing") return skipped($t("lib.gacha-batch.text_b6a71bbb4b"));
    if (error.code === "missing" || error.code === "login-required") return failed($t("lib.gacha-batch.text_8038b6c6d7"));
    if (error.code === "changed") return failed($t("lib.gacha-batch.text_34e60e4dc4"));
  }
  if (error instanceof HoyoRequestError) {
    if (error.code === "profile-changed") return failed($t("lib.gacha-batch.text_34e60e4dc4"));
    if (error instanceof ZzzTuningRateLimitError || error.status === 429 ||
        (error instanceof GameRecordRequestError && error.reason === "rate-limited")) {
      return failed($t("lib.gacha-batch.text_405232f2e3"));
    }
    if (error.code === "refresh" || error.status === 401 ||
        (error.code === "api" && error.retcode !== undefined && expiredCodes.has(error.retcode))) {
      return failed($t("lib.gacha-batch.text_f5b53eb755"));
    }
  }
  return failed($t("lib.gacha-batch.text_341e9224f3"));
}

async function update(entry: Entry | undefined, qq: string, profileId: number, signal: AbortSignal, isDelegated?: boolean): Promise<Outcome> {
  if (!entry) return skipped($t("lib.gacha-batch.text_fe3234d18f"));
  try {
    const result = await entry.updater(qq, profileId, undefined, isDelegated, signal);
    if (!result) return skipped($t("lib.gacha-batch.text_d08d7a49d5"));
    if (!/^[1-9]\d*$/u.test(result.uid)) return failed($t("lib.gacha-batch.text_d2b15f882b"));
    return { status: "done", text: $t("lib.gacha-batch.text_e8807a6a3a", { "uid": result.uid }) };
  } catch (error) {
    return rejected(error, profileId);
  }
}

const renderBatch: Render = async (title, lead, rows, at, scale) => {
  const { renderStatusCard } = await import("@lotus-yunzai/skia/status-card");
  return renderStatusCard(title, lead, rows, at, { scale });
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
    if (!batchCommand.test(context.normalizedMessage)) return;
    const session = context.isDelegated ? context.delegationSignal : context.message_type === "group"
      ? context.groupActivitySignal : context.privateCredentialSignal;
    const workflow = session ? AbortSignal.any([signal, session]) : signal;
    if (workflow.aborted) return;
    const { user_id } = context;
    if (typeof user_id !== "number" || !Number.isSafeInteger(user_id) || user_id < 1) {
      return $t("lib.gacha-batch.text_fd2f252757");
    }
    const qq = String(user_id);
    if (active.has(qq)) return $t("lib.gacha-batch.text_a71c3148a4");
    active.add(qq);
    try {
      const ids = await listIds(qq).catch(() => undefined);
      if (workflow.aborted) return;
      if (!ids) return $t("lib.gacha-batch.text_3ff63772e5");
      if (!ids.length) return $t("lib.gacha-batch.text_d5318776ab");

      await context.reply($t("lib.gacha-batch.text_7f85d8b951"));
      const counts = { done: 0, skipped: 0, failed: 0 };
      const rows: string[] = [];
      for (const profileId of ids) {
        for (const game of profileGames) {
          if (workflow.aborted) return;
          const result = await update(providers.get(game), qq, profileId, workflow, game === "gs" ? context.isDelegated : undefined);
          counts[result.status]++;
          rows.push(`P${profileId} ${names[game]}：${result.text}`);
        }
      }
      if (workflow.aborted) return;
      const badge = counts.failed ? $t("lib.gacha-batch.text_7e214ed64a") : $t("lib.gacha-batch.text_c0b3fbff51");
      const lead = $t("lib.gacha-batch.text_69e7c0fb1d", { "qq": qq, "badge": badge, "done": counts.done, "skipped": counts.skipped, "failed": counts.failed });
      if (rows.length > maxCardRows) {
        const nodes = [`${title}\n${lead}`];
        for (let start = 0; start < rows.length; start += maxCardRows) {
          nodes.push(rows.slice(start, start + maxCardRows).join("\n"));
        }
        return { type: "forward", nodes };
      }

      const scale = nativeImageRasterScale();
      const limit = context.inlineImageByteLimit ?? Infinity;
      const now = new Date();
      try {
        let { png } = await render(title, lead, rows, now, scale);
        if (workflow.aborted) return;
        if (png.byteLength > limit && scale === 4) ({ png } = await render(title, lead, rows, now, 2));
        if (workflow.aborted) return;
        if (png.byteLength <= limit) return segment.image(png);
      } catch {
        // The complete result remains available in text if image rendering fails.
      }
      if (!workflow.aborted) return [title, lead, ...rows].join("\n");
    } finally {
      active.delete(qq);
    }
  };

  return { register, fallback };
}
