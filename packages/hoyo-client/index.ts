import { readGenshinMonthly, type GenshinMonthlyOptions } from "./genshin-monthly.ts";
import { hasConflictingProfileCookieIdentity, normalizeGameRoles, profileGames, type Game, type GameRole, type ProfileAccountContext, type ProfileRequestContext, type RefreshedCredentials, createProfileStore } from "@lotus-yunzai/account";
import { BbsCheckinRequestError, readBbsMissionState, submitBbsCheckin, type BbsCheckinForum } from "./bbs-checkin.ts";
import { readCloudGenshinWallet, readInternationalCloudGenshinWallet } from "./cloud-genshin-wallet.ts";
import { readCloudZzzWallet } from "./cloud-zzz-wallet.ts";
import { createCredentialExchange, type HoyoTransport } from "./credentials.ts";
import { isDailyNoteCookieExpired, readDailyNote, type DailyNoteOptions, type DailyNoteSnapshot } from "./daily-note.ts";
import { HoyoRequestError } from "./errors.ts";
import { openHoYoLabBh3Checkin } from "./hoyolab-bh3-checkin.ts";
import { openHoYoLabGenshinCheckin, type HoYoLabGenshinCheckinSource } from "./hoyolab-genshin-checkin.ts";
import { openHoYoLabNxxCheckin } from "./hoyolab-nxx-checkin.ts";
import { openHoYoLabStarRailCheckin } from "./hoyolab-starrail-checkin.ts";
import { openHoYoLabZzzCheckin } from "./hoyolab-zzz-checkin.ts";
import { isBh3CnCheckinRegion, readCnGameCheckinInfo, submitCnGameCheckin, type CnGameCheckinSource } from "./game-checkin.ts";
import { GameRecordRequestError, isGameRecordCookieExpired } from "./game-record.ts";
import { MiyousheExchangeError, readMiyousheShopAddresses, readMiyousheShopBalance, submitMiyousheShopExchange,
  type MiyousheShopOrder, type ShopManualVerification } from "./miyoushe-exchange.ts";
import { readGenshinBackpack, readGenshinGrowth, type GenshinBackpackOptions, type GenshinGrowthOptions } from "./genshin-backpack.ts";
import { createGenshinBlueprintReader, type GenshinBlueprintOptions } from "./genshin-blueprint.ts";
import { GenshinAuthKeyRequestError, readGenshinGacha, type GenshinGachaOptions } from "./genshin-gacha.ts";
import { readGenshinDecks, readGenshinGcgCollection, type GenshinGcgCollectionScope } from "./genshin-gcg.ts";
import { readGenshinWorldBoss } from "./genshin-world-boss.ts";
import { readGenshinMiniapp, type GenshinMiniappOptions } from "./genshin-miniapp.ts";
import { createGenshinChallengeReader, createGenshinPersonalRecordReader, readGenshinCharacterList, readGenshinPanel, readGenshinTalents, type GenshinChallengeOptions, type GenshinPanelOptions } from "./genshin-panel.ts";
import { readStarRailGridFight, type StarRailGridFightOptions } from "./starrail-grid-fight.ts";
import { readStarRailChallenge, type StarRailChallengeOptions } from "./starrail-challenge.ts";
import { readStarRailPanel, type StarRailPanelOptions } from "./starrail-panel.ts";
import { readStarRailPersonalRoster, type StarRailRosterOptions } from "./starrail-roster.ts";
import { readStarRailMonthly, type StarRailMonthlyOptions } from "./starrail-monthly.ts";
import { readStarRailLedger, readStarRailOnline, type StarRailLedgerOptions, type StarRailOnlineOptions } from "./starrail-ledger.ts";
import { readStarRailGacha, type StarRailGachaOptions } from "./starrail-gacha.ts";
import { isZzzGachaAuthExpired, readZzzGachaAuthKey } from "./zzz-gacha-auth.ts";
import { readZzzDeadly } from "./zzz-deadly.ts";
import { readZzzGameRecord } from "./zzz-game-record.ts";
import { readZzzHoloBoss } from "./zzz-holo-boss.ts";
import { readZzzMonthly } from "./zzz-monthly.ts";
import { readZzzExploration } from "./zzz-exploration.ts";
import { readZzzZenkov } from "./zzz-zenkov.ts";
import { readZzzHollowZero } from "./zzz-hollow-zero.ts";
import { readZzzClimbingTower } from "./zzz-climbing-tower.ts";
import { readZzzVoidFront } from "./zzz-void-front.ts";
import { readZzzPanel, type ZzzPanelOptions } from "./zzz-panel.ts";
import { readZzzShiyu } from "./zzz-shiyu.ts";
import { isZzzTuningCookieExpired, readZzzTuning, readZzzTuningInventory, type ZzzTuningOptions } from "./zzz-tuning.ts";

export { readGenshinTeamDamage, type TeamDamagePayload, type TeamDamageRole, type TeamDamageArtifact } from "./genshin-team-damage.ts";
export { createCredentialExchange };
export { CloudGenshinWalletError, normalizeCloudGenshinComboToken, readCloudGenshinWallet } from "./cloud-genshin-wallet.ts";
export { CloudZzzWalletError, normalizeCloudZzzComboToken, readCloudZzzWallet } from "./cloud-zzz-wallet.ts";
export { HoyoRequestError };
export { verifyHoYoLabCookie, type HoYoLabPassportRealm } from "./hoyolab-cookie.ts";
export { BbsCheckinRequestError, bbsCheckinForums, type BbsCheckinForum, type BbsMissionState } from "./bbs-checkin.ts";
export { readBbsForumPosts, type BbsForumPost } from "./bbs-forum-posts.ts";
export { normalizeGenshinMonthly, type GenshinMonthlySnapshot } from "./genshin-monthly.ts";
export { GameRecordRequestError } from "./game-record.ts";
export type { ZzzGameRecordItem, ZzzGameRecordSnapshot } from "./zzz-game-record.ts";
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
export type { StarRailMonthlySnapshot, StarRailMonthlyOptions } from "./starrail-monthly.ts";
export type { StarRailChallengeKind, StarRailChallengeOptions, StarRailChallengePeriod } from "./starrail-challenge.ts";
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
  readonly profiles: Pick<ReturnType<typeof createProfileStore>, "accountContext" | "saveRefreshedCredentials" | "saveRoles">;
  readonly exchange: (profile: ProfileAccountContext, options?: { readonly verifyProfile?: () => Promise<void> }) => Promise<RefreshedCredentials>;
}

interface CookieRevision {
  requests: number;
  refreshing: boolean;
  refreshed?: Promise<ProfileAccountContext>;
}

export function createHoyoClient(
  transport: HoyoTransport = fetch,
  recovery?: CookieRecovery,
) {
  const revisions = new Map<string, CookieRevision>();

  function keyFor({ qq, profileId, revision }: ProfileAccountContext): string {
    return JSON.stringify([qq, profileId, revision]);
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

  function recover(context: ProfileAccountContext): Promise<ProfileAccountContext> {
    if (!recovery) throw new HoyoRequestError("refresh", "未配置登录凭据刷新服务。");

    const key = keyFor(context);
    const entry = track(key);
    if (entry.refreshed) return entry.refreshed;

    entry.refreshing = true;
    const operation = (async () => {
      const latest = await recovery.profiles.accountContext(context.qq, context.profileId);
      if (latest.revision !== context.revision) {
        throw new HoyoRequestError("refresh", "档案已变更，请重新发起请求。");
      }
      const credentials = await recovery.exchange(latest, { verifyProfile: () => ensureCurrentProfile(latest) });
      return recovery.profiles.saveRefreshedCredentials(latest.qq, latest.profileId, latest.revision, credentials);
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

  async function list(context: ProfileAccountContext, game?: keyof typeof checkinGameBiz, signal?: AbortSignal): Promise<unknown[]> {
    if (game !== undefined && !Object.hasOwn(checkinGameBiz, game)) {
      throw new HoyoRequestError("invalid-input", "游戏类型无效。");
    }
    verifyCookieIdentity(context);
    const cookie = context.account.cookie;
    if (!cookie.trim() || /[\r\n\0]/u.test(cookie)) {
      throw new HoyoRequestError("invalid-input", "档案 Cookie 无效。");
    }

    const endpoint = new URL("https://api-takumi.mihoyo.com/binding/api/getUserGameRolesByCookie");
    if (game !== undefined) endpoint.searchParams.set("game_biz", checkinGameBiz[game]);
    const deadline = AbortSignal.timeout(15_000);

    let response: Response;
    try {
      signal?.throwIfAborted();
      await ensureCurrentProfile(context);
      signal?.throwIfAborted();
      response = await transport(endpoint, {
        headers: { Cookie: cookie, Accept: "application/json" },
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      });
    } catch (error) {
      if (error instanceof HoyoRequestError && error.code === "profile-changed") throw error;
      throw new HoyoRequestError("transport", "米游社角色请求未完成。");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new HoyoRequestError("http", "米游社返回 HTTP 错误。", response.status);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new HoyoRequestError("response", "米游社返回了无效的 JSON。");
    }
    if (!isRecord(payload) || typeof payload.retcode !== "number" || !Number.isSafeInteger(payload.retcode)) {
      throw new HoyoRequestError("response", "米游社角色响应格式有误。");
    }
    if (payload.retcode !== 0) {
      throw new HoyoRequestError("api", "米游社角色查询失败。", response.status, payload.retcode);
    }
    if (!isRecord(payload.data) || !Array.isArray(payload.data.list)) {
      throw new HoyoRequestError("response", "米游社角色列表格式有误。");
    }

    await ensureCurrentProfile(context);
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
    const key = keyFor(context);
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
        const saved = await recover(context);
        refreshed = await recovery.profiles.accountContext(context.qq, context.profileId);
        if (refreshed.revision !== saved.revision) throw new Error("档案在刷新后已变更。");
      } catch {
        throw new HoyoRequestError("refresh", "无法刷新当前档案的 Cookie，请确认登录状态后重试。");
      }
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
    refreshCredentials: recover,
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
    async refreshProfile(context: ProfileAccountContext, signal?: AbortSignal) {
      signal?.throwIfAborted();
      const refreshed = await recover(context);
      try {
        signal?.throwIfAborted();
        await ensureCurrentProfile(refreshed);
        const roles = await list(refreshed, undefined, signal);
        signal?.throwIfAborted();
        await saveRoles(refreshed, roles);
        return { rolesSynced: true };
      } catch {
        return { rolesSynced: false };
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
    } = {}) {
      const first = sources[0];
      const results: PromiseSettledResult<DailyNoteSnapshot>[] = [];
      if (!first) return results;
      if (sources.some(({ qq, profileId, revision }) => qq !== first.qq || profileId !== first.profileId || revision !== first.revision)) {
        throw new HoyoRequestError("invalid-input", "体力查询的角色来自不同档案快照。");
      }
      let current: ProfileAccountContext = first;
      const verify = options.verifyReadOnly ?? (() => ensureCurrentProfile(current));
      let refreshAttempted = false;
      function canRefresh(error: unknown) {
        if (refreshAttempted || !isDailyNoteCookieExpired(error)) return false;
        refreshAttempted = true;
        return true;
      }
      for (const source of sources) {
        const { game, role } = source;
        options.signal?.throwIfAborted();
        try {
          verifyCookieIdentity(source);
          const value = options.verifyReadOnly ? await readDailyNote(source, transport, options, verify)
            : await readForProfile({ ...current, game, role }, options, readDailyNote,
            canRefresh, (attempt) => { current = attempt; });
          results.push({ status: "fulfilled", value });
        } catch (reason) {
          options.signal?.throwIfAborted();
          await verify();
          results.push({ status: "rejected", reason: options.verifyReadOnly && isDailyNoteCookieExpired(reason)
            ? new HoyoRequestError("refresh", "旧 Cookie 已失效，无法自动续期，请扫码登录。") : reason });
        }
      }
      await verify();
      return results;
    },
    fetchGenshinGacha(source: ProfileRequestContext, options: GenshinGachaOptions = {}) {
      return readForProfile(source, options, readGenshinGacha, isGenshinAuthExpired);
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
      return readForProfile(source, options, readGenshinMiniapp, isGenshinAuthExpired);
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
    fetchStarRailGridFight(source: ProfileRequestContext, options: StarRailGridFightOptions = {}) {
      return readForProfile(source, options, readStarRailGridFight, isGameRecordCookieExpired);
    },
    fetchStarRailChallenge(source: ProfileRequestContext, options: StarRailChallengeOptions) {
      return readForProfile(source, options, readStarRailChallenge, isGameRecordCookieExpired);
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
    fetchStarRailPersonalRoster(source: ProfileRequestContext, options: StarRailRosterOptions) {
      return readForProfile(source, options, readStarRailPersonalRoster, isGameRecordCookieExpired);
    },
    fetchStarRailPanel(source: ProfileRequestContext, options: StarRailPanelOptions = {}) {
      return readForProfile(source, options, readStarRailPanel, isGameRecordCookieExpired);
    },
    fetchStarRailGacha(source: ProfileRequestContext, options: StarRailGachaOptions = {}) {
      return readForProfile(source, options, readStarRailGacha);
    },
    fetchZzzTuning(source: ProfileRequestContext, options: ZzzTuningOptions = {}) {
      return readForProfile(source, options, readZzzTuning, isZzzTuningCookieExpired);
    },
    fetchZzzGachaAuthKey(source: ProfileRequestContext, options: { readonly signal?: AbortSignal } = {}) {
      return readForProfile(source, options, readZzzGachaAuthKey, isZzzGachaAuthExpired);
    },
    fetchZzzGameRecord(source: ProfileRequestContext, options: { readonly signal?: AbortSignal } = {}) {
      return readForProfile(source, options, readZzzGameRecord, isGameRecordCookieExpired);
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
    fetchZzzPanel(source: ProfileRequestContext, options: ZzzPanelOptions = {}) {
      return readForProfile(source, options, readZzzPanel, isGameRecordCookieExpired);
    },
    fetchZzzTuningInventory(source: ProfileRequestContext, options: ZzzTuningOptions = {}) {
      return readForProfile(source, options, readZzzTuningInventory, isZzzTuningCookieExpired);
    },
  };

}

export function createProfileHoyoClient(
  profiles = createProfileStore(),
  transport: HoyoTransport = fetch,
) {
  return createHoyoClient(transport, { profiles, exchange: createCredentialExchange(transport) });
}
