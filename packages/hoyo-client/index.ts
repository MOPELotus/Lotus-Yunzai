import { normalizeGameRoles, type Game, type GameRole, type ProfileAccountContext } from "@lotus-yunzai/account";

const gameBiz: Record<Game, string> = {
  gs: "hk4e_cn",
  sr: "hkrpg_cn",
  zzz: "nap_cn",
};

export class HoyoRequestError extends Error {
  constructor(
    readonly code: "invalid-input" | "transport" | "http" | "response" | "api",
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

export function createHoyoClient(transport: (endpoint: URL, init: RequestInit) => Promise<Response> = fetch) {
  return {
    async listRoles(context: ProfileAccountContext, game: Game, signal?: AbortSignal): Promise<GameRole[]> {
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
    },
  };
}
