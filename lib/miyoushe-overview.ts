import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
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

const changed = () => new HoyoRequestError("profile-changed", $t("lib.miyoushe-overview.text_f48c8f7c9c"));

function missionLabel(missionId: number, missionKey: string) {
  // 米游社自 4 月 28 日起撤下三项日常互动任务（公告 74971515）。
  if ([59, 60, 61].includes(missionId) || ["read_post", "like_post", "share_post"].includes(missionKey)) return;
  if (missionId === 58 || missionKey === "continuous_sign") return $t("lib.miyoushe-overview.text_1746b0d94b");
  if (missionKey.startsWith("bind_game_role")) return $t("lib.miyoushe-overview.text_511ec0d13d");
  if (missionKey.startsWith("modify_signature")) return $t("lib.miyoushe-overview.text_929ada9b6c");
  return $t("lib.miyoushe-overview.text_5ec327b66e", { "missionId": missionId });
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
    "cookie-expired": $t("lib.miyoushe-overview.text_bb531120ac"),
    "login-expired": $t("lib.miyoushe-overview.text_551318d06b"),
    risk: $t("lib.miyoushe-overview.text_11497a3690"),
    "rate-limited": $t("lib.miyoushe-overview.text_1e7373e7d2"),
  })[error.reason];
  if (error instanceof HoyoRequestError && error.code === "refresh") return $t("lib.miyoushe-overview.text_cfe1abea95");
  return $t("lib.miyoushe-overview.text_92c7816b49");
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
          signal, allowPointsOnly: true, verifyBinding: verifyLogin,
          onCredentialRefresh(refreshed) {
            secrets.push(...profileSecrets(refreshed));
            revision = refreshed.revision;
          },
        });
        missions = projectMissions(data);
        revision = data.revision;
      } catch (error) {
        signal?.throwIfAborted();
        await verifyLogin?.();
        if (error instanceof HoyoRequestError && error.code === "profile-changed") throw error;
        missionError = missionProblem(error);
      }
    } else missionError = $t("lib.miyoushe-overview.text_ef81073a10");

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
