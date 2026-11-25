import { randomBytes } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";

const endpoint = new URL("https://public-data-api.mihoyo.com/device-fp/api/getFp");
const seed = "38d7ee834d1e9";
const cache = new Map<string, { fp: string; expires: number }>();

/** Same query-only FP acquisition as genshin/model/mys/apiTool.js; never changes a bound device. */
export async function addRecordFingerprint(headers: Headers, transport: HoyoTransport, signal: AbortSignal,
  verify: () => Promise<void>) {
  const id = headers.get("x-rpc-device_id");
  if (!id || headers.has("x-rpc-device_fp")) return;
  await verify();
  const saved = cache.get(id);
  if (saved && saved.expires > Date.now()) {
    headers.set("x-rpc-device_fp", saved.fp);
    return;
  }
  const body = JSON.stringify({ seed_id: randomBytes(8).toString("hex"), device_id: id,
    platform: "1", seed_time: String(Date.now()), app_name: "bbs_cn", device_fp: seed,
    ext_fields: JSON.stringify({ proxyStatus: "0", accelerometer: "-0.159515x-0.830887x-0.682495",
      ramCapacity: "3746", IDFV: id, gyroscope: "-0.191951x-0.112927x0.632637",
      isJailBreak: "0", model: "iPhone12,5", ramRemain: "115", chargeStatus: "1", networkType: "WIFI",
      vendor: "--", osVersion: "17.0.2", batteryStatus: "50", screenSize: "414×896", cpuCores: "6",
      appMemory: "55", romCapacity: "488153", romRemain: "157348", cpuType: "CPU_TYPE_ARM64",
      magnetometer: "-84.426331x-89.708435x-37.117889" }),
  });
  const failed = () => new HoyoRequestError("transport", "米游社查询设备指纹申请失败，请稍后重试。");
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted();
    await verify();
    let response: Response;
    try {
      response = await transport(endpoint, { method: "POST", headers: { "User-Agent": "okhttp/4.9.3", "Content-Type": "application/json" },
        body, signal, keepalive: false, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
    } catch {
      signal.throwIfAborted();
      await verify();
      if (attempt < 2) continue;
      throw failed();
    }
    await verify();
    if (response.redirected || (response.url && response.url !== endpoint.href) || !response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const gatewayGone = response.status === 410 && /^text\/html(?:\s*;|$)/iu.test(response.headers.get("Content-Type") ?? "");
      if ((response.status === 408 || response.status >= 500 || gatewayGone) && attempt < 2) {
        await wait(250 * (attempt + 1), undefined, { signal });
        continue;
      }
      throw failed();
    }
    // Reuse the bounded official JSON reader without a static game-record import cycle.
    const { readGameRecordPayload } = await import("./game-record.ts");
    const payload = await readGameRecordPayload(response, 64 * 1024, signal);
    await verify();
    const data = payload?.data;
    if (payload?.retcode !== 0 || !data || typeof data !== "object" || Array.isArray(data)) throw failed();
    const issued = data as Record<string, unknown>;
    if (Number(issued.code) !== 200 || typeof issued.device_fp !== "string" ||
        !/^[a-f0-9]{13}$/iu.test(issued.device_fp) || issued.device_fp.toLowerCase() === seed ||
        (issued.device_id !== undefined && issued.device_id !== id)) throw failed();
    signal.throwIfAborted();
    if (cache.size >= 128) cache.delete(cache.keys().next().value!);
    cache.set(id, { fp: issued.device_fp, expires: Date.now() + 24 * 60 * 60 * 1000 });
    headers.set("x-rpc-device_fp", issued.device_fp);
    return;
  }
}
