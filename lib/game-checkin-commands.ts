import { setTimeout } from "node:timers/promises";
import { createProfileStore, MAX_PROFILE_ID, ProfileError, type Game, type ProfileAccountContext,
  type ProfileRequestContext } from "@lotus-yunzai/account";
import { createProfileHoyoClient, GameCheckinChallengeError, GameRecordRequestError, HoyoRequestError } from "@lotus-yunzai/hoyo-client";
import { renderCheckinReceiptCard, type CheckinReceiptCardModel } from "@lotus-yunzai/skia/checkin-receipt";
import type { CommandModule } from "./commands.ts";
import type { createManualCaptchaRelay } from "./captcha/manual-relay.ts";
import { runGameCheckinSequence, type GameCheckinResult } from "./game-checkin-sequence.ts";
import { segment } from "./messages.ts";

const manual = /^#(?:测试签到|开始签到|手动签到|补签)([1-9]\d{0,2})?$/u;
const targets = {
  genshin: "gs", honkai_sr: "sr", zzz: "zzz",
} as const satisfies Readonly<Record<string, Game>>;
const labels = [
  ["原神", "genshin", "2"], ["崩坏2", "honkai2", "3"], ["崩坏3", "honkai3rd", "1"],
  ["未定事件簿", "tears_of_themis", "4"], ["大别野", "", "5"], ["星铁", "honkai_sr", "6"],
  ["绝区零", "zzz", "8"], ["因缘精灵", "hna", "9"], ["星布谷地", "", "10"],
] as const;
const gameDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
const changed = "档案已变更，请重新发起签到。";
type Settings = Awaited<ReturnType<ReturnType<typeof createProfileStore>["checkinSettings"]>>;
type ManualRelay = Pick<ReturnType<typeof createManualCaptchaRelay>, "register" | "readResult">;

function rowsFor(settings: Settings) {
  return labels.map(([label, key, forum]) => ({
    label, key,
    game: key ? (settings.games[key]?.enabled ? "未执行" : "关闭") : "无",
    community: settings.communityForums.includes(forum) ? "未执行" : "关闭",
  }));
}

function outcome(rows: readonly GameCheckinResult[]) {
  const unconfirmed = rows.filter(row => row.status === "unconfirmed").length;
  const failed = rows.filter(row => row.status === "failed").length;
  const firstBind = rows.filter(row => row.status === "first-bind").length;
  const signed = rows.filter(row => row.status === "signed").length;
  const reasons = new Set<string>();
  for (const row of rows) {
    if (row.status !== "failed" || !(row.error instanceof GameRecordRequestError)) continue;
    reasons.add({ risk: "需要在米游社完成验证", expired: "Cookie 已过期", "rate-limited": "请求频繁" }[row.error.reason]);
  }
  const unsent = (firstBind ? ["首次绑定需在米游社签到"] : []).concat([...reasons]);
  if (unconfirmed) return { label: "未确认", reason: ["提交结果未确认，请在米游社核对", ...unsent].join("，") };
  if (failed || firstBind) return {
    label: failed ? "失败" : "首次绑定",
    reason: [...unsent, ...(signed ? [`${signed} 个角色已签到`] : [])].join("，") || "部分角色签到失败",
  };
  return { label: signed ? "成功" : "已完成" };
}

export function gameCheckinCommands(directory: string | undefined, signal: AbortSignal,
  makeClient = createProfileHoyoClient, renderReceipt = renderCheckinReceiptCard, manualRelay?: () => ManualRelay | undefined): CommandModule {
  const profiles = createProfileStore(directory);
  const client = makeClient(profiles);
  const active = new Set<string>();

  async function receipt(settings: Settings, profileId: number, rows: CheckinReceiptCardModel["rows"], notes: readonly string[]) {
    try {
      const detail = notes.length ? { title: "失败" as const, message: notes.join("\n").slice(0, 180) } : undefined;
      const { png } = await renderReceipt({ displayName: settings.displayName, profileId, rows, detail },
        { resourceDirectory: Bun.env.LOTUS_PASSPORT_QR_RESOURCES?.trim() || undefined });
      if (png.byteLength && png.byteLength <= 16 * 1024 * 1024) return segment.image(png);
    } catch {
      // The result is still available via the same rows if the old render resources are missing.
    }
    return [`档案 ${profileId} · 签到结果`, ...rows.map(({ label, game, community }) =>
      `${label} · 游戏 ${game} · 社区 ${community}`), ...notes].join("\n");
  }

  async function submit(source: ProfileRequestContext, verifyCurrent: () => Promise<void>,
    notify: ((message: string) => unknown) | undefined, label: string) {
    try {
      return await client.submitCnGameCheckin(source, { signal });
    } catch (error) {
      const relay = notify && error instanceof GameCheckinChallengeError ? manualRelay?.() : undefined;
      if (!relay || !notify || !(error instanceof GameCheckinChallengeError)) throw error;
      await verifyCurrent();
      const registration = await relay.register(error.challenge);
      if (!registration) throw error;
      await verifyCurrent();
      if (await notify(`请打开链接完成${label}签到的人工验证。链接只可使用一次。\n${registration.link}`) === false) throw error;
      while (Date.now() < registration.expiresAt) {
        await setTimeout(Math.min(1_500, Math.max(1, registration.expiresAt - Date.now())), undefined, { signal });
        await verifyCurrent();
        const read = await relay.readResult(registration.ticket);
        if (read.status === "pending") continue;
        if (read.status !== "complete" || !("validate" in read.result)) throw error;
        await verifyCurrent();
        const state = await client.fetchCnGameCheckinInfo(source, { signal, recoverCookie: false });
        await verifyCurrent();
        if (state.signed) return "already";
        if (state.firstBind) throw error;
        return client.submitCnGameCheckin(source, { signal, proof: read.result });
      }
      throw error;
    }
  }

  return {
    name: "@lotus-yunzai/checkin", commands: {},
    async fallback(_message, context) {
      const match = manual.exec(context.normalizedMessage);
      if (!match || signal.aborted) return;
      const profileId = Number(match[1] ?? 1);
      if (profileId > MAX_PROFILE_ID) return "档案编号须在 1 到 255 之间。";
      if (!context.user_id || !Number.isSafeInteger(context.user_id) || context.user_id < 1) return "请从 QQ 会话发送签到指令。";
      const qq = String(context.user_id);
      const startedDay = gameDay.format(Date.now());
      let account: ProfileAccountContext;
      let settings: Settings;
      try {
        settings = await profiles.checkinSettings(qq, profileId);
        account = await profiles.accountContext(qq, profileId);
        if (account.revision !== settings.revision) return changed;
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof ProfileError && (error.code === "missing" || error.code === "login-required")) {
          return `请先登录 profile ${profileId}。`;
        }
        return "无法读取签到档案。";
      }
      const key = account.account.ltuid || account.account.stuid || `${qq}/${profileId}`;
      if (active.has(key)) return "此账号的签到正在执行，请稍后。";
      active.add(key);
      try {
        let revision = account.revision;
        async function verifyCurrent() {
          signal.throwIfAborted();
          if (gameDay.format(Date.now()) !== startedDay) {
            throw new HoyoRequestError("profile-changed", "签到日期已切换，请重新签到。");
          }
          const current = await profiles.accountContext(qq, profileId).catch(() => undefined);
          if (current?.revision !== revision) throw new ProfileError("changed", changed);
        }
        const rows = rowsFor(settings);
        const notes: string[] = [];
        const gameRows = rows.filter(row => Object.hasOwn(targets, row.key) && settings.games[row.key]?.enabled);
        if (gameRows.length) {
          try {
            await verifyCurrent();
            account = await client.refreshCredentials(account);
            revision = account.revision;
            await verifyCurrent();
          } catch {
            await verifyCurrent();
            const reply = await receipt(settings, profileId, rows, ["签到前刷新登录失败，请重新扫码登录对应档案。"]);
            await verifyCurrent();
            return reply;
          }
          try {
            const roles = await client.fetchRoleCatalog(account, signal);
            await verifyCurrent();
            for (const row of gameRows) {
              const game = targets[row.key as keyof typeof targets];
              const blacklist = new Set(settings.games[row.key]?.blacklist);
              const eligible = roles[game].filter(role => !blacklist.has(role.uid));
              if (!eligible.length) {
                row.game = "跳过";
                continue;
              }
              const results: GameCheckinResult[] = [];
              for (const role of eligible) {
                const source = { ...account, game, role };
                results.push(await runGameCheckinSequence({
                  signal, verifyCurrent,
                  readInfo: () => client.fetchCnGameCheckinInfo(source, { signal, recoverCookie: false }),
                  submit: () => submit(source, verifyCurrent,
                    context.message_type === "private" ? message => context.reply(message) : undefined, row.label),
                }));
              }
              const finished = outcome(results);
              row.game = finished.label;
              if (finished.reason) notes.push(`${row.label}：${finished.reason}`);
            }
          } catch (error) {
            if (error instanceof ProfileError ||
              (error instanceof HoyoRequestError && error.code === "profile-changed")) throw error;
            await verifyCurrent();
            for (const row of gameRows.filter(row => row.game === "未执行")) row.game = "失败";
            notes.push("米游社角色查询未完成。");
          }
        }
        await verifyCurrent();
        const reply = await receipt(settings, profileId, rows, notes);
        await verifyCurrent();
        return reply;
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof ProfileError && error.code === "changed") return changed;
        if (error instanceof HoyoRequestError && error.code === "profile-changed") return error.message;
        return "签到未完成，请核对米游社状态。";
      } finally {
        active.delete(key);
      }
    },
  };
}
