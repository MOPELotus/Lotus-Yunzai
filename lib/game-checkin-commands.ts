import { createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { createProfileStore, MAX_PROFILE_ID, ProfileError, profileCookieAccountId, type ProfileAccountContext } from "@lotus-yunzai/account";
import { BbsCheckinRequestError, CloudGenshinWalletError, CloudZzzWalletError, createProfileHoyoClient, GameCheckinChallengeError, GameRecordRequestError,
  HoyoRequestError, type BbsCheckinForum, type BbsMissionState, type CnGameCheckinSource } from "@lotus-yunzai/hoyo-client";
import { renderCheckinReceiptCard, type CheckinReceiptCardModel } from "@lotus-yunzai/skia/checkin-receipt";
import type { CheckinAuditEntry, createCheckinAudit } from "./checkin-audit.ts";
import type { CommandModule } from "./commands.ts";
import type { createManualCaptchaRelay } from "./captcha/manual-relay.ts";
import { runGameCheckinSequence, type CheckinSequence, type GameCheckinResult } from "./game-checkin-sequence.ts";
import { legacyGameWriteKey, type CheckinScheduleGame } from "./checkin-schedule-plan.ts";
import type { createCheckinScheduleStore } from "./checkin-schedule-store.ts";
import { CheckinScheduleWriteError, withManualCheckinJournals, type CheckinRetryTargets, type CheckinScheduledRunContext } from "./checkin-scheduler.ts";
import { segment, type MessageReply } from "./messages.ts";

const manual = /^#(?:测试签到|开始签到|手动签到|补签)([1-9]\d{0,2})?$/u;
const namedManual = /^#*(米游社|mys|社区)?([^#\s]+)签到([1-9]\d{0,2})?$/u;
const namedGames = new Map<string, CheckinScheduleGame>([
  ["原神", "genshin"],
  ["星铁", "honkai_sr"], ["穹轨", "honkai_sr"], ["崩坏星穹铁道", "honkai_sr"], ["sr", "honkai_sr"],
  ["绝区零", "zzz"], ["zzz", "zzz"],
  ["崩三", "honkai3rd"], ["崩坏3", "honkai3rd"], ["崩崩崩", "honkai3rd"], ["bh3", "honkai3rd"],
  ["崩二", "honkai2"], ["崩坏2", "honkai2"], ["崩崩", "honkai2"], ["bh2", "honkai2"],
  ["未定", "tears_of_themis"], ["未定事件簿", "tears_of_themis"], ["事件簿", "tears_of_themis"],
]);
const namedForums = new Map<string, BbsCheckinForum>([
  ["崩坏3", "1"], ["原神", "2"], ["崩坏2", "3"], ["未定事件簿", "4"], ["大别野", "5"], ["崩坏星穹铁道", "6"], ["绝区零", "8"],
]);
type ManualTarget = { readonly kind: "game"; readonly game: CheckinScheduleGame } |
  { readonly kind: "community"; readonly forum: BbsCheckinForum };

export function namedCheckinCommand(message: string): { readonly profileId: number; readonly target: ManualTarget } | undefined {
  const named = namedManual.exec(message);
  if (!named) return;
  const [, community, name, profile] = named;
  const profileId = Number(profile ?? 1);
  if (community) {
    const forum = namedForums.get(name!);
    if (forum) return { profileId, target: { kind: "community", forum } };
  } else {
    const game = namedGames.get(name!);
    if (game) return { profileId, target: { kind: "game", game } };
  }
}

const targets = {
  genshin: "gs", honkai_sr: "sr", zzz: "zzz", tears_of_themis: "nxx", honkai3rd: "bh3", honkai2: "bh2",
} as const satisfies Readonly<Record<CheckinScheduleGame, CnGameCheckinSource["game"]>>;
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
    readonly retryCommunity?: CheckinRetryTargets & { readonly otherFailure: boolean; readonly accountKey: string } };

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

function checkinRoleReadMayRetry(error: unknown): error is HoyoRequestError {
  return error instanceof HoyoRequestError && (error.code === "transport" || (error.code === "http" &&
    (error.status === 410 || error.status === 429 || error.status === 403 || (error.status !== undefined && error.status >= 500))));
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

function outcome(rows: readonly GameCheckinResult[], officialClient = "米游社") {
  const unconfirmed = rows.filter(row => row.status === "unconfirmed").length;
  const failed = rows.filter(row => row.status === "failed").length;
  const firstBind = rows.filter(row => row.status === "first-bind").length;
  const signed = rows.filter(row => row.status === "signed").length;
  const reasons = new Set<string>();
  for (const row of rows) {
    if (row.status !== "failed" || !(row.error instanceof GameRecordRequestError)) continue;
    reasons.add({ risk: `需要在${officialClient}完成验证`, expired: "Cookie 已过期", "rate-limited": "请求频繁" }[row.error.reason]);
  }
  const unsent = (firstBind ? [`首次绑定需在${officialClient}签到`] : []).concat([...reasons]);
  if (unconfirmed) return { label: "未确认", reason: [`提交结果未确认，请在${officialClient}核对`, ...unsent].join("，") };
  if (failed || firstBind) return {
    label: failed ? "失败" : "首次绑定",
    reason: [...unsent, ...(signed ? [`${signed} 个角色已签到`] : [])].join("，") || "部分角色签到失败",
  };
  return { label: signed ? "成功" : "已完成" };
}

export function gameCheckinCommands(directory: string | undefined, lifecycleSignal: AbortSignal,
  { makeClient = createProfileHoyoClient, transport, renderReceipt = renderCheckinReceiptCard, manualRelay, audit, scheduleStore,
    waitForReadRetry = (milliseconds, signal) => setTimeout(milliseconds, undefined, { signal }) }: {
    readonly makeClient?: typeof createProfileHoyoClient;
    readonly transport?: Parameters<typeof createProfileHoyoClient>[1];
    readonly renderReceipt?: typeof renderCheckinReceiptCard;
    readonly manualRelay?: () => ManualRelay | undefined;
    readonly audit?: Pick<ReturnType<typeof createCheckinAudit>, "append">;
    readonly scheduleStore?: ReturnType<typeof createCheckinScheduleStore>;
    readonly waitForReadRetry?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  } = {}) {
  const profiles = createProfileStore(directory);
  const client = makeClient(profiles, transport);
  const active = new Set<string>();
  const activeOverseas = new Set<string>();
  const overseasDeviceId = crypto.randomUUID();
  const cloudDeviceId = crypto.randomUUID();

  async function retryRead<Value>(read: () => Promise<Value>, signal: AbortSignal, mayRetry: (error: unknown) => boolean) {
    const delays = [5_000, 15_000];
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      try {
        return await read();
      } catch (error) {
        const delay = delays[attempt];
        if (delay === undefined || !mayRetry(error) || (error instanceof HoyoRequestError && error.status === 429)) throw error;
        await waitForReadRetry(delay, signal);
      }
    }
  }

  async function receipt(settings: Settings, profileId: number, rows: CheckinReceiptCardModel["rows"],
    notes: readonly string[], { points, cloud, textOnly }: { readonly points?: string; readonly cloud?: string;
      readonly textOnly?: boolean } = {}) {
    const extras = [points, cloud].filter(Boolean).join("\n");
    const text = () => [`档案 ${profileId} · 签到结果`, ...rows.map(({ label, game, community }) =>
      `${label} · 游戏 ${game} · 社区 ${community}`), ...notes, ...(extras ? [extras] : [])].join("\n");
    if (textOnly) return text();
    try {
      const detail: CheckinReceiptCardModel["detail"] = notes.length
        ? { title: "失败", message: [notes.join("\n").slice(0, 180), cloud].filter(Boolean).join("\n") }
        : extras ? { title: points ? "米游币" : cloud?.includes("云绝区零") ? "云游戏" : "云原神", message: extras } : undefined;
      const { png } = await renderReceipt({ displayName: settings.displayName, profileId, rows, detail },
        { resourceDirectory: Bun.env.LOTUS_PASSPORT_QR_RESOURCES?.trim() || undefined });
      if (png.byteLength && png.byteLength <= 16 * 1024 * 1024) return segment.image(png);
    } catch {
      // The result is still available via the same rows if the old render resources are missing.
    }
    return text();
  }

  async function submit(source: CnGameCheckinSource, verifyCurrent: () => Promise<void>,
    notify: ((message: string) => unknown) | undefined, label: string, signal: AbortSignal) {
    try {
      return await client.submitCnGameCheckin(source, { signal });
    } catch (error) {
      const relay = notify && error instanceof GameCheckinChallengeError ? manualRelay?.() : undefined;
      if (!relay || !notify || !(error instanceof GameCheckinChallengeError)) throw error;
      await verifyCurrent();
      const registration = await relay.register(error.challenge, signal);
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
    readonly announceStart?: () => unknown;
    readonly notify?: (message: string) => unknown;
    readonly verifySession?: () => Promise<void>;
    readonly textOnly?: boolean;
    readonly verifyDay?: () => void;
    readonly communityWrites?: CheckinScheduledRunContext["communityWrites"];
    readonly gameWrites?: CheckinScheduledRunContext["gameWrites"];
    readonly communityRetryForums?: readonly string[];
    readonly gameRetryKeys?: readonly CheckinScheduleGame[];
    readonly communityAccountKey?: string;
    readonly manualTarget?: ManualTarget;
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
      await input.verifySession?.();
      signal.throwIfAborted();
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
    let revision = account.revision;
    try {
      function verifyDay() {
        signal.throwIfAborted();
        input.verifyDay?.();
        if (gameDay.format(Date.now()) !== startedDay) {
          throw new HoyoRequestError("profile-changed", "签到日期已切换，请重新签到。");
        }
      }
      async function verifyCurrent() {
        verifyDay();
        await input.verifySession?.();
        const current = await profiles.accountContext(qq, profileId).catch(() => undefined);
        verifyDay();
        if (current?.revision !== revision) throw new ProfileError("changed", changed);
      }
      const { manualTarget } = input;
      let rows = rowsFor(settings);
      const notes: string[] = [];
      if (manualTarget?.kind === "game") {
        rows = rows.filter(row => row.key === manualTarget.game);
        for (const row of rows) row.community = "不在本轮";
        if (!settings.games[manualTarget.game]?.enabled) {
          notes.push("此档案未开启所选国服游戏签到。");
          count("failed");
        }
      } else if (manualTarget?.kind === "community") {
        rows = rows.filter(row => row.forum === manualTarget.forum);
        for (const row of rows) row.game = "不在本轮";
        if (!settings.communityForums.includes(manualTarget.forum)) {
          notes.push("此档案未开启所选社区分区签到。");
          count("failed");
        }
      }
      const scoped = input.communityRetryForums;
      const gameScope = input.gameRetryKeys;
      const retrying = scoped !== undefined || gameScope !== undefined;
      const shortReadRetry = input.source === "scheduled" || !!gameScope?.length || manualTarget?.kind === "game";
      const includeAllServices = !manualTarget && !retrying;
      // A refreshed device or login ticket does not change the account that owns the retry.
      // Keep accepting the original MID-based key for an existing community write journal.
      const accountIdentity = [qq, profileId, account.account.stuid || account.account.ltuid] as const;
      const legacyAccountKey = createHash("sha256").update(JSON.stringify([...accountIdentity, account.account.mid])).digest("hex");
      const accountKey = accountIdentity[2] ? createHash("sha256").update(JSON.stringify(accountIdentity)).digest("hex") : legacyAccountKey;
      if (manualTarget?.kind !== "game" && input.communityAccountKey &&
          input.communityAccountKey !== accountKey && input.communityAccountKey !== legacyAccountKey) {
        await verifyCurrent();
        await auditResult("precheck", false);
        await verifyCurrent();
        return completedRun("precheck", false, "待恢复的签到对应原账号，当前档案已换绑。", revision);
      }
      const communityAccountKey = input.communityAccountKey ?? accountKey;
      const gameJournal = manualTarget?.kind === "community" ? undefined : input.gameWrites;
      const digest = (fields: readonly unknown[]) => createHash("sha256").update(JSON.stringify(fields)).digest("hex");
      const gameOwner = profileCookieAccountId(account.account);
      const gameAccountKey = gameOwner ? digest([qq, profileId, gameOwner]) : undefined;
      if (gameJournal?.accountKey && gameJournal.accountKey !== gameAccountKey) {
        await verifyCurrent();
        await auditResult("precheck", false);
        await verifyCurrent();
        return completedRun("precheck", false, "游戏签到提交记录对应原账号，当前档案已换绑。", revision);
      }
      const previousUnconfirmed = new Set(Object.entries(gameJournal?.previous ?? {})
        .filter(([key, state]) => (state === "pending" || state === "unconfirmed") &&
          (manualTarget?.kind !== "game" || key.startsWith(manualTarget.game + ":cn:"))).map(([key]) => key));
      function gameTarget(game: CheckinScheduleGame, role: { uid: string; region: string }) {
        return `${game}:cn:${digest([role.region, role.uid])}`;
      }
      async function runGame(target: string, sequence: CheckinSequence,
        { compatibleOwner = true, legacyGame }: { readonly compatibleOwner?: boolean; readonly legacyGame?: CheckinScheduleGame } = {},
      ): Promise<GameCheckinResult> {
        if (!gameJournal) return runGameCheckinSequence(sequence);
        const owner = gameAccountKey;
        if (!compatibleOwner) return { status: "unconfirmed" };
        const previous = owner ? gameJournal.previous[target] : undefined;
        const legacyScope = legacyGame && gameJournal.previous[legacyGameWriteKey(legacyGame)];
        previousUnconfirmed.delete(target);
        if (previous === "confirmed") return { status: "already" };
        let started = false;
        const allowed = Boolean(owner && !gameJournal.unknown && !legacyScope &&
          (!previous || (previous === "rejected" && input.source === "manual")));
        const result = await runGameCheckinSequence({ ...sequence, canSubmit: allowed,
          beforeSubmit: async () => {
            await gameJournal.start(target, owner!);
            started = true;
          },
        });
        if (owner && started) {
          const state = result.status === "signed" || result.status === "already" ? "confirmed" :
            result.status === "unconfirmed" ? "unconfirmed" : "rejected";
          await gameJournal.settle(target, state, owner);
        } else if (owner && (previous === "pending" || previous === "unconfirmed") && result.status === "already") {
          await gameJournal.settle(target, "confirmed", owner);
        } else if (owner && previous === "pending") {
          await gameJournal.settle(target, "unconfirmed", owner);
        }
        return result;
      }
      const gameRows = rows.filter(row => row.game === "未执行" && Object.hasOwn(targets, row.key) &&
        (!retrying || gameScope?.includes(row.key as CheckinScheduleGame)));
      if (input.announceStart) {
        await verifyCurrent();
        try { await input.announceStart(); } catch { /* A failed progress reply does not cancel the request. */ }
        await verifyCurrent();
      }
      const retryForums: string[] = [];
      const retryGames: CheckinScheduleGame[] = [];
      const hna = rows.find(row => row.key === "hna");
      if (includeAllServices && hna?.game === "未执行") {
        hna.game = "跳过";
        count("skipped");
      }
      if (retrying) {
        for (const row of rows) {
          if (row.game === "未执行" && !gameRows.includes(row)) row.game = "首轮已处理";
          if (row.community === "未执行" && !scoped?.includes(row.forum)) row.community = "不在本轮";
        }
        if (gameScope && gameRows.length !== gameScope.length) {
          notes.push("当前档案已关闭部分或全部待补跑游戏。");
          count("failed");
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
            const previous = journal?.previous[waiting.forum];
            if (previous && previous !== "retryable") continue;
            waiting.community = "暂缓";
            retryForums.push(waiting.forum);
          }
        }
        let state: BbsMissionState | undefined;
        let accepted = false;
        let recoverCommunityCookie = gameRows.length === 0;
        for (const row of selected) {
          await verifyCurrent();
          const previous = journal?.previous[row.forum];
          if (previous === "already" || previous === "accepted") {
            row.community = previous === "already" ? "已签到" : "已受理";
            count(previous === "already" ? "community-already" : "community-accepted");
            continue;
          }
          if (previous === "retryable" && !scoped && input.source !== "manual") {
            deferRemaining();
            notes.push("上次请求遇到限流，待社区补跑。");
            break;
          }
          if (previous && previous !== "retryable" && (previous !== "rejected" || input.source !== "manual")) {
            const rejected = previous === "rejected" || previous === "blocked";
            row.community = rejected ? "失败" : "未确认";
            count(rejected ? "failed" : "unconfirmed");
            notes.push(`${row.label}社区：${rejected ? "上次提交已失败。" : "上次提交结果未确认，请在官方客户端核对。"}`);
            if (previous === "pending" || previous === "unconfirmed") {
              if (input.source === "manual") continue;
              deferRemaining();
            }
            if (previous !== "rejected") break;
            continue;
          }
          if (!state) {
            try {
              const readState = async () => {
                await verifyCurrent();
                return client.fetchBbsMissionState(account, {
                  signal, recoverCookie: recoverCommunityCookie,
                  onCredentialRefresh(current) {
                    recoverCommunityCookie = false;
                    account = current;
                    revision = current.revision;
                  },
                });
              };
              state = shortReadRetry && account.device.id && account.device.fp
                ? await retryRead(readState, signal, error => !(error instanceof BbsCheckinRequestError) && bbsReadMayRetry(error))
                : await readState();
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
            if (blocked) {
              if (journal && !explicit) deferRemaining();
              break;
            }
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
          const reply = await receipt(settings, profileId, rows, ["签到前刷新登录失败，请重新扫码登录对应档案。"],
            { textOnly: input.textOnly });
          await verifyCurrent();
          return completedRun("refresh", false, reply, revision);
        }
        const scheduled = input.source !== "manual";
        const catalog = scheduled || manualTarget?.kind === "game" ? undefined : client.fetchRoleCatalog(account, signal);
        for (const row of gameRows) {
          const key = row.key as CheckinScheduleGame;
          const game = targets[key];
          let roles: Awaited<ReturnType<typeof client.fetchCheckinRoles>>;
          try {
            if (catalog) roles = (await catalog)[game];
            else {
              roles = await retryRead(async () => {
                await verifyCurrent();
                return client.fetchCheckinRoles(account, game, signal);
              }, signal, checkinRoleReadMayRetry);
            }
          } catch (error) {
            if (error instanceof ProfileError ||
                (error instanceof HoyoRequestError && error.code === "profile-changed")) throw error;
            await verifyCurrent();
            if (scheduled && accountIdentity[2] && checkinRoleReadMayRetry(error)) {
              row.game = "暂缓";
              retryGames.push(key);
              notes.push(`${row.label}：角色查询暂未完成，等待当天签到补跑。`);
            } else {
              row.game = "失败";
              count("failed");
              notes.push(`${row.label}：米游社角色查询未完成。`);
            }
            continue;
          }
          await verifyCurrent();
          const blacklist = new Set(settings.games[row.key]?.blacklist);
          const eligible = roles.filter(role => !blacklist.has(role.uid));
          if (!eligible.length) {
            row.game = "跳过";
            count("skipped");
            continue;
          }
          const results: GameCheckinResult[] = [];
          for (const role of eligible) {
            const source = { ...account, game, role };
            const result = await runGame(gameTarget(key, role), {
              signal, verifyCurrent,
              readInfo: () => client.fetchCnGameCheckinInfo(source, { signal, recoverCookie: false }),
              submit: () => submit(source, verifyCurrent, input.notify, row.label, signal),
            }, { legacyGame: key });
            results.push(result);
            count(result.status);
          }
          const finished = outcome(results);
          row.game = finished.label;
          if (finished.reason) notes.push(`${row.label}：${finished.reason}`);
        }
      }
      if (includeAllServices) {
        const roleCheckins = {
          honkai_sr: client.openHoYoLabStarRailCheckin,
          zzz: client.openHoYoLabZzzCheckin,
          tears_of_themis: client.openHoYoLabNxxCheckin,
        } as const;
        for (const game of ["genshin", "honkai_sr", "zzz", "tears_of_themis", "honkai3rd"] as const) {
          const overseas = await profiles.internationalCheckin(qq, profileId, game);
          await verifyCurrent();
          if (overseas.revision !== revision) throw new ProfileError("changed", changed);
          if (overseas.status === "disabled") continue;
          const row = rows.find(item => item.key === game)!;
          if (overseas.status === "unverified") {
            row.game += " · 国际服待绑定";
            count("failed");
            const credential = game === "genshin" ? "HoYoLAB Cookie" : "包含活动登录凭据的 HoYoLAB Cookie";
            notes.push(`${row.label}国际服：请先在私聊核验并绑定${credential}。`);
            continue;
          }
          const overseasKey = `${overseas.realm}/${overseas.accountId}/${game}`;
          if (activeOverseas.has(overseasKey)) {
            row.game += " · 国际服处理中";
            count("failed");
            notes.push(`${row.label}国际服：同账号签到正在执行，请稍后查询。`);
            continue;
          }
          activeOverseas.add(overseasKey);
          try {
            const options = { signal, verifyProfile: verifyCurrent, deviceId: overseasDeviceId };
            const blocked = new Set(overseas.blacklist);
            const results: GameCheckinResult[] = [];
            const family = `${game}:os:`;
            const owned = family + digest([overseas.realm, overseas.accountId]) + ":";
            const sameBinding = !Object.keys(gameJournal?.previous ?? {}).some(key => key.startsWith(family) && !key.startsWith(owned));
            if (game === "genshin" || game === "honkai3rd") {
              const openCheckin = game === "genshin" ? client.openHoYoLabGenshinCheckin : client.openHoYoLabBh3Checkin;
              const remote = await openCheckin(overseas, options);
              if (remote.roles.length && !remote.roles.some(role => blocked.has(role.uid))) {
                results.push(await runGame(owned + digest(["account"]), {
                  signal, verifyCurrent, readInfo: remote.readInfo, submit: () => remote.submit({ blockedUids: overseas.blacklist }),
                }, { compatibleOwner: sameBinding }));
              }
            } else {
              const remote = await roleCheckins[game](overseas, options);
              for (const role of remote.roles) {
                if (blocked.has(role.uid)) continue;
                const result = await runGame(owned + digest([role.region, role.uid]),
                  { ...remote.forRole(role, overseas.blacklist), signal, verifyCurrent }, { compatibleOwner: sameBinding });
                results.push(result);
                if (result.status === "failed" && result.error instanceof GameRecordRequestError) break;
              }
            }
            await verifyCurrent();
            if (!results.length) {
              row.game += " · 国际服跳过";
              count("skipped");
              continue;
            }
            for (const result of results) count(result.status);
            const finished = outcome(results, "HoYoLAB");
            row.game += ` · 国际服${finished.label}`;
            if (finished.reason) notes.push(`${row.label}国际服：${finished.reason}`);
          } catch (error) {
            if (error instanceof CheckinScheduleWriteError) throw error;
            await verifyCurrent();
            row.game += " · 国际服失败";
            count("failed");
            const reason = outcome([{ status: "failed", error }], "HoYoLAB").reason;
            notes.push(`${row.label}国际服：${reason === "部分角色签到失败" ? "无法读取账号角色目录" : reason}`);
          } finally {
            activeOverseas.delete(overseasKey);
          }
        }
      }
      const points = await runCommunity();
      let cloud: string | undefined;
      if (includeAllServices) {
        const { wallets, revision: walletRevision } = await profiles.cloudCheckin(qq, profileId);
        await verifyCurrent();
        if (walletRevision !== revision) throw new ProfileError("changed", changed);
        const balances: string[] = [];
        const minutes = (value?: number) => value === undefined ? "未知" : `${value} 分钟`;
        for (const wallet of wallets) {
          const { game, token } = wallet;
          const name = game === "genshin-os" ? "云原神国际服" : game === "genshin" ? "云原神" : "云绝区零";
          if (!token) {
            count("failed");
            notes.push(game === "genshin-os" ? "请检查当前档案中的云原神国际服凭据。" : `请先在私聊绑定${name}凭据。`);
            continue;
          }
          try {
            const options = { signal, verifyProfile: verifyCurrent };
            if (wallet.game === "genshin-os") {
              const { language, deviceId, deviceModel, androidVersion } = wallet;
              const state = await client.readInternationalCloudGenshinWallet(token, { ...options, language, deviceId, deviceModel, androidVersion });
              await verifyCurrent();
              balances.push(`${name}剩余免费时长：${minutes(state.freeTimeMinutes)}，本次赠送：${minutes(state.grantedMinutes)}`);
            } else {
              const state = game === "genshin"
                ? await client.readCloudGenshinWallet(token, { ...options, browserDeviceId: cloudDeviceId })
                : await client.readCloudZzzWallet(token, options);
              await verifyCurrent();
              balances.push(`${name}剩余免费时长：${minutes(state.freeTimeMinutes)}，本次赠送：${minutes(state.grantedMinutes)}`);
            }
          } catch (error) {
            await verifyCurrent();
            count("failed");
            if ((error instanceof CloudGenshinWalletError || error instanceof CloudZzzWalletError) && error.reason === "expired") {
              notes.push(game === "genshin-os" ? "云原神国际服凭据已失效，请在官方客户端重新登录后更新档案。" : error.message);
            } else if (error instanceof HoyoRequestError && error.code === "invalid-input") {
              notes.push(game === "genshin-os" ? error.message : `请在私聊重新绑定${name}凭据。`);
            } else {
              notes.push(`暂时无法读取${name}剩余免费时长。`);
            }
          }
        }
        cloud = balances.join("\n");
      }
      await verifyCurrent();
      if (gameJournal?.unknown || previousUnconfirmed.size) {
        notes.push("还有旧游戏签到提交结果待核对，请在官方客户端查看。");
        count("unconfirmed");
      }
      const otherFailure = Boolean(counts.failed || counts["first-bind"] || counts.unconfirmed);
      const retry = retryForums.length || retryGames.length ? {
        forums: retryForums, ...(retryGames.length && { games: retryGames }), otherFailure, accountKey: communityAccountKey,
      } : undefined;
      const ok = !otherFailure && !retry;
      await auditResult("checkin", ok);
      await verifyCurrent();
      const reply = await receipt(settings, profileId, rows, notes, { points, cloud, textOnly: input.textOnly });
      await verifyCurrent();
      return completedRun("checkin", ok, reply, revision, retry);
    } catch (error) {
      if (signal.aborted) return { status: "busy" };
      if (error instanceof CheckinScheduleWriteError) throw error;
      if (error instanceof ProfileError && error.code === "changed") return { status: "busy", reply: changed };
      if (error instanceof HoyoRequestError && error.code === "profile-changed") return { status: "busy", reply: error.message };
      input.verifyDay?.();
      await auditResult("runner", false);
      return completedRun("runner", false, "签到未完成，请核对米游社状态。", revision);
    } finally {
      active.delete(key);
    }
  }

  async function runManual(qq: string, profileId: number, input: Pick<Parameters<typeof runProfile>[2],
    "signal" | "verifySession" | "announceStart" | "notify" | "textOnly" | "manualTarget">): Promise<CheckinRun> {
    if (!scheduleStore) return completedRun("precheck", false, "签到记录暂不可用。");
    try {
      const run = await withManualCheckinJournals(scheduleStore, qq, profileId, input.signal,
        scope => runProfile(qq, profileId, { ...input, ...scope, source: "manual" }));
      return run.acquired ? run.value : { status: "busy", reply: "有签到正在执行，请稍后再试。" };
    } catch (error) {
      if (input.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return { status: "busy" };
      return completedRun("precheck", false, error instanceof CheckinScheduleWriteError ? error.message : "无法核对当天签到记录。");
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
      const connection = context.privateCredentialSignal;
      const result = await runManual(String(context.user_id), profileId, {
        signal: connection ? AbortSignal.any([lifecycleSignal, connection]) : lifecycleSignal,
        announceStart: () => context.reply(`开始执行档案 ${profileId} 签到。`),
        notify: context.message_type === "private" ? message => context.reply(message) : undefined,
      });
      return result.reply;
    },
  };

  return {
    ...commands,
    async runNamed(qq: string, command: NonNullable<ReturnType<typeof namedCheckinCommand>>, { signal, verifySession, notify }: {
      readonly signal: AbortSignal; readonly verifySession: () => Promise<void>;
      readonly notify?: (message: string) => unknown;
    }) {
      if (command.profileId > MAX_PROFILE_ID) return "档案编号须在 1 到 255 之间。";
      const result = await runManual(qq, command.profileId, {
        signal: AbortSignal.any([lifecycleSignal, signal]), verifySession, notify, manualTarget: command.target,
      });
      return result.reply;
    },
    async runWeb(qq: string, profileId: number, { signal, verifySession, notify }: {
      readonly signal: AbortSignal; readonly verifySession: () => Promise<void>;
      readonly notify?: (message: string) => unknown;
    }) {
      const result = await runManual(qq, profileId, {
        signal: AbortSignal.any([lifecycleSignal, signal]), verifySession, notify, textOnly: true,
      });
      return {
        status: result.status === "busy" ? "busy" as const : result.ok ? "completed" as const : "failed" as const,
        ...(typeof result.reply === "string" && { message: result.reply }),
        ...(result.status === "complete" && { revision: result.revision }),
      };
    },
    async runScheduled(qq: string, profileId: number, context: CheckinScheduledRunContext): Promise<CheckinRun> {
      const signal = AbortSignal.any([lifecycleSignal, context.signal]);
      return runProfile(qq, profileId, {
        signal, verifyDay: context.verifyDay,
        source: context.gameRetryKeys?.length ? "scheduled_retry" : context.communityRetryForums ? "scheduled_community_retry" : "scheduled",
        communityWrites: context.communityWrites, gameWrites: context.gameWrites,
        communityRetryForums: context.communityRetryForums, gameRetryKeys: context.gameRetryKeys,
        communityAccountKey: context.communityAccountKey,
      });
    },
  };
}
