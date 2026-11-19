import { createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { createProfileStore, MAX_PROFILE_ID, ProfileError, type ProfileAccountContext } from "@lotus-yunzai/account";
import { BbsCheckinRequestError, createProfileHoyoClient, GameCheckinChallengeError, GameRecordRequestError,
  HoyoRequestError, type BbsMissionState, type CnGameCheckinSource } from "@lotus-yunzai/hoyo-client";
import { renderCheckinReceiptCard, type CheckinReceiptCardModel } from "@lotus-yunzai/skia/checkin-receipt";
import type { CheckinAuditEntry, createCheckinAudit } from "./checkin-audit.ts";
import type { CommandModule } from "./commands.ts";
import type { createManualCaptchaRelay } from "./captcha/manual-relay.ts";
import { runGameCheckinSequence, type GameCheckinResult } from "./game-checkin-sequence.ts";
import { CheckinCommunityWriteError, type CheckinScheduledRunContext } from "./checkin-scheduler.ts";
import { segment, type MessageReply } from "./messages.ts";

const manual = /^#(?:测试签到|开始签到|手动签到|补签)([1-9]\d{0,2})?$/u;
const targets = {
  genshin: "gs", honkai_sr: "sr", zzz: "zzz", tears_of_themis: "nxx", honkai3rd: "bh3", honkai2: "bh2",
} as const satisfies Readonly<Record<string, CnGameCheckinSource["game"]>>;
const labels = [
  ["原神", "genshin", "2"], ["崩坏2", "honkai2", "3"], ["崩坏3", "honkai3rd", "1"],
  ["未定事件簿", "tears_of_themis", "4"], ["大别野", "", "5"], ["星铁", "honkai_sr", "6"],
  ["绝区零", "zzz", "8"], ["因缘精灵", "hna", "9"], ["星布谷地", "", "10"],
] as const;
const gameDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
const changed = "档案已变更，请重新发起签到。";
type Settings = Awaited<ReturnType<ReturnType<typeof createProfileStore>["checkinSettings"]>>;
type CheckinCount = keyof NonNullable<CheckinAuditEntry["counts"]>;
type ManualRelay = Pick<ReturnType<typeof createManualCaptchaRelay>, "register" | "readResult">;
type CheckinRun = { readonly status: "busy"; readonly reply?: MessageReply } |
  { readonly status: "complete"; readonly stage: CheckinAuditEntry["stage"]; readonly ok: boolean;
    readonly reply?: MessageReply; readonly revision?: string;
    readonly retryCommunity?: { readonly forums: readonly string[]; readonly otherFailure: boolean; readonly accountKey: string } };

function completedRun(stage: CheckinAuditEntry["stage"], ok: boolean, reply?: MessageReply, revision?: string,
  retryCommunity?: Extract<CheckinRun, { status: "complete" }>["retryCommunity"]): CheckinRun {
  return { status: "complete", stage, ok, reply, revision, retryCommunity };
}

function rowsFor(settings: Settings) {
  return labels.map(([label, key, forum]) => ({
    label, key, forum,
    game: key ? (settings.games[key]?.enabled ? "未执行" : "关闭") : "无",
    community: settings.communityForums.includes(forum) ? "未执行" : "关闭",
  }));
}

function bbsIssue(error: unknown) {
  if (error instanceof BbsCheckinRequestError) return error.message;
  if (error instanceof HoyoRequestError && error.code === "invalid-input") return error.message;
  return "米游社社区签到暂未完成，请在官方客户端核对。";
}

function bbsReadMayRetry(error: unknown) {
  if (error instanceof BbsCheckinRequestError) return error.reason === "rate-limited";
  return error instanceof HoyoRequestError && (error.code === "transport" ||
    (error.code === "http" && (error.status === 403 || (error.status !== undefined && error.status >= 500))));
}

function bbsPoints(state: BbsMissionState, receivedBefore?: number) {
  const lines: string[] = [];
  if (receivedBefore !== undefined && state.receivedPoints !== undefined && state.receivedPoints >= receivedBefore) {
    lines.push(`本轮期间新增：${state.receivedPoints - receivedBefore}`);
  }
  if (state.totalPoints !== undefined) lines.push(`当前余额：${state.totalPoints}`);
  if (state.receivedPoints !== undefined) {
    lines.push(`今日已领取：${state.receivedPoints}${state.todayTotalPoints === undefined ? "" : `/${state.todayTotalPoints}`}`);
  }
  return lines.join("\n");
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

export function gameCheckinCommands(directory: string | undefined, lifecycleSignal: AbortSignal,
  { makeClient = createProfileHoyoClient, renderReceipt = renderCheckinReceiptCard, manualRelay, audit }: {
    readonly makeClient?: typeof createProfileHoyoClient;
    readonly renderReceipt?: typeof renderCheckinReceiptCard;
    readonly manualRelay?: () => ManualRelay | undefined;
    readonly audit?: Pick<ReturnType<typeof createCheckinAudit>, "append">;
  } = {}) {
  const profiles = createProfileStore(directory);
  const client = makeClient(profiles);
  const active = new Set<string>();

  async function receipt(settings: Settings, profileId: number, rows: CheckinReceiptCardModel["rows"], notes: readonly string[], points?: string) {
    try {
      const detail = notes.length ? { title: "失败" as const, message: notes.join("\n").slice(0, 180) }
        : points ? { title: "米游币" as const, message: points } : undefined;
      const { png } = await renderReceipt({ displayName: settings.displayName, profileId, rows, detail },
        { resourceDirectory: Bun.env.LOTUS_PASSPORT_QR_RESOURCES?.trim() || undefined });
      if (png.byteLength && png.byteLength <= 16 * 1024 * 1024) return segment.image(png);
    } catch {
      // The result is still available via the same rows if the old render resources are missing.
    }
    return [`档案 ${profileId} · 签到结果`, ...rows.map(({ label, game, community }) =>
      `${label} · 游戏 ${game} · 社区 ${community}`), ...notes, ...(points ? [points] : [])].join("\n");
  }

  async function submit(source: CnGameCheckinSource, verifyCurrent: () => Promise<void>,
    notify: ((message: string) => unknown) | undefined, label: string, signal: AbortSignal) {
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
        if (state.firstBind || Date.now() >= registration.expiresAt) throw error;
        return client.submitCnGameCheckin(source, { signal, proof: read.result });
      }
      throw error;
    }
  }

  async function runProfile(qq: string, profileId: number, input: {
    readonly source: CheckinAuditEntry["source"];
    readonly signal: AbortSignal;
    readonly notify?: (message: string) => unknown;
    readonly verifyDay?: () => void;
    readonly communityWrites?: CheckinScheduledRunContext["communityWrites"];
    readonly communityRetryForums?: readonly string[];
    readonly communityAccountKey?: string;
  }): Promise<CheckinRun> {
    const { signal } = input;
    if (signal.aborted) return { status: "busy" };
    input.verifyDay?.();
    const counts: Partial<Record<CheckinCount, number>> = {};
    const auditResult = async (stage: CheckinAuditEntry["stage"], ok: boolean) => {
      if (signal.aborted) return;
      try {
        await audit?.append({ qq, profileId, stage, ok, source: input.source, counts });
      } catch {
        console.warn("[签到] 无法保存签到审计。");
      }
    };
    const count = (status: keyof typeof counts) => { counts[status] = (counts[status] ?? 0) + 1; };
    const startedDay = gameDay.format(Date.now());
    let account: ProfileAccountContext;
    let settings: Settings;
    let knownRevision: string | undefined;
    try {
      settings = await profiles.checkinSettings(qq, profileId);
      knownRevision = settings.revision;
      if (input.source !== "manual" && !settings.enabled) return { status: "busy" };
      account = await profiles.accountContext(qq, profileId);
      if (account.revision !== settings.revision) return { status: "busy", reply: changed };
    } catch (error) {
      if (signal.aborted) return { status: "busy" };
      await auditResult("precheck", false);
      if (error instanceof ProfileError && (error.code === "missing" || error.code === "login-required")) {
        return completedRun("precheck", false, `请先登录 profile ${profileId}。`, knownRevision);
      }
      return completedRun("precheck", false, "无法读取签到档案。", knownRevision);
    }
    const key = account.account.ltuid || account.account.stuid || `${qq}/${profileId}`;
    if (active.has(key)) return { status: "busy", reply: "此账号的签到正在执行，请稍后。" };
    active.add(key);
    try {
      let revision = account.revision;
      function verifyDay() {
        signal.throwIfAborted();
        input.verifyDay?.();
        if (gameDay.format(Date.now()) !== startedDay) {
          throw new HoyoRequestError("profile-changed", "签到日期已切换，请重新签到。");
        }
      }
      async function verifyCurrent() {
        verifyDay();
        const current = await profiles.accountContext(qq, profileId).catch(() => undefined);
        verifyDay();
        if (current?.revision !== revision) throw new ProfileError("changed", changed);
      }
      const rows = rowsFor(settings);
      const notes: string[] = [];
      const scoped = input.communityRetryForums;
      const communityAccountKey = createHash("sha256").update(JSON.stringify([
        qq, profileId, account.account.stuid || account.account.ltuid, account.account.mid,
      ])).digest("hex");
      if (input.communityAccountKey && input.communityAccountKey !== communityAccountKey) {
        await verifyCurrent();
        await auditResult("precheck", false);
        await verifyCurrent();
        return completedRun("precheck", false, "待恢复的签到对应原账号，当前档案已换绑。", revision);
      }
      const gameRows = scoped ? [] : rows.filter(row => Object.hasOwn(targets, row.key) && settings.games[row.key]?.enabled);
      const retryForums: string[] = [];
      const hna = rows.find(row => row.key === "hna");
      if (!scoped && hna?.game === "未执行") {
        hna.game = "跳过";
        count("skipped");
      }
      if (scoped) {
        for (const row of rows) {
          if (row.game === "未执行") row.game = "首轮已处理";
          if (!scoped.includes(row.forum) && row.community === "未执行") row.community = "不在本轮";
        }
      }
      async function runCommunity() {
        const selected = rows.filter(row => row.community === "未执行");
        if (scoped && selected.length !== scoped.length) {
          notes.push("当前档案已关闭部分或全部待补跑分区。");
          count("failed");
        }
        if (!selected.length) return;
        const journal = input.communityWrites;
        function deferRemaining() {
          for (const waiting of selected.filter(item => item.community === "未执行")) {
            waiting.community = "暂缓";
            retryForums.push(waiting.forum);
          }
        }
        let state: BbsMissionState | undefined;
        let accepted = false;
        for (const row of selected) {
          await verifyCurrent();
          const previous = journal?.previous[row.forum];
          if (previous === "already" || previous === "accepted") {
            row.community = previous === "already" ? "已签到" : "已受理";
            count(previous === "already" ? "community-already" : "community-accepted");
            continue;
          }
          if (previous === "retryable" && !scoped) {
            deferRemaining();
            notes.push("上次请求遇到限流，待社区补跑。");
            break;
          }
          if (previous && previous !== "retryable") {
            const rejected = previous === "rejected" || previous === "blocked";
            row.community = rejected ? "失败" : "未确认";
            count(rejected ? "failed" : "unconfirmed");
            notes.push(`${row.label}社区：${rejected ? "上次提交已失败。" : "上次提交结果未确认，请在官方客户端核对。"}`);
            if (previous !== "rejected") break;
            continue;
          }
          if (!state) {
            try {
              state = await client.fetchBbsMissionState(account, {
                signal, recoverCookie: gameRows.length === 0,
                onCredentialRefresh(current) {
                  account = current;
                  revision = current.revision;
                },
              });
              await verifyCurrent();
            } catch (error) {
              await verifyCurrent();
              if (journal && bbsReadMayRetry(error)) {
                deferRemaining();
              } else {
                for (const waiting of selected.filter(item => item.community === "未执行")) {
                  waiting.community = "失败";
                  count("failed");
                }
              }
              notes.push(bbsIssue(error));
              return;
            }
          }
          await journal?.start(row.forum, communityAccountKey);
          await verifyCurrent();
          let result: "accepted" | "already";
          try {
            result = await client.submitBbsCheckin(account, row.forum, { signal });
          } catch (error) {
            await verifyCurrent();
            if (journal && error instanceof BbsCheckinRequestError && error.status === 429 && error.reason === "rate-limited") {
              await journal.settle(row.forum, "retryable");
              deferRemaining();
              notes.push(`${row.label}社区：${bbsIssue(error)}`);
              break;
            }
            const explicit = error instanceof BbsCheckinRequestError ||
              (error instanceof HoyoRequestError && (error.code === "api" || error.code === "invalid-input"));
            const blocked = !(error instanceof HoyoRequestError) || error instanceof BbsCheckinRequestError || error.code !== "api";
            await journal?.settle(row.forum, explicit ? (blocked ? "blocked" : "rejected") : "unconfirmed");
            row.community = explicit ? "失败" : "未确认";
            count(explicit ? "failed" : "unconfirmed");
            notes.push(`${row.label}社区：${bbsIssue(error)}`);
            if (blocked) break;
            continue;
          }
          await verifyCurrent();
          await journal?.settle(row.forum, result);
          row.community = result === "accepted" ? "已受理" : "已签到";
          accepted ||= result === "accepted";
          count(result === "accepted" ? "community-accepted" : "community-already");
        }
        for (const row of selected) {
          if (row.community === "未执行") row.community = "跳过";
        }
        let receivedBefore: number | undefined;
        if (accepted && !notes.length) {
          try {
            receivedBefore = state?.receivedPoints;
            state = await client.fetchBbsMissionState(account, { signal, recoverCookie: false });
          } catch {
            await verifyCurrent();
            return;
          }
        }
        return state && !notes.length ? bbsPoints(state, receivedBefore) : undefined;
      }
      if (gameRows.length) {
        try {
          await verifyCurrent();
          account = await client.refreshCredentials(account);
          revision = account.revision;
          await verifyCurrent();
        } catch {
          await verifyCurrent();
          await auditResult("refresh", false);
          const reply = await receipt(settings, profileId, rows, ["签到前刷新登录失败，请重新扫码登录对应档案。"]);
          await verifyCurrent();
          return completedRun("refresh", false, reply, revision);
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
              count("skipped");
              continue;
            }
            const results: GameCheckinResult[] = [];
            for (const role of eligible) {
              const source = { ...account, game, role };
              const result = await runGameCheckinSequence({
                signal, verifyCurrent,
                readInfo: () => client.fetchCnGameCheckinInfo(source, { signal, recoverCookie: false }),
                submit: () => submit(source, verifyCurrent, input.notify, row.label, signal),
              });
              results.push(result);
              count(result.status);
            }
            const finished = outcome(results);
            row.game = finished.label;
            if (finished.reason) notes.push(`${row.label}：${finished.reason}`);
          }
        } catch (error) {
          if (error instanceof ProfileError ||
            (error instanceof HoyoRequestError && error.code === "profile-changed")) throw error;
          await verifyCurrent();
          for (const row of gameRows.filter(row => row.game === "未执行")) {
            row.game = "失败";
            count("failed");
          }
          notes.push("米游社角色查询未完成。");
        }
      }
      const points = await runCommunity();
      await verifyCurrent();
      const otherFailure = Boolean(counts.failed || counts["first-bind"] || counts.unconfirmed);
      const retry = retryForums.length ? { forums: retryForums, otherFailure, accountKey: communityAccountKey } : undefined;
      const ok = !otherFailure && !retry;
      await auditResult("checkin", ok);
      await verifyCurrent();
      const reply = await receipt(settings, profileId, rows, notes, points);
      await verifyCurrent();
      return completedRun("checkin", ok, reply, revision, retry);
    } catch (error) {
      if (signal.aborted) return { status: "busy" };
      if (error instanceof CheckinCommunityWriteError) throw error;
      if (error instanceof ProfileError && error.code === "changed") return { status: "busy", reply: changed };
      if (error instanceof HoyoRequestError && error.code === "profile-changed") return { status: "busy", reply: error.message };
      input.verifyDay?.();
      await auditResult("runner", false);
      return completedRun("runner", false, "签到未完成，请核对米游社状态。");
    } finally {
      active.delete(key);
    }
  }

  const commands: CommandModule = {
    name: "@lotus-yunzai/checkin", commands: {},
    async fallback(_message, context) {
      const match = manual.exec(context.normalizedMessage);
      if (!match || lifecycleSignal.aborted) return;
      const profileId = Number(match[1] ?? 1);
      if (profileId > MAX_PROFILE_ID) return "档案编号须在 1 到 255 之间。";
      if (!context.user_id || !Number.isSafeInteger(context.user_id) || context.user_id < 1) return "请从 QQ 会话发送签到指令。";
      const result = await runProfile(String(context.user_id), profileId, {
        source: "manual", signal: lifecycleSignal,
        notify: context.message_type === "private" ? message => context.reply(message) : undefined,
      });
      return result.reply;
    },
  };

  return {
    ...commands,
    async runScheduled(qq: string, profileId: number, context: CheckinScheduledRunContext): Promise<CheckinRun> {
      const signal = AbortSignal.any([lifecycleSignal, context.signal]);
      return runProfile(qq, profileId, {
        signal, verifyDay: context.verifyDay,
        source: context.communityRetryForums ? "scheduled_community_retry" : "scheduled",
        communityWrites: context.communityWrites, communityRetryForums: context.communityRetryForums,
        communityAccountKey: context.communityAccountKey,
      });
    },
  };
}
