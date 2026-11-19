import { normalizeGameRoles, profileGames, type Game, type GameRole, type ProfileAccountContext, type ProfileRequestContext, type RefreshedCredentials, createProfileStore } from "@lotus-yunzai/account";
import { createCredentialExchange, type HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { GenshinAuthKeyRequestError, readGenshinGacha, type GenshinGachaOptions } from "./genshin-gacha.ts";
import { readStarRailGacha, type StarRailGachaOptions } from "./starrail-gacha.ts";
import { isZzzTuningCookieExpired, readZzzTuning, readZzzTuningInventory, type ZzzTuningOptions } from "./zzz-tuning.ts";

export { createCredentialExchange };
export { HoyoRequestError };
export { genshinGachaPools, type GenshinGachaOptions, type GenshinGachaPool, type GenshinGachaRow } from "./genshin-gacha.ts";
export { starRailGachaPools, type StarRailGachaOptions, type StarRailGachaPool } from "./starrail-gacha.ts";
export { resolveZzzTuningRegion, zzzTuningPools, ZzzTuningRateLimitError, type ZzzTuningOptions, type ZzzTuningSnapshot } from "./zzz-tuning.ts";
export type GenshinGachaSnapshot = Awaited<ReturnType<typeof readGenshinGacha>>;

const gameBiz: Record<Game, string> = {
  gs: "hk4e_cn",
  sr: "hkrpg_cn",
  zzz: "nap_cn",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const expired = new Set([-100, 10001, 10101, 10102, 10103]);

function isCookieExpired(error: unknown): boolean {
  return error instanceof HoyoRequestError && error.code === "api" &&
    error.retcode !== undefined && expired.has(error.retcode);
}

interface CookieRecovery {
  readonly profiles: Pick<ReturnType<typeof createProfileStore>, "accountContext" | "saveRefreshedCredentials" | "saveRoles">;
  readonly exchange: (profile: ProfileAccountContext) => Promise<RefreshedCredentials>;
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
      const credentials = await recovery.exchange(latest);
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

  async function list(context: ProfileAccountContext, game?: Game, signal?: AbortSignal): Promise<unknown[]> {
    if (game !== undefined && !Object.hasOwn(gameBiz, game)) {
      throw new HoyoRequestError("invalid-input", "游戏类型无效。");
    }
    const cookie = context.account.cookie;
    if (!cookie.trim() || /[\r\n\0]/u.test(cookie)) {
      throw new HoyoRequestError("invalid-input", "档案 Cookie 无效。");
    }

    const endpoint = new URL("https://api-takumi.mihoyo.com/binding/api/getUserGameRolesByCookie");
    if (game !== undefined) endpoint.searchParams.set("game_biz", gameBiz[game]);
    const deadline = AbortSignal.timeout(15_000);

    let response: Response;
    try {
      signal?.throwIfAborted();
      response = await transport(endpoint, {
        headers: { Cookie: cookie, Accept: "application/json" },
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      });
    } catch {
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

  async function readForProfile<Options extends { readonly signal?: AbortSignal }, Data extends object>(
    source: ProfileRequestContext,
    options: Options,
    reader: (source: ProfileRequestContext, transport: HoyoTransport, options: Options, guard?: () => Promise<void>) => Promise<Data>,
    isExpired?: (error: unknown) => boolean,
  ) {
    const { context, data } = await retrieve(source, async (profile) => {
      const guard = recovery && (async () => {
        const changed = new HoyoRequestError("profile-changed", "游戏档案已变更，请重新发起请求。");
        const latest = await recovery.profiles.accountContext(profile.qq, profile.profileId).catch(() => { throw changed; });
        if (latest.revision !== profile.revision) throw changed;
      });
      return reader({ ...source, ...profile }, transport, options, guard);
    }, options.signal, isExpired);
    return { ...data, revision: context.revision, refreshedCookie: context.revision !== source.revision };
  }

  async function saveRoles(context: ProfileAccountContext, data: readonly unknown[]) {
    if (!recovery) throw new HoyoRequestError("invalid-input", "未配置角色档案存储。");
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
    await recovery.profiles.saveRoles(context.qq, context.profileId, context.revision, roles);
    return roles;
  }

  return {
    refreshCredentials: recover,
    async refreshProfile(context: ProfileAccountContext) {
      const refreshed = await recover(context);
      try {
        await saveRoles(refreshed, await list(refreshed));
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
    fetchGenshinGacha(source: ProfileRequestContext, options: GenshinGachaOptions = {}) {
      return readForProfile(source, options, readGenshinGacha, (error) =>
        error instanceof GenshinAuthKeyRequestError && isCookieExpired(error));
    },
    fetchStarRailGacha(source: ProfileRequestContext, options: StarRailGachaOptions = {}) {
      return readForProfile(source, options, readStarRailGacha);
    },
    fetchZzzTuning(source: ProfileRequestContext, options: ZzzTuningOptions = {}) {
      return readForProfile(source, options, readZzzTuning, isZzzTuningCookieExpired);
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
