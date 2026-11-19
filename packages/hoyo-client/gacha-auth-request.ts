import { createHash, randomInt } from "node:crypto";
import type { ProfileRequestContext } from "@lotus-yunzai/account";
import { HoyoRequestError } from "./errors.ts";

const appVersion = "2.118.1";
const signingSalt = "7a047e46eadd8693f09513e55bdf6bd8";
const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
const uidFields = ["stuid", "uid", "ltuid", "ltuid_v2", "account_id", "account_id_v2"];
const midFields = ["mid", "stmid_v2", "ltmid_v2", "account_mid_v2"];

function parseCookie(cookie: string) {
  return cookie.split(";").flatMap((field) => {
    const separator = field.indexOf("=");
    return separator > 0 ? [[field.slice(0, separator).trim(), field.slice(separator + 1).trim()] as const] : [];
  });
}

export function gachaStokenCookie({ account }: ProfileRequestContext, game: "原神" | "绝区零") {
  const { stoken, stokenCookie, cookie, stuid, ltuid, mid } = account;
  const login = parseCookie(stokenCookie);
  const fields = [...login, ...parseCookie(cookie)];
  const ids = new Set([stuid, ltuid, ...fields.filter(([key]) => uidFields.includes(key)).map(([, value]) => value)].filter(Boolean));
  const mids = new Set([mid, ...fields.filter(([key]) => midFields.includes(key)).map(([, value]) => value)].filter(Boolean));
  const tokens = new Set(login.filter(([key]) => key === "stoken").map(([, value]) => value));
  const [accountId] = ids;
  const [token] = tokens;
  if (!stokenCookie.trim() || /[\u0000-\u001f\u007f]/u.test(stokenCookie) || ids.size !== 1 ||
      !accountId || !/^[1-9]\d*$/u.test(accountId) || mids.size > 1 || tokens.size !== 1 || !token ||
      (stoken && stoken !== token) || (token.startsWith("v2_") && !mids.size)) {
    throw new HoyoRequestError("invalid-input", `${game}抽卡需要归属一致的档案登录凭据。`);
  }
  return stokenCookie;
}

export function gachaAuthHeaders(cookie: string, { device }: ProfileRequestContext) {
  const time = Math.floor(Date.now() / 1000);
  const nonce = Array.from({ length: 6 }, () => chars[randomInt(chars.length)]).join("");
  const sign = createHash("md5").update(`salt=${signingSalt}&t=${time}&r=${nonce}`).digest("hex");
  const headers = new Headers({
    Cookie: cookie, "Content-Type": "application/json", Accept: "application/json", "User-Agent": "okhttp/4.9.3",
    "x-rpc-app_version": appVersion, "x-rpc-client_type": "5", "x-rpc-channel": "mihoyo",
    "x-rpc-sys_version": device.androidVersion || "12", Referer: "https://app.mihoyo.com", Origin: "https://webstatic.mihoyo.com",
    "x-rpc-device_id": device.id || "00000000000000000000000000000000",
    "x-rpc-device_name": device.name || "Lotus Device", "x-rpc-device_model": device.model || "Lotus",
    DS: `${time},${nonce},${sign}`,
  });
  if (device.id && device.fp) headers.set("x-rpc-device_fp", device.fp);
  return headers;
}
