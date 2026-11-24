import { readGenshinMonthly, type GenshinMonthlyOptions } from "./genshin-monthly.ts";
import { hasConflictingProfileCookieIdentity, normalizeGameRoles, profileCookieAccountId, profileGames, type Game, type GameRole, type ProfileAccountContext, type ProfileRequestContext, type RefreshedCredentials, createProfileStore } from "@lotus-yunzai/account";
import { BbsCheckinRequestError, readBbsMissionState, submitBbsCheckin, type BbsCheckinForum } from "./bbs-checkin.ts";
import { readCloudGenshinWallet, readInternationalCloudGenshinWallet } from "./cloud-genshin-wallet.ts";
import { readCloudZzzWallet } from "./cloud-zzz-wallet.ts";
import { createCredentialExchange, type HoyoTransport } from "./credentials.ts";
import { isDailyNoteCookieExpired, readDailyNote, readHoYoLabZzzDailyNote, type DailyNoteOptions, type DailyNoteSnapshot } from "./daily-note.ts";
import { HoyoRequestError, requiresServiceVerification } from "./errors.ts";
import { observeCnRead } from "./cn-read-diagnostics.ts";
import { openHoYoLabBh3Checkin } from "./hoyolab-bh3-checkin.ts";
import { openHoYoLabGenshinCheckin, type HoYoLabGenshinCheckinSource } from "./hoyolab-genshin-checkin.ts";
import { openHoYoLabNxxCheckin } from "./hoyolab-nxx-checkin.ts";
import { openHoYoLabStarRailCheckin } from "./hoyolab-starrail-checkin.ts";
import { openHoYoLabZzzCheckin } from "./hoyolab-zzz-checkin.ts";
import { isBh3CnCheckinRegion, readCnGameCheckinInfo, submitCnGameCheckin, type CnGameCheckinSource } from "./game-checkin.ts";
import { GameRecordRequestError, isGameRecordCookieExpired, isUnspecifiedCnRecordRegion, readGameRecordPayload } from "./game-record.ts";
import { MiyousheExchangeError, readMiyousheShopAccountQuota, readMiyousheShopAddresses, readMiyousheShopBalance, submitMiyousheShopExchange,
  type MiyousheShopOrder, type ShopManualVerification } from "./miyoushe-exchange.ts";
import { readGenshinBackpack, readGenshinGrowth, type GenshinBackpackOptions, type GenshinGrowthOptions } from "./genshin-backpack.ts";
import { createGenshinBlueprintReader, type GenshinBlueprintOptions } from "./genshin-blueprint.ts";
import { GenshinAuthKeyRequestError, readGenshinGacha, type GenshinGachaOptions } from "./genshin-gacha.ts";
import { readGenshinDecks, readGenshinGcgCollection, type GenshinGcgCollectionScope } from "./genshin-gcg.ts";
import { readGenshinWorldBoss } from "./genshin-world-boss.ts";
import { readGenshinMiniapp, type GenshinMiniappOptions } from "./genshin-miniapp.ts";
import { readGenshinHardChallenge, type GenshinHardChallengeOptions } from "./genshin-hard-challenge.ts";
import { createGenshinChallengeReader, createGenshinPersonalRecordReader, readGenshinCharacterList, readGenshinPanel,
  readGenshinTalents, readGenshinTarotCollection, type GenshinChallengeOptions, type GenshinPanelOptions } from "./genshin-panel.ts";
import { readStarRailGridFight, type StarRailGridFightOptions } from "./starrail-grid-fight.ts";
import { readStarRailGrowth, type StarRailGrowthOptions } from "./starrail-growth.ts";
import { readStarRailRogue, type StarRailRogueOptions } from "./starrail-rogue.ts";
import { readStarRailChallenge, starRailChallengeRegion, type StarRailChallengeOptions } from "./starrail-challenge.ts";
import { readStarRailPanel, type StarRailPanelOptions } from "./starrail-panel.ts";
import { readStarRailPersonalRoster, type StarRailRosterOptions } from "./starrail-roster.ts";
import { readStarRailPersonalRecord } from "./starrail-record.ts";
import { readStarRailMonthly, type StarRailMonthlyOptions } from "./starrail-monthly.ts";
import { readStarRailLedger, readStarRailOnline, type StarRailLedgerOptions, type StarRailOnlineOptions } from "./starrail-ledger.ts";
import { readStarRailGacha, type StarRailGachaOptions } from "./starrail-gacha.ts";
import { isZzzGachaAuthExpired, readZzzGachaAuthKey } from "./zzz-gacha-auth.ts";
import { resolveZzzGachaLinkRole } from "./zzz-gacha-link.ts";
import { readZzzDeadly } from "./zzz-deadly.ts";
import { readHoYoLabZzzGameRecord, readZzzGameRecord, readZzzOwnedBuddyRoster } from "./zzz-game-record.ts";
import { readZzzHoloBoss } from "./zzz-holo-boss.ts";
import { openHoYoLabZzzMonthly, readZzzMonthly } from "./zzz-monthly.ts";
import { readZzzExploration } from "./zzz-exploration.ts";
import { readZzzZenkov } from "./zzz-zenkov.ts";
import { readZzzHollowZero } from "./zzz-hollow-zero.ts";
import { readZzzClimbingTower } from "./zzz-climbing-tower.ts";
import { readZzzVoidFront } from "./zzz-void-front.ts";
import { readZzzPanel, type ZzzPanelOptions } from "./zzz-panel.ts";
import { readZzzShiyu } from "./zzz-shiyu.ts";
import { isZzzTuningCookieExpired, readZzzTuning, readZzzTuningInventory, resolveZzzTuningRegion, type ZzzTuningOptions } from "./zzz-tuning.ts";

export { readGenshinTeamDamage, type TeamDamagePayload, type TeamDamageRole, type TeamDamageArtifact } from "./genshin-team-damage.ts";
export { createCredentialExchange };
export { needsLegacyCookieRepair } from "./credentials.ts";
export { CloudGenshinWalletError, normalizeCloudGenshinComboToken, readCloudGenshinWallet } from "./cloud-genshin-wallet.ts";
export { CloudZzzWalletError, normalizeCloudZzzComboToken, readCloudZzzWallet } from "./cloud-zzz-wallet.ts";
export { HoyoRequestError };
export { verifyHoYoLabCookie, type HoYoLabPassportRealm } from "./hoyolab-cookie.ts";
export { BbsCheckinRequestError, bbsCheckinForums, type BbsCheckinForum, type BbsMissionState } from "./bbs-checkin.ts";
export { readBbsForumPosts, type BbsForumPost } from "./bbs-forum-posts.ts";
export { normalizeGenshinMonthly, type GenshinMonthlySnapshot } from "./genshin-monthly.ts";
export { GameRecordRequestError, genshinCnRecordRegion, readGameRecordPayload } from "./game-record.ts";
export type { ZzzGameRecordItem, ZzzGameRecordSnapshot, ZzzOwnedBuddyRoster } from "./zzz-game-record.ts";
export { normalizeZzzPanelAvatar, type ZzzPanelAvatar, type ZzzPanelSnapshot } from "./zzz-panel.ts";
export { normalizeZzzDeadly, type ZzzDeadlyRoom, type ZzzDeadlySnapshot } from "./zzz-deadly.ts";
export { normalizeZzzHoloBoss } from "./zzz-holo-boss.ts";
export type { ZzzHoloBossRoom, ZzzHoloBossSnapshot } from "./zzz-holo-boss.ts";
export { normalizeZzzMonthly, zzzMonthlyKey, type ZzzMonthlyRecord } from "./zzz-monthly.ts";
export { zzzExplorationColumns, splitZzzExploration } from "./zzz-exploration.ts";
export type { ZzzExplorationSnapshot, ZzzExplorationArea, ZzzExplorationMap } from "./zzz-exploration.ts";
export { zzzZenkovPageSize } from "./zzz-zenkov.ts";
export type { ZzzZenkovItem, ZzzZenkovMap, ZzzZenkovMode, ZzzZenkovRank, ZzzZenkovRun, ZzzZenkovSnapshot } from "./zzz-zenkov.ts";
export type { ZzzHollowChallenge, ZzzHollowFighter, ZzzHollowMode, ZzzHollowProgress, ZzzHollowSnapshot } from "./zzz-hollow-zero.ts";
export { normalizeZzzClimbingTower } from "./zzz-climbing-tower.ts";
export type { ZzzClimbingTowerSnapshot, ZzzTowerAvatar, ZzzTowerSeason } from "./zzz-climbing-tower.ts";
export { normalizeZzzVoidFront } from "./zzz-void-front.ts";
export type { ZzzVoidFrontRound, ZzzVoidFrontSnapshot, ZzzVoidFrontStage } from "./zzz-void-front.ts";
export { normalizeZzzShiyu, type ZzzShiyuDate, type ZzzShiyuPortrait, type ZzzShiyuSnapshot, type ZzzShiyuTeam } from "./zzz-shiyu.ts";
export { GameCheckinChallengeError, type GameCheckinChallenge, type GameCheckinProof,
  type CnGameCheckinInfo, type CnGameCheckinSource } from "./game-checkin.ts";
export type { GenshinBackpackItem, GenshinBackpackOptions, GenshinBackpackProbe, GenshinBackpackProbeItem,
  GenshinBackpackSnapshot, GenshinGrowthItem, GenshinGrowthOptions, GenshinGrowthSnapshot } from "./genshin-backpack.ts";
export type { GenshinBlueprint, GenshinBlueprintItem, GenshinBlueprintOptions } from "./genshin-blueprint.ts";
export type { GenshinDeck, GenshinDeckCard, GenshinDeckList, GenshinGcgCollection, GenshinGcgCollectionCard, GenshinGcgCollectionScope, GenshinGcgSummary } from "./genshin-gcg.ts";
export type { GenshinWorldBossSnapshot } from "./genshin-world-boss.ts";
export { ZzzManualGachaLinkRequired } from "./errors.ts";
export { DailyNoteRequestError, type DailyNoteSnapshot, type DailyNoteOptions } from "./daily-note.ts";
export { createPassportQr, PassportQrError, type PassportQrSession } from "./passport-qr.ts";
export { genshinGachaPools, type GenshinGachaOptions, type GenshinGachaPool, type GenshinGachaRow } from "./genshin-gacha.ts";
export type { StarRailLedgerKind, StarRailLedgerRow, StarRailLedgerOptions, StarRailOnlineOptions, StarRailPowerRecovery } from "./starrail-ledger.ts";
export { defaultStarRailGrowthLevels, type StarRailGrowthSnapshot, type StarRailGrowthOptions } from "./starrail-growth.ts";
export { normalizeStarRailMonthly, type StarRailMonthlySnapshot, type StarRailMonthlyOptions } from "./starrail-monthly.ts";
export type { StarRailChallengeKind, StarRailChallengeOptions, StarRailChallengePeriod } from "./starrail-challenge.ts";
export { starRailChallengeRegion } from "./starrail-challenge.ts";
export { starRailGachaPools, type StarRailGachaOptions, type StarRailGachaPool } from "./starrail-gacha.ts";
export { resolveZzzTuningRegion, zzzTuningPools, ZzzTuningRateLimitError, type ZzzTuningOptions, type ZzzTuningSnapshot } from "./zzz-tuning.ts";
export { isZzzGachaLinkMessage, parseZzzGachaLink, readZzzGachaLink, resolveZzzGachaLinkRole, ZzzGachaLinkError,
  type ZzzGachaLink } from "./zzz-gacha-link.ts";
export type GenshinGachaSnapshot = Awaited<ReturnType<typeof readGenshinGacha>>;

const gameBiz: Record<Game, string> = {
  gs: "hk4e_cn",
  sr: "hkrpg_cn",
  zzz: "nap_cn",
};

const checkinGameBiz = { ...gameBiz, nxx: "nxx_cn", bh3: "bh3_cn", bh2: "bh2_cn" } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const expired = new Set([-100, 10001, 10101, 10102, 10103]);

export function isCookieExpired(error: unknown): boolean {
  return error instanceof HoyoRequestError && error.code === "api" &&
    error.retcode !== undefined && expired.has(error.retcode);
}

function isGenshinAuthExpired(error: unknown): boolean {
  return error instanceof GenshinAuthKeyRequestError && isCookieExpired(error);
}

function isGenshinPersonalRecordCookieExpired(error: unknown) {
  return error instanceof GameRecordRequestError && error.reason === "expired" &&
    error.retcode !== 10101 && error.retcode !== 10102;
}

interface CookieRecovery {
  readonly profiles: Pick<ReturnType<typeof createProfileStore>, "accountContext" | "saveRefreshedCredentials" | "saveRoles">
    & Partial<Pick<ReturnType<typeof createProfileStore>, "requestSelectedContext" | "requestContexts">>;
  readonly exchange: (profile: ProfileAccountContext, options?: { readonly verifyProfile?: () => Promise<void> }) => Promise<RefreshedCredentials>;
  readonly scope?: () => Promise<string>;
  readonly syncRoles?: boolean;
}

interface RefreshedProfile {
  readonly profile: ProfileAccountContext;
  readonly rolesSynced: boolean;
}

interface CookieRevision {
  requests: number;
  refreshing: boolean;
  refreshed?: Promise<RefreshedProfile>;
}

const sharedRevisions = new Map<string, CookieRevision>();

export function createHoyoClient(
  transport: HoyoTransport = fetch,
  recovery?: CookieRecovery,
) {
  const revisions = recovery?.scope ? sharedRevisions : new Map<string, CookieRevision>();

  async function keyFor({ qq, profileId, revision }: ProfileAccountContext): Promise<string> {
    const scope = await recovery?.scope?.().catch(() => {
      throw new HoyoRequestError("profile-changed", "游戏档案目录已变更，请重新发起请求。");
    });
    return JSON.stringify([scope, qq, profileId, revision]);
  }

  function track(key: string): CookieRevision {
    const existing = revisions.get(key);
    if (existing) return existing;
    const entry = { requests: 0, refreshing: false };
    revisions.set(key, entry);
    return entry;
  }

  function release(key: string, entry: CookieRevision): void {
    if (entry.requests === 0 && !entry.refreshing) revisions.delete(key);
  }

  async function recover(context: ProfileAccountContext, requestKey?: string): Promise<RefreshedProfile> {
    if (!recovery) throw new HoyoRequestError("refresh", "未配置登录凭据刷新服务。");

    const key = requestKey ?? await keyFor(context);
    const entry = track(key);
    if (entry.refreshed) return entry.refreshed;

    entry.refreshing = true;
    const operation = (async () => {
      const latest = await recovery.profiles.accountContext(context.qq, context.profileId);
      if (latest.revision !== context.revision) {
        throw new HoyoRequestError("refresh", "档案已变更，请重新发起请求。");
      }
      const credentials = await recovery.exchange(latest, { verifyProfile: () => ensureCurrentProfile(latest) });
      const roles = recovery.syncRoles ? await list({ ...latest, account: { ...latest.account, ...credentials } })
        .then(roleCatalog).catch(() => null) : undefined;
      const profile = await recovery.profiles.saveRefreshedCredentials(latest.qq, latest.profileId, latest.revision, credentials, roles);
      return { profile, rolesSynced: Boolean(roles) };
    })();
    entry.refreshed = operation;
    const settle = (success: boolean) => {
      entry.refreshing = false;
      if (!success) entry.refreshed = undefined;
      release(key, entry);
    };
    void operation.then(() => settle(true), () => settle(false));
    return operation;
  }

  async function list(context: ProfileAccountContext, game?: keyof typeof checkinGameBiz, signal?: AbortSignal,
    verify = () => ensureCurrentProfile(context)): Promise<unknown[]> {
    if (game !== undefined && !Object.hasOwn(checkinGameBiz, game)) {
      throw new HoyoRequestError("invalid-input", "游戏类型无效。");
    }
    verifyCookieIdentity(context);
    const cookie = context.account.cookie;
    if (!cookie.trim() || /[\r\n\0]/u.test(cookie)) {
      throw new HoyoRequestError("invalid-input", "档案 Cookie 无效。");
    }

    const path = "/binding/api/getUserGameRolesByCookie";
    const endpoint = new URL(path, "https://api-takumi.mihoyo.com");
    if (game !== undefined) endpoint.searchParams.set("game_biz", checkinGameBiz[game]);
    const timeout = AbortSignal.timeout(15_000);
    const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;

    const diagnostics = observeCnRead(path, "GET", signal, timeout);
    let response: Response;
    try {
      signal?.throwIfAborted();
      await verify();
      signal?.throwIfAborted();
      response = await diagnostics.read(() => transport(endpoint, {
        headers: { Cookie: cookie, Accept: "application/json" },
        redirect: "error",
        proxy: false,
        signal: deadline,
      }));
    } catch (error) {
      if (error instanceof HoyoRequestError && error.code === "profile-changed") throw error;
      throw new HoyoRequestError("transport", "米游社角色请求未完成。");
    }
    if (response.redirected || (response.url && response.url !== endpoint.href) ||
        (!response.ok && response.status !== 401)) {
      await response.body?.cancel().catch(() => undefined);
      throw new HoyoRequestError("http", "米游社返回 HTTP 错误。", response.status);
    }

    const payload = await readGameRecordPayload(response, 256 * 1024, deadline, error => diagnostics.stream(response, error));
    signal?.throwIfAborted();
    const code = payload?.retcode;
    const retcode = typeof code === "string" && /^-?\d{1,10}$/u.test(code) ? Number(code) : code;
    const risk = requiresServiceVerification(payload ?? {}, response.headers.get("x-rpc-aigis"));
    if (!response.ok && (risk || typeof retcode !== "number" || !expired.has(retcode))) {
      throw new HoyoRequestError("http", "米游社返回 HTTP 错误。", response.status);
    }
    if (!payload || typeof retcode !== "number" || !Number.isSafeInteger(retcode)) {
      throw new HoyoRequestError("response", "米游社角色响应格式有误。");
    }
    if (risk || retcode !== 0) {
      throw new HoyoRequestError("api", "米游社角色查询失败。", response.status, risk && expired.has(retcode) ? undefined : retcode);
    }
    if (!isRecord(payload.data) || !Array.isArray(payload.data.list)) {
      throw new HoyoRequestError("response", "米游社角色列表格式有误。");
    }

    await verify();
    signal?.throwIfAborted();
    if (deadline.aborted) throw new HoyoRequestError("transport", "米游社角色请求未完成。");
    return payload.data.list;
  }

  function rolesFor(data: readonly unknown[], game: Game): GameRole[] {
    return normalizeGameRoles(data.filter((item) => isRecord(item) && item.game_biz === gameBiz[game]));
  }

  async function retrieve<Data>(
    context: ProfileAccountContext,
    attempt: (profile: ProfileAccountContext) => Promise<Data>,
    signal?: AbortSignal,
    isExpired = isCookieExpired,
  ) {
    verifyCookieIdentity(context);
    if (!recovery) return { context, data: await attempt(context) };
    const key = await keyFor(context);
    const entry = track(key);
    entry.requests++;
    try {
      try {
        return { context, data: await attempt(context) };
      } catch (error) {
        if (signal?.aborted || !isExpired(error)) throw error;
      }

      let refreshed: ProfileAccountContext;
      try {
        const { profile: saved } = await recover(context, key);
        refreshed = await recovery.profiles.accountContext(context.qq, context.profileId);
        if (refreshed.revision !== saved.revision) throw new Error("档案在刷新后已变更。");
      } catch (cause) {
        throw new HoyoRequestError("refresh", "无法刷新当前档案的 Cookie，请确认登录状态后重试。", undefined, undefined, { cause });
      }
      signal?.throwIfAborted();
      return { context: refreshed, data: await attempt(refreshed) };
    } finally {
      entry.requests--;
      release(key, entry);
    }
  }

  async function ensureCurrentProfile(profile: ProfileAccountContext) {
    if (!recovery) return;
    const changed = new HoyoRequestError("profile-changed", "游戏档案已变更，请重新发起请求。");
    const latest = await recovery.profiles.accountContext(profile.qq, profile.profileId).catch(() => { throw changed; });
    if (latest.revision !== profile.revision) throw changed;
  }

  function verifyCookieIdentity(profile: ProfileAccountContext) {
    if (hasConflictingProfileCookieIdentity(profile.account)) {
      throw new HoyoRequestError("invalid-input", "档案 Cookie 与当前登录账号不一致，请刷新或重新扫码登录。");
    }
  }

  async function readForProfile<Source extends ProfileAccountContext, Options extends { readonly signal?: AbortSignal }, Data extends object>(
    source: Source,
    options: Options,
    reader: (source: Source, transport: HoyoTransport, options: Options, guard?: () => Promise<void>) => Promise<Data>,
    isExpired?: (error: unknown) => boolean,
    onAttempt?: (profile: ProfileAccountContext) => void,
  ) {
    const { context, data } = await retrieve(source, async (profile) => {
      onAttempt?.(profile);
      const guard = recovery && (() => ensureCurrentProfile(profile));
      return reader({ ...source, ...profile }, transport, options, guard);
    }, options.signal, isExpired);
    return { ...data, revision: context.revision, refreshedCookie: context.revision !== source.revision };
  }

  function readForGenshinGacha<Options extends { readonly signal?: AbortSignal }, Data extends object>(
    source: ProfileRequestContext, options: Options,
    reader: (source: ProfileRequestContext, transport: HoyoTransport, options: Options,
      guard?: () => Promise<void>) => Promise<Data>,
  ) {
    return readForProfile(source, options, async (current, request, sameOptions, guard) => {
      const profiles = recovery?.profiles;
      if (current.revision !== source.revision && profiles?.requestSelectedContext) {
        const changed = new HoyoRequestError("profile-changed", "续期后原神档案的角色已变更，请重新发起请求。");
        const selected = await profiles.requestSelectedContext(current.qq, current.profileId, "gs").catch(() => { throw changed; });
        if (selected.revision !== current.revision || selected.role.uid !== source.role.uid ||
            (source.role.region && selected.role.region !== source.role.region) ||
            (source.role.gameBiz && selected.role.gameBiz !== source.role.gameBiz)) throw changed;
        return reader(selected, request, sameOptions, guard);
      }
      return reader(current, request, sameOptions, guard);
    }, isGenshinAuthExpired);
  }

  function sameTuningRegion(previous: ProfileRequestContext, current: ProfileRequestContext) {
    try {
      return resolveZzzTuningRegion(previous) === resolveZzzTuningRegion(current);
    } catch {
      return false;
    }
  }

  function readForZzzTuning<Data extends object>(source: ProfileRequestContext, options: ZzzTuningOptions,
    reader: (source: ProfileRequestContext, transport: HoyoTransport, options: ZzzTuningOptions,
      guard?: () => Promise<void>) => Promise<Data>) {
    return readForProfile(source, options, async (current, request, sameOptions, guard) => {
      const profiles = recovery?.profiles;
      if (current.revision !== source.revision && profiles?.requestSelectedContext) {
        const changed = new HoyoRequestError("profile-changed", "绝区零档案角色已变化，请重新发起请求。");
        const selected = await profiles.requestSelectedContext(current.qq, current.profileId, "zzz").catch(() => { throw changed; });
        if (selected.revision !== current.revision || selected.role.uid !== source.role.uid ||
            !sameTuningRegion(source, selected)) throw changed;
      }
      return reader(current, request, sameOptions, guard);
    }, isZzzTuningCookieExpired);
  }

  async function readForShop<T>(source: ProfileAccountContext, options: { readonly signal?: AbortSignal; readonly verifyBinding?: () => Promise<void> },
    read: (profile: ProfileAccountContext, guard: () => Promise<void>) => Promise<T>) {
    const result = await retrieve(source, profile => read(profile, async () => {
      await options.verifyBinding?.();
      await ensureCurrentProfile(profile);
    }), options.signal, error => error instanceof MiyousheExchangeError && error.reason === "expired");
    return result.data;
  }

  function roleCatalog(data: readonly unknown[]) {
    const roles = {
      gs: rolesFor(data, "gs"), sr: rolesFor(data, "sr"), zzz: rolesFor(data, "zzz"),
    };
    // An unsupported game is omitted, but malformed entries for supported games must not clear saved roles.
    for (const item of data) {
      if (!isRecord(item) || !item.game_biz ||
          (profileGames.some((game) => gameBiz[game] === item.game_biz) && !normalizeGameRoles([item]).length)) {
        throw new HoyoRequestError("response", "米游社角色资料不完整。");
      }
    }
    return roles;
  }

  function extraCheckinRoles(data: readonly unknown[], biz: string, allowedRegion: (region: string) => boolean) {
    const roles = new Map<string, GameRole>();
    for (const item of data) {
      if (!isRecord(item) || item.game_biz !== biz || typeof item.region !== "string" || !allowedRegion(item.region)) continue;
      const role = normalizeGameRoles([item])[0];
      if (!role || !/^[1-9]\d{0,19}$/u.test(role.uid)) continue;
      const key = `${role.region}:${role.uid}`;
      if (!roles.has(key)) roles.set(key, role);
    }
    return [...roles.values()];
  }

  function checkinRoleCatalog(data: readonly unknown[]) {
    return {
      ...roleCatalog(data),
      nxx: extraCheckinRoles(data, checkinGameBiz.nxx, region => region === "cn_prod_gf01"),
      bh3: extraCheckinRoles(data, checkinGameBiz.bh3, isBh3CnCheckinRegion),
      bh2: extraCheckinRoles(data, checkinGameBiz.bh2, region => region === "gf01"),
    };
  }

  async function saveRoles(context: ProfileAccountContext, data: readonly unknown[]) {
    if (!recovery) throw new HoyoRequestError("invalid-input", "未配置角色档案存储。");
    const roles = roleCatalog(data);
    await recovery.profiles.saveRoles(context.qq, context.profileId, context.revision, roles);
    return roles;
  }

  return {
    async refreshCredentials(context: ProfileAccountContext) {
      return (await recover(context)).profile;
    },
    async checkLoginCookie(context: ProfileAccountContext, options: {
      readonly signal: AbortSignal;
      readonly verifyReadOnly?: () => Promise<void>;
    }) {
      let revision = context.revision;
      if (!profileCookieAccountId(context.account)) return { state: "unknown" as const, revision };
      const attempt = (profile: ProfileAccountContext) => {
        revision = profile.revision;
        return list(profile, undefined, options.signal, options.verifyReadOnly);
      };
      try {
        const data = options.verifyReadOnly ? await attempt(context) : (await retrieve(context, attempt, options.signal)).data;
        roleCatalog(data);
        const state = revision === context.revision ? "valid" : "recovered";
        return { state, revision } as const;
      } catch (error) {
        options.signal.throwIfAborted();
        const exchangeFailure = error instanceof HoyoRequestError && error.code === "refresh" && error.cause;
        const state = isCookieExpired(error) || isCookieExpired(exchangeFailure) ? "expired" : "unknown";
        return { state, revision } as const;
      }
    },
    fetchMiyousheShopAccountQuota(source: ProfileAccountContext, goodsId: string,
      options: { readonly signal?: AbortSignal; readonly verifyBinding?: () => Promise<void> } = {},
    ) {
      return readForShop(source, options, (profile, guard) =>
        readMiyousheShopAccountQuota(transport, profile, goodsId, options.signal, guard));
    },
    fetchMiyousheShopAddresses(source: ProfileAccountContext, options: { readonly signal?: AbortSignal; readonly verifyBinding?: () => Promise<void> } = {}) {
      return readForShop(source, options, (profile, guard) => readMiyousheShopAddresses(transport, profile, options.signal, guard));
    },
    fetchMiyousheShopAccount(source: ProfileAccountContext,
      options: { readonly includeAddresses?: boolean; readonly signal?: AbortSignal; readonly verifyBinding?: () => Promise<void> } = {}) {
      return readForShop(source, options, async (profile, guard) => ({
        balance: await readMiyousheShopBalance(transport, profile, options.signal, guard),
        addresses: options.includeAddresses ? await readMiyousheShopAddresses(transport, profile, options.signal, guard) : [],
      }));
    },
    exchangeMiyousheShopGoods(source: ProfileAccountContext, order: MiyousheShopOrder,
      { signal, verifyBinding, manual }: { readonly signal?: AbortSignal; readonly verifyBinding?: () => Promise<void>;
        readonly manual?: ShopManualVerification } = {}) {
      return submitMiyousheShopExchange(transport, source, order, signal, async () => {
        await verifyBinding?.();
        await ensureCurrentProfile(source);
      }, manual);
    },
    async refreshProfile(context: ProfileAccountContext, signal?: AbortSignal): Promise<{ rolesSynced: boolean; revision?: string }> {
      signal?.throwIfAborted();
      const { profile: refreshed, rolesSynced } = await recover(context);
      signal?.throwIfAborted();
      if (recovery?.syncRoles) return { rolesSynced, revision: refreshed.revision };
      try {
        signal?.throwIfAborted();
        await ensureCurrentProfile(refreshed);
        const roles = await list(refreshed, undefined, signal);
        signal?.throwIfAborted();
        await saveRoles(refreshed, roles);
        return { rolesSynced: true };
      } catch {
        return { rolesSynced: false, revision: refreshed.revision };
      }
    },
    async syncRoles(context: ProfileAccountContext, allowRefresh = true) {
      if (!allowRefresh) return saveRoles(context, await list(context));
      const result = await retrieve(context, (profile) => list(profile));
      return saveRoles(result.context, result.data);
    },
    async listRoles(context: ProfileAccountContext, game: Game, signal?: AbortSignal): Promise<GameRole[]> {
      return rolesFor((await retrieve(context, (profile) => list(profile, game, signal), signal)).data, game);
    },
    async fetchBoundRoles(context: ProfileAccountContext, game: Game, signal?: AbortSignal) {
      const result = await retrieve(context, async (profile) => {
        signal?.throwIfAborted();
        await ensureCurrentProfile(profile);
        const data = await list(profile, game, signal);
        await ensureCurrentProfile(profile);
        signal?.throwIfAborted();
        return data;
      }, signal);
      return { context: result.context, roles: rolesFor(result.data, game) };
    },
    async fetchRoleCatalog(context: ProfileAccountContext, signal?: AbortSignal) {
      return checkinRoleCatalog(await list(context, undefined, signal));
    },
    async fetchCheckinRoles(context: ProfileAccountContext, game: CnGameCheckinSource["game"], signal?: AbortSignal) {
      return checkinRoleCatalog(await list(context, game, signal))[game];
    },
    async fetchDailyNotes(sources: readonly ProfileRequestContext[], options: DailyNoteOptions & {
      readonly verifyReadOnly?: () => Promise<void>;
      readonly onCredentialRefresh?: (profile: ProfileAccountContext) => void;
      readonly includeStarRailCheckin?: boolean;
    } = {}) {
      const first = sources[0];
      const results: PromiseSettledResult<DailyNoteSnapshot>[] = [];
      if (!first) return results;
      if (sources.some(({ qq, profileId, revision }) => qq !== first.qq || profileId !== first.profileId || revision !== first.revision)) {
        throw new HoyoRequestError("invalid-input", "体力查询的角色来自不同档案快照。");
      }
      let current: ProfileAccountContext = first;
      const verify = options.verifyReadOnly ?? (() => ensureCurrentProfile(current));
      const initialRevision = first.revision;
      const games = [...new Set(sources.map(({ game }) => game))];
      const roleKey = ({ game, role }: ProfileRequestContext) => `${game}:${role.uid}`;
      const removedRole = () => new HoyoRequestError("invalid-input", "该角色已不在续期后的档案中，请重新查询。");
      let refreshedRoles: Map<string, ProfileRequestContext> | undefined;
      let refreshAttempted = false;
      function canRefresh(error: unknown) {
        if (refreshAttempted || !isDailyNoteCookieExpired(error)) return false;
        refreshAttempted = true;
        return true;
      }
      function onAttempt(attempt: ProfileAccountContext) {
        if (attempt.revision !== current.revision) options.onCredentialRefresh?.(attempt);
        current = attempt;
      }
      function retainedRole(source: ProfileRequestContext, region = source.role.region) {
        const target = refreshedRoles?.get(roleKey(source));
        return target && (!source.role.gameBiz || source.role.gameBiz === target.role.gameBiz) &&
          (isUnspecifiedCnRecordRegion(region) || region.trim() === target.role.region.trim())
          ? target : undefined;
      }
      async function retainedSource(candidate: ProfileRequestContext, original: ProfileRequestContext) {
        const profiles = recovery?.profiles;
        if (candidate.revision === initialRevision || !profiles?.requestContexts) return candidate;
        if (!refreshedRoles) {
          const changed = new HoyoRequestError("profile-changed", "换票后的档案角色无法确认，请重新发起请求。");
          const bound = await profiles.requestContexts(candidate.qq, candidate.profileId, games).catch(() => { throw changed; });
          if (bound.some(source => source.revision !== candidate.revision)) throw changed;
          await verify();
          refreshedRoles = new Map(bound.map(source => [roleKey(source), source]));
        }
        const target = retainedRole(original);
        if (!target) throw removedRole();
        return target;
      }
      function readWithCurrentRole<Data extends object>(source: ProfileRequestContext,
        reader: (source: ProfileRequestContext, transport: HoyoTransport, options: DailyNoteOptions,
          guard?: () => Promise<void>) => Promise<Data>) {
        return readForProfile({ ...current, game: source.game, role: source.role }, options, async (candidate, request, opts, guard) =>
          reader(await retainedSource(candidate, source), request, opts, guard), canRefresh, onAttempt);
      }
      for (const source of sources) {
        const { game, role } = source;
        options.signal?.throwIfAborted();
        try {
          verifyCookieIdentity(source);
          const note = options.verifyReadOnly ? await readDailyNote(source, transport, options, verify)
            : await readWithCurrentRole(source, readDailyNote);
          let starRailCheckin: DailyNoteSnapshot["starRailCheckin"];
          if (game === "sr" && options.includeStarRailCheckin) {
            try {
              const signRole = { ...role, region: note.region };
              const status = options.verifyReadOnly ? await readCnGameCheckinInfo({ ...source, role: signRole }, transport, options, verify)
                : await readWithCurrentRole(source, (candidate, request, opts, guard) => {
                  if (!isUnspecifiedCnRecordRegion(candidate.role.region) && candidate.role.region.trim() !== note.region) throw removedRole();
                  return readCnGameCheckinInfo({ ...candidate, role: { ...candidate.role, region: note.region } }, request, opts, guard);
                });
              starRailCheckin = status.signed ? "signed" : "unsigned";
            } catch {
              options.signal?.throwIfAborted();
              await verify();
              starRailCheckin = "unavailable";
            }
          }
          results.push({ status: "fulfilled", value: { ...note, ...(starRailCheckin && { starRailCheckin }) } });
        } catch (reason) {
          options.signal?.throwIfAborted();
          await verify();
          results.push({ status: "rejected", reason: options.verifyReadOnly && isDailyNoteCookieExpired(reason)
            ? new HoyoRequestError("refresh", "旧 Cookie 已失效，无法自动续期，请扫码登录。") : reason });
        }
      }
      await verify();
      return refreshedRoles ? results.map<PromiseSettledResult<DailyNoteSnapshot>>((result, index) =>
        result.status === "fulfilled" && !retainedRole(sources[index]!, result.value.region)
          ? { status: "rejected", reason: removedRole() }
          : result) : results;
    },
    fetchHoYoLabZzzDailyNote(source: Parameters<typeof readHoYoLabZzzDailyNote>[0],
      options: Parameters<typeof readHoYoLabZzzDailyNote>[2]) {
      return readHoYoLabZzzDailyNote(source, transport, options);
    },
    fetchGenshinGacha(source: ProfileRequestContext, options: GenshinGachaOptions = {}) {
      return readForGenshinGacha(source, options, readGenshinGacha);
    },
    fetchGenshinWorldBoss(source: ProfileRequestContext, options: { readonly signal?: AbortSignal } = {}) {
      return readForProfile(source, options, readGenshinWorldBoss, isGameRecordCookieExpired);
    },
    fetchGenshinBackpack(source: ProfileRequestContext, options: GenshinBackpackOptions) {
      return readForProfile(source, options, readGenshinBackpack, isGameRecordCookieExpired);
    },
    fetchGenshinGrowth(source: ProfileRequestContext, options: GenshinGrowthOptions) {
      return readForProfile(source, options, readGenshinGrowth, isGameRecordCookieExpired);
    },
    fetchGenshinBlueprint(source: ProfileRequestContext, options: GenshinBlueprintOptions) {
      return readForProfile(source, options, createGenshinBlueprintReader(), isGameRecordCookieExpired);
    },
    fetchCnGameCheckinInfo(source: CnGameCheckinSource,
      options: { readonly signal?: AbortSignal; readonly recoverCookie?: boolean } = {}) {
      return readForProfile(source, options, readCnGameCheckinInfo,
        options.recoverCookie === false ? () => false : isGameRecordCookieExpired);
    },
    async submitCnGameCheckin(source: CnGameCheckinSource, options: Parameters<typeof submitCnGameCheckin>[2] = {}) {
      verifyCookieIdentity(source);
      return submitCnGameCheckin(source, transport, options, () => ensureCurrentProfile(source));
    },
    async fetchBbsMissionState(source: ProfileAccountContext,
      options: { readonly signal?: AbortSignal; readonly recoverCookie?: boolean;
        readonly onCredentialRefresh?: (profile: ProfileAccountContext) => void } = {}) {
      const { context, data } = await retrieve(source,
        (profile) => {
          if (profile.revision !== source.revision) options.onCredentialRefresh?.(profile);
          return readBbsMissionState(profile, transport, options, () => ensureCurrentProfile(profile));
        },
        options.signal,
        (error) => options.recoverCookie !== false && error instanceof BbsCheckinRequestError && error.reason === "cookie-expired");
      return { ...data, revision: context.revision, refreshedCookie: context.revision !== source.revision };
    },
    submitBbsCheckin(source: ProfileAccountContext, forum: BbsCheckinForum,
      options: Parameters<typeof submitBbsCheckin>[3] = {}) {
      return submitBbsCheckin(source, transport, forum, options, () => ensureCurrentProfile(source));
    },
    openHoYoLabGenshinCheckin(source: HoYoLabGenshinCheckinSource, options: Parameters<typeof openHoYoLabGenshinCheckin>[2]) {
      return openHoYoLabGenshinCheckin(source, transport, options);
    },
    openHoYoLabBh3Checkin(source: HoYoLabGenshinCheckinSource, options: Parameters<typeof openHoYoLabBh3Checkin>[2]) {
      return openHoYoLabBh3Checkin(source, transport, options);
    },
    openHoYoLabStarRailCheckin(source: HoYoLabGenshinCheckinSource, options: Parameters<typeof openHoYoLabStarRailCheckin>[2]) {
      return openHoYoLabStarRailCheckin(source, transport, options);
    },
    openHoYoLabZzzCheckin(source: HoYoLabGenshinCheckinSource, options: Parameters<typeof openHoYoLabZzzCheckin>[2]) {
      return openHoYoLabZzzCheckin(source, transport, options);
    },
    openHoYoLabNxxCheckin(source: HoYoLabGenshinCheckinSource, options: Parameters<typeof openHoYoLabNxxCheckin>[2]) {
      return openHoYoLabNxxCheckin(source, transport, options);
    },
    readCloudGenshinWallet(token: string, options: Parameters<typeof readCloudGenshinWallet>[2]) {
      return readCloudGenshinWallet(token, transport, options);
    },
    readInternationalCloudGenshinWallet(token: string, options: Parameters<typeof readInternationalCloudGenshinWallet>[2]) {
      return readInternationalCloudGenshinWallet(token, transport, options);
    },
    readCloudZzzWallet(token: string, options: Parameters<typeof readCloudZzzWallet>[2]) {
      return readCloudZzzWallet(token, transport, options);
    },
    fetchGenshinMiniapp(source: ProfileRequestContext, options: GenshinMiniappOptions = {}) {
      return readForGenshinGacha(source, options, readGenshinMiniapp);
    },
    fetchGenshinMonthly(source: ProfileRequestContext, options: GenshinMonthlyOptions) {
      return readForProfile(source, options, readGenshinMonthly, isGameRecordCookieExpired);
    },
    fetchGenshinPanel(source: ProfileRequestContext, options: GenshinPanelOptions = {}) {
      return readForProfile(source, options, readGenshinPanel, isGameRecordCookieExpired);
    },
    fetchGenshinCharacterList(source: ProfileRequestContext, options: GenshinPanelOptions = {}) {
      return readForProfile(source, options, readGenshinCharacterList, isGenshinPersonalRecordCookieExpired);
    },
    fetchGenshinTalents(source: ProfileRequestContext, options: GenshinPanelOptions & { readonly characterIds: readonly number[] }) {
      return readForProfile(source, options, readGenshinTalents, isGenshinPersonalRecordCookieExpired);
    },
    fetchGenshinDecks(source: ProfileRequestContext, options: { readonly signal?: AbortSignal } = {}) {
      return readForProfile(source, options, readGenshinDecks, isGenshinPersonalRecordCookieExpired);
    },
    fetchGenshinGcgCollection(source: ProfileRequestContext, options: {
      readonly scope: GenshinGcgCollectionScope;
      readonly signal?: AbortSignal;
    }) {
      return readForProfile(source, options, readGenshinGcgCollection, isGenshinPersonalRecordCookieExpired);
    },
    fetchGenshinPersonalRecord(source: ProfileRequestContext, { includeRoster, includeExploration, ...options }: GenshinPanelOptions & {
      readonly includeRoster: boolean;
      readonly includeExploration?: boolean;
    }) {
      return readForProfile(source, options, createGenshinPersonalRecordReader(includeRoster, includeExploration), isGenshinPersonalRecordCookieExpired);
    },
    fetchGenshinChallenge(source: ProfileRequestContext, options: GenshinChallengeOptions) {
      return readForProfile(source, options, createGenshinChallengeReader(), isGenshinPersonalRecordCookieExpired);
    },
    fetchGenshinHardChallenge(source: ProfileRequestContext, options: GenshinHardChallengeOptions) {
      return readForProfile(source, options, readGenshinHardChallenge, isGameRecordCookieExpired);
    },
    fetchGenshinTarotCollection(source: ProfileRequestContext, options: GenshinPanelOptions = {}) {
      return readForProfile(source, options, readGenshinTarotCollection, isGenshinPersonalRecordCookieExpired);
    },
    fetchStarRailGrowth(source: ProfileRequestContext, options: StarRailGrowthOptions) {
      return readForProfile(source, options, readStarRailGrowth, isGameRecordCookieExpired);
    },
    fetchStarRailGridFight(source: ProfileRequestContext, options: StarRailGridFightOptions = {}) {
      return readForProfile(source, options, readStarRailGridFight, isGameRecordCookieExpired);
    },
    fetchStarRailRogue(source: ProfileRequestContext, options: StarRailRogueOptions) {
      return readForProfile(source, options, readStarRailRogue, isGameRecordCookieExpired);
    },
    fetchStarRailChallenge(source: ProfileRequestContext, options: StarRailChallengeOptions) {
      return readForProfile(source, options, async (current, request, attempt, guard) => {
        const profiles = recovery?.profiles;
        if (current.revision === source.revision || !profiles?.requestSelectedContext) {
          return readStarRailChallenge(current, request, attempt, guard);
        }
        const changed = new HoyoRequestError("profile-changed", "续期后星铁档案角色已变更，请重新查询。");
        const selected = await profiles.requestSelectedContext(current.qq, current.profileId, "sr").catch(() => { throw changed; });
        if (selected.revision !== current.revision || selected.role.uid !== source.role.uid ||
            starRailChallengeRegion(selected.role) !== starRailChallengeRegion(source.role)) throw changed;
        return readStarRailChallenge(selected, request, attempt, guard);
      }, isGameRecordCookieExpired);
    },
    fetchStarRailLedger(source: ProfileRequestContext, options: StarRailLedgerOptions) {
      // This service mints a ticket with the SToken. Exchanging a Cookie cannot replace it.
      return readForProfile(source, options, readStarRailLedger, () => false);
    },
    fetchStarRailOnline(source: ProfileRequestContext, options: StarRailOnlineOptions = {}) {
      return readForProfile(source, options, readStarRailOnline, () => false);
    },
    fetchStarRailMonthly(source: ProfileRequestContext, options: StarRailMonthlyOptions = {}) {
      return readForProfile(source, options, readStarRailMonthly, isGameRecordCookieExpired);
    },
    fetchStarRailPersonalRecord(source: ProfileRequestContext, options: { readonly signal?: AbortSignal } = {}) {
      return readForProfile(source, options, readStarRailPersonalRecord, isGameRecordCookieExpired);
    },
    fetchStarRailPersonalRoster(source: ProfileRequestContext, options: StarRailRosterOptions) {
      return readForProfile(source, options, readStarRailPersonalRoster, isGameRecordCookieExpired);
    },
    fetchStarRailPanel(source: ProfileRequestContext, options: StarRailPanelOptions = {}) {
      return readForProfile(source, options, readStarRailPanel, isGameRecordCookieExpired);
    },
    fetchStarRailGacha(source: ProfileRequestContext, options: StarRailGachaOptions = {}) {
      return readForProfile(source, options, readStarRailGacha, error =>
        error instanceof GameRecordRequestError ? isGameRecordCookieExpired(error) : isCookieExpired(error));
    },
    fetchZzzTuning(source: ProfileRequestContext, options: ZzzTuningOptions = {}) {
      return readForZzzTuning(source, options, readZzzTuning);
    },
    fetchZzzGachaAuthKey(source: ProfileRequestContext, options: { readonly signal?: AbortSignal } = {}) {
      return readForProfile(source, options, async (current, request, sameOptions, guard) => {
        const profiles = recovery?.profiles;
        if (current.revision === source.revision || !profiles?.requestSelectedContext) {
          return readZzzGachaAuthKey(current, request, sameOptions, guard);
        }
        const changed = new HoyoRequestError("profile-changed", "续期后绝区零档案的角色已变更，请重新获取抽卡链接。");
        const selected = await profiles.requestSelectedContext(current.qq, current.profileId, "zzz").catch(() => { throw changed; });
        const before = resolveZzzGachaLinkRole(source.role);
        const after = resolveZzzGachaLinkRole(selected.role);
        if (selected.revision !== current.revision || after.uid !== before.uid ||
            after.region !== before.region || after.gameBiz !== before.gameBiz) throw changed;
        return readZzzGachaAuthKey(selected, request, sameOptions, guard);
      }, isZzzGachaAuthExpired);
    },
    fetchZzzGameRecord(source: ProfileRequestContext, options: { readonly signal?: AbortSignal } = {}) {
      return readForProfile(source, options, readZzzGameRecord, isGameRecordCookieExpired);
    },
    fetchZzzOwnedBuddyRoster(source: ProfileRequestContext, options: { readonly signal?: AbortSignal } = {}) {
      return readForProfile(source, options, readZzzOwnedBuddyRoster, isGameRecordCookieExpired);
    },
    fetchHoYoLabZzzGameRecord(source: Parameters<typeof readHoYoLabZzzGameRecord>[0],
      options: Parameters<typeof readHoYoLabZzzGameRecord>[2]) {
      return readHoYoLabZzzGameRecord(source, transport, options);
    },
    fetchZzzShiyu(source: ProfileRequestContext, options: Parameters<typeof readZzzShiyu>[2]) {
      return readForProfile(source, options, readZzzShiyu, isGameRecordCookieExpired);
    },
    fetchZzzDeadly(source: ProfileRequestContext, options: Parameters<typeof readZzzDeadly>[2]) {
      return readForProfile(source, options, readZzzDeadly, isGameRecordCookieExpired);
    },
    async fetchZzzChallengeStatus(source: ProfileRequestContext, { signal, skipShiyu, skipDeadly }: {
      readonly signal?: AbortSignal; readonly skipShiyu?: boolean; readonly skipDeadly?: boolean;
    } = {}) {
      let current: ProfileAccountContext = source;
      let refreshAttempted = false;
      const options = { scheduleType: 1 as const, signal };
      function mayRefresh(error: unknown) {
        if (refreshAttempted || !isGameRecordCookieExpired(error)) return false;
        refreshAttempted = true;
        return true;
      }
      async function read<Data extends object>(reader: (source: ProfileRequestContext, transport: HoyoTransport, request: { scheduleType: 1; signal?: AbortSignal }, verify?: () => Promise<void>) => Promise<Data>)
        : Promise<PromiseSettledResult<Data>> {
        signal?.throwIfAborted();
        try {
          const value = await readForProfile({ ...source, ...current }, options, reader, mayRefresh, attempt => { current = attempt; });
          return { status: "fulfilled", value };
        } catch (reason) {
          signal?.throwIfAborted();
          await ensureCurrentProfile(current);
          return { status: "rejected", reason };
        }
      }
      const shiyu = skipShiyu ? { status: "skipped" as const } : await read(readZzzShiyu);
      const deadly = skipDeadly ? { status: "skipped" as const } : await read(readZzzDeadly);
      await ensureCurrentProfile(current);
      return { shiyu, deadly, revision: current.revision };
    },
    fetchZzzHoloBoss(source: ProfileRequestContext, options: Parameters<typeof readZzzHoloBoss>[2]) {
      return readForProfile(source, options, readZzzHoloBoss, isGameRecordCookieExpired);
    },
    fetchZzzVoidFront(source: ProfileRequestContext, options: Parameters<typeof readZzzVoidFront>[2]) {
      return readForProfile(source, options, readZzzVoidFront, isGameRecordCookieExpired);
    },
    fetchZzzClimbingTower(source: ProfileRequestContext, options: Parameters<typeof readZzzClimbingTower>[2]) {
      return readForProfile(source, options, readZzzClimbingTower, isGameRecordCookieExpired);
    },
    fetchZzzHollowZero(source: ProfileRequestContext, options: Parameters<typeof readZzzHollowZero>[2]) {
      return readForProfile(source, options, readZzzHollowZero, isGameRecordCookieExpired);
    },
    fetchZzzZenkov(source: ProfileRequestContext, options: Parameters<typeof readZzzZenkov>[2]) {
      return readForProfile(source, options, readZzzZenkov, isGameRecordCookieExpired);
    },
    fetchZzzExploration(source: ProfileRequestContext, options: Parameters<typeof readZzzExploration>[2]) {
      return readForProfile(source, options, readZzzExploration, isGameRecordCookieExpired);
    },
    fetchZzzMonthly(source: ProfileRequestContext, options: Parameters<typeof readZzzMonthly>[2]) {
      return readForProfile(source, options, readZzzMonthly, isGameRecordCookieExpired);
    },
    openHoYoLabZzzMonthly(source: Parameters<typeof openHoYoLabZzzMonthly>[0], options: Parameters<typeof openHoYoLabZzzMonthly>[2]) {
      return openHoYoLabZzzMonthly(source, transport, options);
    },
    fetchZzzPanel(source: ProfileRequestContext, options: ZzzPanelOptions = {}) {
      return readForProfile(source, options, readZzzPanel, isGameRecordCookieExpired);
    },
    fetchZzzTuningInventory(source: ProfileRequestContext, options: ZzzTuningOptions = {}) {
      return readForZzzTuning(source, options, readZzzTuningInventory);
    },
  };

}

export function createProfileHoyoClient(
  profiles = createProfileStore(),
  transport: HoyoTransport = fetch,
) {
  return createHoyoClient(transport, { profiles, exchange: createCredentialExchange(transport),
    scope: profiles.credentialRefreshScope, syncRoles: true });
}
