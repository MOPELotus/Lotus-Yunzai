import type { HoyoTransport } from "./credentials.ts";
import { readGameRecordPayload } from "./game-record.ts";

const origin = "https://api-takumi.mihoyo.com";

export class MiyousheShopError extends Error {
  constructor(readonly status: 400 | 404 | 429 | 502, message: string) {
    super(message);
  }
}

function invalidResponse(): never {
  throw new MiyousheShopError(502, "商城返回的数据格式有误。");
}

export async function readMiyousheShop(transport: HoyoTransport, route: "list" | "detail", params: Record<string, string>, signal?: AbortSignal) {
  const url = new URL(`/mall/v1/web/goods/${route}`, origin);
  url.search = new URLSearchParams({ app_id: "1", point_sn: "myb", ...params }).toString();
  const timeout = AbortSignal.timeout(8_000);
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const pending = await transport(url, {
    method: "GET", credentials: "omit", redirect: "error", signal: deadline,
    headers: { Accept: "application/json", Origin: "https://user.mihoyo.com", Referer: "https://user.mihoyo.com/",
      "x-rpc-client_type": "5" },
  }).catch(() => undefined);
  signal?.throwIfAborted();
  if (!pending) throw new MiyousheShopError(502, "暂时无法连接米游社商城。");
  if (!pending.ok) {
    await pending.body?.cancel().catch(() => undefined);
    if (pending.status === 429) throw new MiyousheShopError(429, "商城请求频繁，请稍后再试。");
    if (route === "detail" && pending.status === 404) throw new MiyousheShopError(404, "商品不存在或已下架。");
    throw new MiyousheShopError(502, "米游社商城暂时不可用。");
  }
  const payload = await readGameRecordPayload(pending, 512 * 1024, deadline);
  signal?.throwIfAborted();
  if (!payload || typeof payload.retcode !== "number") invalidResponse();
  if (payload.retcode !== 0) {
    if (payload.retcode === 429 || typeof payload.message === "string" && /频繁|请求过快|操作太快|频率限制/u.test(payload.message)) {
      throw new MiyousheShopError(429, "商城请求频繁，请稍后再试。");
    }
    throw new MiyousheShopError(502, "米游社商城暂时不可用。");
  }
  const data = payload.data;
  return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : invalidResponse();
}
