import { createProfileStore, type Game, type ProfileAccountContext } from "@lotus-yunzai/account";
import { BbsCheckinRequestError, createProfileHoyoClient, HoyoRequestError, type BbsMissionState } from "@lotus-yunzai/hoyo-client";
import { checkinScheduleClock, type CheckinSchedulePlan } from "./checkin-schedule-plan.ts";

export interface MiyousheOverviewTarget {
  readonly qq: string;
  readonly profileId: number;
}

interface MissionRow {
  readonly missionId: number;
  readonly label: string;
  readonly happenedTimes?: number;
  readonly threshold?: number;
  readonly isGetAward?: boolean;
}

export interface MiyousheOverview {
  readonly profileId: number;
  readonly displayName: string;
  readonly account: {
    readonly loggedIn: boolean;
    readonly deviceBound: boolean;
    readonly roles: readonly { readonly game: Game; readonly uid: string; readonly nickname: string }[];
  };
  readonly todaySchedule: {
    readonly date: string;
    readonly enabled: boolean;
    readonly time?: string;
    readonly done?: boolean;
    readonly running?: boolean;
    readonly ok?: boolean;
  } | null;
  readonly missions: {
    readonly balance?: number;
    readonly received?: number;
    readonly todayTotal?: number;
    readonly remaining?: number;
    readonly items: readonly MissionRow[];
  } | null;
  readonly missionError?: string;
}

interface MiyousheOverviewOptions {
  readonly profileDirectory?: string | URL;
  readonly readTodaySchedule?: (date: string) => Promise<CheckinSchedulePlan | undefined>;
  readonly scheduleEnabled?: boolean;
  readonly transport?: Parameters<typeof createProfileHoyoClient>[1];
  readonly now?: () => number;
}

const changed = () => new HoyoRequestError("profile-changed", "档案已变更，请刷新后重试。");

function missionLabel(missionId: number, missionKey: string) {
  // 米游社自 4 月 28 日起撤下三项日常互动任务（公告 74971515）。
  if ([59, 60, 61].includes(missionId) || ["read_post", "like_post", "share_post"].includes(missionKey)) return;
  if (missionId === 58 || missionKey === "continuous_sign") return "社区连续签到";
  if (missionKey.startsWith("bind_game_role")) return "绑定游戏角色";
  if (missionKey.startsWith("modify_signature")) return "完善个人签名";
  return `社区任务 ${missionId}`;
}

function projectMissions(state: BbsMissionState): NonNullable<MiyousheOverview["missions"]> {
  return {
    balance: state.totalPoints,
    received: state.receivedPoints,
    todayTotal: state.todayTotalPoints,
    remaining: state.remainingPoints,
    items: state.states.flatMap(({ missionId, missionKey, happenedTimes, threshold, isGetAward }) => {
      const label = missionLabel(missionId, missionKey ?? "");
      return label ? [{ missionId, label, happenedTimes, threshold, isGetAward }] : [];
    }),
  };
}

function missionProblem(error: unknown) {
  if (error instanceof BbsCheckinRequestError) return ({
    "cookie-expired": "当前档案的 Cookie 已过期，请重新登录后刷新。",
    "login-expired": "当前档案登录已过期，请重新登录后刷新。",
    risk: "请在米游社官方客户端完成验证后刷新。",
    "rate-limited": "读取任务过于频繁，请稍后刷新。",
  })[error.reason];
  if (error instanceof HoyoRequestError && error.code === "refresh") return "无法刷新当前档案的 Cookie，请确认登录状态。";
  return "暂时无法读取社区任务和余额。";
}

function profileSecrets(context: ProfileAccountContext) {
  const { cookie, stoken, stokenCookie, ltoken, mid } = context.account;
  const { id, fp } = context.device;
  return [cookie, stoken, stokenCookie, ltoken, mid, id, fp].filter(Boolean);
}

function roleNickname(nickname: string, secrets: readonly string[]) {
  if (secrets.some(secret => nickname.includes(secret))) return "";
  return nickname.replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, 80);
}

export function createMiyousheOverview({ profileDirectory, readTodaySchedule,
  scheduleEnabled = true, transport, now = Date.now }: MiyousheOverviewOptions = {}) {
  const profiles = createProfileStore(profileDirectory);
  const client = createProfileHoyoClient(profiles, transport);
  return async ({ qq, profileId }: MiyousheOverviewTarget, signal?: AbortSignal,
    verifyLogin?: () => Promise<void>): Promise<MiyousheOverview> => {
    signal?.throwIfAborted();
    const initial = await profiles.checkinSettings(qq, profileId);
    let revision = initial.revision;
    const secrets: string[] = [];
    let missions: MiyousheOverview["missions"] = null;
    let missionError: string | undefined;
    if (initial.loggedIn) {
      const account = await profiles.accountContext(qq, profileId);
      await verifyLogin?.();
      if (account.revision !== revision) throw changed();
      secrets.push(...profileSecrets(account));
      try {
        const data = await client.fetchBbsMissionState(account, {
          signal,
          onCredentialRefresh(refreshed) {
            secrets.push(...profileSecrets(refreshed));
            revision = refreshed.revision;
          },
        });
        missions = projectMissions(data);
        revision = data.revision;
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof HoyoRequestError && error.code === "profile-changed") throw error;
        missionError = missionProblem(error);
      }
    } else missionError = "当前档案尚未登录，请在聊天中扫码登录。";

    const { date } = checkinScheduleClock(now());
    const plan = await readTodaySchedule?.(date).catch(() => null);
    const entry = plan?.date === date ? plan.entries.find(item => !item.manualOnly && item.qq === qq && item.profileId === profileId) : undefined;
    const profile = await profiles.describe(qq, profileId);
    const current = await profiles.checkinSettings(qq, profileId);
    signal?.throwIfAborted();
    if (current.revision !== revision) throw changed();

    return {
      profileId,
      displayName: roleNickname(current.displayName, secrets),
      account: {
        loggedIn: current.loggedIn,
        deviceBound: profile.deviceBound,
        roles: (Object.keys(profile.roles) as Game[]).flatMap(game => profile.roles[game].map(role => ({
          game, uid: role.uid, nickname: current.loggedIn ? roleNickname(role.nickname, secrets) : "",
        }))),
      },
      todaySchedule: readTodaySchedule && plan !== null ? {
        date, enabled: current.enabled && scheduleEnabled,
        ...(entry && { time: entry.time, done: entry.done, running: Boolean(entry.runningAt), ok: entry.done && entry.ok === true }),
      } : null,
      missions,
      missionError,
    };
  };
}
