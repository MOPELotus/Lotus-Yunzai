import type { ProfileRequestContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { genshinGachaPools, readGenshinAuthKey, type GenshinGachaPool, type GenshinGachaRow, type readGenshinGacha } from "./genshin-gacha.ts";

export interface GenshinMiniappOptions {
  readonly signal?: AbortSignal;
}

const endpoint = "https://www.lelaer.com/outputGacha.php";
const maxResponseBytes = 32 * 1024 * 1024;
const maxRecords = 100_000;
const timestampText = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decimal(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value !== "string" || !/^\d{1,40}$/u.test(value)) return;
  return value.replace(/^0+/u, "") || undefined;
}

function poolFor(type: string | undefined): GenshinGachaPool | undefined {
  return type === "400" ? 301 : genshinGachaPools.find((pool) => String(pool.type) === type)?.type;
}

function validTime(value: unknown): value is string {
  if (typeof value !== "string" || !timestampText.test(value)) return false;
  const iso = value.replace(" ", "T");
  const stamp = Date.parse(`${iso}Z`);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 19) === iso;
}

function parseExport(value: unknown, uid: string, authkey: string) {
  if (!record(value) || !Array.isArray(value.list) || value.list.length > maxRecords ||
      (value.info != null && !record(value.info)) || (value.retcode != null && value.retcode !== 0 && value.retcode !== "0")) {
    throw new HoyoRequestError("response", "提瓦特小助手没有返回有效的抽卡列表。");
  }
  const declared = [value.uid, record(value.info) ? value.info.uid : undefined].filter((entry) => entry != null);
  if (declared.some((entry) => decimal(entry) !== uid)) {
    throw new HoyoRequestError("response", "提瓦特小助手返回的 UID 与当前档案不一致。");
  }

  const grouped = new Map<GenshinGachaPool, GenshinGachaRow[]>(genshinGachaPools.map(({ type }) => [type, []]));
  const encodedKey = encodeURIComponent(authkey);
  for (const entry of value.list) {
    if (!record(entry)) throw new HoyoRequestError("response", "提瓦特小助手记录格式无效。");
    if ((entry.uid != null || !declared.length) && decimal(entry.uid) !== uid) {
      throw new HoyoRequestError("response", "提瓦特小助手记录缺少本档案 UID 或属于其他账号。");
    }
    const raw = decimal(entry.gacha_type);
    const pool = poolFor(raw);
    if (!raw || !pool || (entry.uigf_gacha_type != null && decimal(entry.uigf_gacha_type) !== String(pool))) {
      throw new HoyoRequestError("response", "提瓦特小助手返回了无效或不受支持的卡池编号。");
    }
    const id = decimal(entry.id);
    const rank = decimal(entry.rank_type);
    const { time, item_type, name } = entry;
    if (!id || (rank !== "3" && rank !== "4" && rank !== "5") || !validTime(time) ||
        (item_type !== "角色" && item_type !== "武器") || typeof name !== "string" || !name.trim() ||
        name.length > 200 || /[\u0000-\u001f\u007f]|https?:\/\//iu.test(name) || name.includes(authkey) || name.includes(encodedKey)) {
      throw new HoyoRequestError("response", "提瓦特小助手记录的编号、名称、类别、星级或时间无效。");
    }
    const row: GenshinGachaRow = { id, uid, gacha_type: raw as GenshinGachaRow["gacha_type"], uigf_gacha_type: String(pool),
      item_type, name, time, rank_type: rank };
    for (const key of ["item_id", "gacha_id", "count"] as const) {
      const field = decimal(entry[key]);
      if (field) row[key] = field;
    }
    if (typeof entry.lang === "string" && /^[a-z]{2,3}(?:-[a-z]{2,4})?$/iu.test(entry.lang)) row.lang = entry.lang;
    if (typeof entry.is_up === "boolean") row.is_up = entry.is_up;
    grouped.get(pool)!.push(row);
  }
  return genshinGachaPools.map((pool) => ({ ...pool, records: grouped.get(pool.type)! }));
}

async function readExport(response: Response, signal: AbortSignal): Promise<unknown> {
  const sizeError = () => new HoyoRequestError("response", "提瓦特小助手的导出文件过大。");
  const claimed = response.headers.get("Content-Length");
  if (claimed && Number(claimed) > maxResponseBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw sizeError();
  }
  if (!response.body) throw new HoyoRequestError("response", "提瓦特小助手未返回导出文件。");
  const reader = response.body.getReader();
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxResponseBytes) throw sizeError();
      chunks.push(value);
    }
    signal.throwIfAborted();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))) as unknown;
  } catch (error) {
    if (error instanceof HoyoRequestError) throw error;
    if (signal.aborted) throw new HoyoRequestError("transport", "提瓦特小助手请求已取消或超时。");
    throw new HoyoRequestError("response", "提瓦特小助手未返回有效的 JSON 导出文件。");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function readGenshinMiniapp(
  source: ProfileRequestContext,
  transport: HoyoTransport,
  { signal }: GenshinMiniappOptions = {},
  verifyProfile?: () => Promise<void>,
): Promise<Awaited<ReturnType<typeof readGenshinGacha>>> {
  async function guard() {
    if (signal?.aborted) throw new HoyoRequestError("transport", "提瓦特小助手请求已取消。");
    await verifyProfile?.();
    if (signal?.aborted) throw new HoyoRequestError("transport", "提瓦特小助手请求已取消。");
  }

  const { uid, region, url } = await readGenshinAuthKey(source, transport, { signal }, verifyProfile);
  const authkey = url.searchParams.get("authkey");
  if (!authkey) throw new HoyoRequestError("response", "原神官方登录未返回抽卡凭据。");
  await guard();
  const timeout = AbortSignal.timeout(30_000);
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await transport(new URL(endpoint), {
      method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ uid, gachaurl: url.toString(), lang: "zh-Hans" }).toString(),
      credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", signal: deadline,
    });
  } catch {
    throw new HoyoRequestError("transport", "提瓦特小助手请求未完成。");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new HoyoRequestError("http", "提瓦特小助手导出请求失败。", response.status);
  }
  const pools = parseExport(await readExport(response, deadline), uid, authkey);
  await guard();
  return { uid, region, pools };
}
