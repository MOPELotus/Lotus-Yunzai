import { createTranslator as createTextTranslator } from "../i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("hoyo-client", messageCatalog.messages);
import type { HoyoTransport } from "./credentials.ts";
import { readGameRecordPayload } from "./game-record.ts";

const pageNames = /user-game-search|bill-record-user|customer-claim|player-log/iu;
const recordRoot = "https://hk4e-api.mihoyo.com/common/hk4e_self_help_query/User/";
const pageSize = 20;
const maxPages = 100;
const tiers = [680, 300, 8080, 3880, 2240, 1090, 330, 60];
const firstPurchases = [0, 0, 12960, 6560, 3960, 1960, 600, 120];

export function isGenshinPayLogLinkCandidate(message: string) {
  return /https?:\/\/\S+/iu.test(message) && /authkey(?:=|%3d)/iu.test(message) &&
    (pageNames.test(message) || /https?:\/\/user\.mihoyo\.com(?:[/?#]|$)/iu.test(message));
}

export function genshinPayLogAuthorization(message: string) {
  if (!isGenshinPayLogLinkCandidate(message) || message.length > 12_000) return;
  const url = URL.parse(message.trim());
  if (!url || url.protocol !== "https:" || url.port || url.username || url.password ||
      !["user.mihoyo.com", "webstatic.mihoyo.com", "act.mihoyo.com"].includes(url.hostname) ||
      (url.hostname !== "user.mihoyo.com" && !pageNames.test(url.pathname + url.hash.split("?", 1)[0]))) return;
  const fragment = new URLSearchParams(url.hash.split("?", 2)[1] ?? "");
  const tickets = [...url.searchParams.getAll("authkey"), ...fragment.getAll("authkey")];
  const appIds = [...url.searchParams.getAll("auth_appid"), ...fragment.getAll("auth_appid")];
  const games = [...url.searchParams.getAll("game_biz"), ...fragment.getAll("game_biz")];
  if (tickets.length !== 1 || !/^[\x21-\x7e]{1,4096}$/u.test(tickets[0]!) ||
      appIds.some(app => app !== "csc") || games.some(game => game !== "hk4e_cn")) return;
  return tickets[0];
}

export class GenshinPayLogError extends Error {
  constructor(readonly reason: "expired" | "wrong-role" | "incomplete") { super(reason); }
}

function row(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
}

type Page = "GetUserInfo" | "GetCrystalLog" | "GetPrimogemLog";
type Entry = { readonly id: string; readonly month: string; readonly amount: number };

export async function readOnlineGenshinPayLog(auth: string, uid: string, verify: () => Promise<void>, signal: AbortSignal,
  transport: HoyoTransport = fetch) {
  async function read(page: Page, cursor?: string) {
    signal.throwIfAborted();
    await verify();
    signal.throwIfAborted();
    const endpoint = new URL(page, recordRoot);
    endpoint.search = new URLSearchParams({ selfquery_type: "1", sign_type: "2", auth_appid: "csc", authkey_ver: "1",
      game_biz: "hk4e_cn", win_direction: "portrait", bbs_auth_required: "true", bbs_game_role_required: "hk4e_cn",
      app_client: "bbs", lang: "zh-cn", csc_authkey_required: "true", page_id: "1", authkey: auth,
      ...(cursor !== undefined && { add_type: "produce", size: String(pageSize), end_id: cursor }),
    }).toString();
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
    const response = await transport(endpoint, { redirect: "error", proxy: false, signal: timeout,
      headers: { Accept: "application/json", Referer: "https://webstatic.mihoyo.com/" },
    }).catch(() => { throw new GenshinPayLogError("incomplete"); });
    const payload = await readGameRecordPayload(response, 384 * 1024, timeout);
    await verify();
    signal.throwIfAborted();
    const retcode = typeof payload?.retcode === "string" && /^-?\d{1,10}$/u.test(payload.retcode) ? Number(payload.retcode) : payload?.retcode;
    if (retcode === -101 || retcode === -100 || /unknown auth appid/iu.test(String(payload?.message ?? ""))) {
      throw new GenshinPayLogError("expired");
    }
    const data = row(payload?.data);
    if (!response.ok || retcode !== 0 || !data) throw new GenshinPayLogError("incomplete");
    return data;
  }

  async function allPages(page: Exclude<Page, "GetUserInfo">) {
    let cursor = "";
    const entries = new Map<string, Entry>();
    for (let index = 0; index < maxPages; index++) {
      const { list } = await read(page, cursor);
      if (!Array.isArray(list) || list.length > pageSize) throw new GenshinPayLogError("incomplete");
      for (const raw of list) {
        const item = row(raw);
        const id = String(item?.id ?? "");
        const amount = Number(item?.add_num);
        const month = /^(20\d{2})[-/](0[1-9]|1[0-2])[-/](?:0[1-9]|[12]\d|3[01])(?:[ T]|$)/u.exec(String(item?.datetime ?? ""));
        if (!/^[1-9]\d{0,24}$/u.test(id) || entries.has(id) ||
            !/^-?\d{1,10}$/u.test(String(item?.add_num ?? "")) || !month) throw new GenshinPayLogError("incomplete");
        entries.set(id, { id, amount, month: `${month[1]}-${month[2]}` });
        cursor = id;
      }
      if (list.length < pageSize) return [...entries.values()];
    }
    throw new GenshinPayLogError("incomplete");
  }

  const account = await read("GetUserInfo");
  if (String(account.uid) !== uid) throw new GenshinPayLogError("wrong-role");
  const crystals = await allPages("GetCrystalLog");
  const pass = (await allPages("GetPrimogemLog")).filter(item => item.amount === 680);
  const monthData = new Map<string, { month: string; payNum: number[] }>();
  let crystal = 0;
  for (const { month, amount } of [...crystals, ...pass].sort((a, b) => a.month.localeCompare(b.month))) {
    if (amount <= 0) continue;
    const tier = tiers.indexOf(amount);
    const index = tier < 0 ? firstPurchases.indexOf(amount) : tier;
    if (index < 0) continue;
    const entry = monthData.get(month) ?? { month: $t("genshin-pay-log.text_fa4962f757", { "value1": Number(month.slice(-2)) }), payNum: Array<number>(tiers.length).fill(0) };
    entry.payNum[index] = (entry.payNum[index] ?? 0) + 1;
    monthData.set(month, entry);
    if (amount !== 680) crystal += amount;
  }
  return { uid, crystal, monthData: [...monthData.values()] };
}
