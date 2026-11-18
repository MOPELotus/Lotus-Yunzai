import { normalizeGameRoles, type Game, type GameRole, type ProfileAccountContext, type RefreshedCredentials, createProfileStore } from "@lotus-yunzai/account";
import { createCredentialExchange, type HoyoTransport } from "./credentials.ts";

export { createCredentialExchange };

const gameBiz: Record<Game, string> = {
  gs: "hk4e_cn",
  sr: "hkrpg_cn",
  zzz: "nap_cn",
};

export class HoyoRequestError extends Error {
  constructor(
    readonly code: "invalid-input" | "transport" | "http" | "response" | "api" | "refresh",
    message: string,
    readonly status?: number,
    readonly retcode?: number,
  ) {
    super(message);
    this.name = "HoyoRequestError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const expired = new Set([-100, 10001, 10101, 10102, 10103]);

interface CookieRecovery {
  readonly profiles: Pick<ReturnType<typeof createProfileStore>, "accountContext" | "saveRefreshedCredentials">;
  readonly exchange: (profile: ProfileAccountContext) => Promise<RefreshedCredentials>;
}

export function createHoyoClient(
  transport: HoyoTransport = fetch,
  recovery?: CookieRecovery,
) {
  const refreshes = new Map<string, Promise<ProfileAccountContext>>();

  function recover(context: ProfileAccountContext): Promise<ProfileAccountContext> {
    if (!recovery) throw new HoyoRequestError("refresh", "未配置登录凭据刷新服务。");

    const key = JSON.stringify([context.qq, context.profileId, context.revision]);
    const pending = refreshes.get(key);
    if (pending) return pending;

    const operation = (async () => {
      const latest = await recovery.profiles.accountContext(context.qq, context.profileId);
      if (latest.revision !== context.revision) {
        throw new HoyoRequestError("refresh", "档案已变更，请重新发起请求。");
      }
      const credentials = await recovery.exchange(latest);
      return recovery.profiles.saveRefreshedCredentials(latest.qq, latest.profileId, latest.revision, credentials);
    })();
    refreshes.set(key, operation);
    const forget = () => { if (refreshes.get(key) === operation) refreshes.delete(key); };
    void operation.then(forget, forget);
    return operation;
  }

  async function list(context: ProfileAccountContext, game: Game, signal?: AbortSignal): Promise<GameRole[]> {
    if (!Object.hasOwn(gameBiz, game)) {
      throw new HoyoRequestError("invalid-input", "游戏类型无效。");
    }
    const cookie = context.account.cookie;
    if (!cookie.trim() || /[\r\n\0]/u.test(cookie)) {
      throw new HoyoRequestError("invalid-input", "档案 Cookie 无效。");
    }

    const endpoint = new URL("https://api-takumi.mihoyo.com/binding/api/getUserGameRolesByCookie");
    const biz = gameBiz[game];
    endpoint.searchParams.set("game_biz", biz);
    const deadline = AbortSignal.timeout(15_000);

    let response: Response;
    try {
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

    const matching = payload.data.list.filter((item) => isRecord(item) && item.game_biz === biz);
    return normalizeGameRoles(matching);
  }

  return {
    async listRoles(context: ProfileAccountContext, game: Game, signal?: AbortSignal): Promise<GameRole[]> {
      try {
        return await list(context, game, signal);
      } catch (error) {
        if (!recovery || signal?.aborted || !(error instanceof HoyoRequestError) ||
            error.code !== "api" || error.retcode === undefined || !expired.has(error.retcode)) throw error;
      }

      let refreshed: ProfileAccountContext;
      try {
        refreshed = await recover(context);
      } catch {
        throw new HoyoRequestError("refresh", "无法刷新当前档案的 Cookie，请确认登录状态后重试。");
      }
      return list(refreshed, game, signal);
    },
  };
}

export function createProfileHoyoClient(
  profiles = createProfileStore(),
  transport: HoyoTransport = fetch,
) {
  return createHoyoClient(transport, { profiles, exchange: createCredentialExchange(transport) });
}
