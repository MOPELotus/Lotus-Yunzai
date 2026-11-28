import type { ProfileRequestContext } from "@lotus-yunzai/account";
import { createTranslator } from "../i18n/index.ts";
import catalog from "./i18n/zh-CN.json";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { readGameRecordPayload } from "./game-record.ts";

const $t = createTranslator("hoyo-client", catalog.messages);
const regions = { gs: /^os_(?:usa|euro|asia|cht)$/u, sr: /^prod_official_(?:usa|eur|asia|cht)$/u,
  zzz: /^prod_gf_(?:us|eu|jp|sg)$/u };
const businesses = { gs: "hk4e_global", sr: "hkrpg_global", zzz: "nap_global" };

export function unsupportedHoYoLab(): never {
  throw new HoyoRequestError("invalid-input", $t("hoyolab-authkey.unsupported"));
}

export async function readHoYoLabAuthKey(source: ProfileRequestContext, transport: HoyoTransport,
  { signal, authApp = "webview_gacha" }: { readonly signal?: AbortSignal; readonly authApp?: "webview_gacha" | "csc" } = {},
  verifyProfile?: () => Promise<void>) {
  const { role, international } = source;
  if (!international || role.gameBiz !== businesses[source.game] || !regions[source.game].test(role.region) ||
      !/^[1-9]\d{7,9}$/u.test(role.uid)) {
    throw new HoyoRequestError("invalid-input", $t("hoyolab-authkey.invalid"));
  }
  const cookie = international.passportCookie;
  if (!cookie || cookie.length > 16384 || /[^\x20-\x7e]/u.test(cookie)) {
    throw new HoyoRequestError("invalid-input", $t("hoyolab-authkey.invalid"));
  }
  const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000);
  const guard = async () => { deadline.throwIfAborted(); await verifyProfile?.(); deadline.throwIfAborted(); };
  let response: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    await guard();
    try {
      response = await transport(new URL("https://api-account-os.hoyoverse.com/binding/api/genAuthKeyByCookieToken"), {
        method: "POST", body: JSON.stringify({ game_uid: role.uid, region: role.region, game_biz: role.gameBiz, auth_appid: authApp }),
        headers: { Accept: "application/json", "Content-Type": "application/json", Cookie: cookie,
          Origin: "https://act.hoyolab.com", Referer: "https://act.hoyolab.com/" },
        credentials: "omit", redirect: "error", signal: deadline,
      });
      if (response.status >= 500 && attempt < 2) { await response.body?.cancel(); response = undefined; continue; }
      break;
    } catch { await guard(); }
  }
  if (!response) throw new HoyoRequestError("transport", $t("hoyolab-authkey.transport"));
  if (!response.ok || response.redirected) {
    await response.body?.cancel();
    throw new HoyoRequestError("http", $t("hoyolab-authkey.transport"), response.status);
  }
  const payload = await readGameRecordPayload(response, 32768, deadline);
  await guard();
  if (payload?.retcode !== 0) throw new HoyoRequestError("api", $t("hoyolab-authkey.failed"), response.status,
    typeof payload?.retcode === "number" ? payload.retcode : undefined);
  const data = payload.data as Record<string, unknown> | undefined;
  let authkey: string | undefined;
  try { if (typeof data?.authkey === "string") authkey = decodeURIComponent(data.authkey); } catch {}
  if (!authkey || !/^[\x21-\x7e]{1,4096}$/u.test(authkey) ||
      data?.authkey_ver !== undefined && ![1, "1"].includes(data.authkey_ver as number | string) ||
      data?.sign_type !== undefined && ![2, "2"].includes(data.sign_type as number | string) ||
      ["game_uid", "uid"].some(key => data?.[key] !== undefined && String(data[key]) !== role.uid) ||
      data?.region !== undefined && data.region !== role.region || data?.game_biz !== undefined && data.game_biz !== role.gameBiz) {
    throw new HoyoRequestError("response", $t("hoyolab-authkey.response"));
  }
  return { uid: role.uid, region: role.region, gameBiz: role.gameBiz, authkey };
}
