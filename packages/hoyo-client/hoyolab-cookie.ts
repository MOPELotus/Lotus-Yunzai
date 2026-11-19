import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { readGameRecordPayload } from "./game-record.ts";

const passportOrigins = {
  SG: "https://passport-api-sg.hoyolab.com",
  US: "https://passport-api-us.hoyolab.com",
  EU: "https://passport-api-eu.hoyolab.com",
} as const;
export type HoYoLabPassportRealm = keyof typeof passportOrigins;

const verifyPath = "/account/ma-passport/token/verifyCookieToken";
const officialOrigin = "https://act.hoyolab.com";
const officialPage = `${officialOrigin}/ys/event/signin-sea-v3/index.html?act_id=e202102251931481`;
const identityFields = ["account_id", "account_id_v2", "ltuid", "ltuid_v2", "stuid", "uid", "aid"];
const midFields = ["account_mid_v2", "ltmid_v2", "stmid_v2", "mid"];

function invalidInput(): never {
  throw new HoyoRequestError("invalid-input", "请输入账号归属一致的国际服 Cookie。");
}

function invalidProof(): never {
  throw new HoyoRequestError("response", "官方通行证返回的国际服 Cookie 归属证明无效。");
}

function transportError() {
  return new HoyoRequestError("transport", "国际服 Cookie 归属验证请求未完成。");
}

function accountIdOf(value: unknown) {
  if (typeof value === "string" && /^[1-9]\d{0,19}$/u.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
}

function realmOf(value: unknown): HoYoLabPassportRealm | undefined {
  if (typeof value !== "string") return;
  const realm = value.toUpperCase();
  if (realm === "SG" || realm === "US" || realm === "EU") return realm;
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
}

function credentials(input: string) {
  if (typeof input !== "string" || input.length > 16_384 || /[^\x20-\x7e]/u.test(input)) invalidInput();
  const fields = new Map<string, string>();
  for (const field of input.split(";")) {
    if (!field.trim()) continue;
    const separator = field.indexOf("=");
    if (separator < 1) invalidInput();
    const key = field.slice(0, separator).trim();
    const value = field.slice(separator + 1).trim();
    if (!/^[!#$%&'*+.^_`|~\w-]+$/u.test(key) ||
        !/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/u.test(value) || fields.has(key)) invalidInput();
    fields.set(key, value);
  }
  const v2 = fields.has("cookie_token_v2");
  if (v2 && fields.has("cookie_token")) invalidInput();
  const tokenField = v2 ? "cookie_token_v2" : "cookie_token";
  const idField = v2 ? "account_id_v2" : "account_id";
  const token = fields.get(tokenField);
  const accountId = accountIdOf(fields.get(idField));
  if (!accountId || !token || !/^[A-Za-z0-9._~+/%=-]{1,4096}$/u.test(token) || !v2 && /^v2_/iu.test(token) ||
      identityFields.some(key => fields.has(key) && fields.get(key) !== accountId)) invalidInput();

  const mids = new Set(midFields.flatMap(key => fields.has(key) ? [fields.get(key)!] : []));
  const [mid] = mids;
  if (mids.size > 1 || (mid !== undefined && !/^[A-Za-z0-9_-]{1,128}$/u.test(mid)) ||
      (v2 && !fields.has("account_mid_v2"))) invalidInput();
  const explicitRealm = fields.get("ma_passport_region");
  const realm = explicitRealm === undefined ? "SG" : realmOf(explicitRealm);
  if (!realm) invalidInput();

  const cookie = `${idField}=${accountId}; ${tokenField}=${token}${v2 ? `; account_mid_v2=${mid}` : ""}`;
  return { cookie, accountId, mid, realm };
}

export async function verifyHoYoLabCookie(input: string, transport: HoyoTransport, {
  signal, verifyProfile,
}: {
  readonly signal?: AbortSignal;
  readonly verifyProfile?: () => Promise<void>;
} = {}): Promise<{ cookie: string; accountId: string; realm: HoYoLabPassportRealm }> {
  const { cookie, accountId, mid, realm } = credentials(input);
  const endpoint = new URL(verifyPath, passportOrigins[realm]);
  const timeout = AbortSignal.timeout(10_000);
  const deadline = signal ? AbortSignal.any([timeout, signal]) : timeout;
  async function guard() {
    if (deadline.aborted) throw transportError();
    await verifyProfile?.();
    if (deadline.aborted) throw transportError();
  }
  await guard();

  let response: Response;
  try {
    response = await transport(endpoint, {
      method: "POST", body: "{}", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", signal: deadline,
      headers: {
        Accept: "application/json", "Content-Type": "application/json", Cookie: cookie,
        Origin: officialOrigin, Referer: `${officialOrigin}/`,
        "x-rpc-source": "v2.webLogin", "x-rpc-referrer": officialPage,
        "x-rpc-app_id": "c9oqaq3s3gu8", "x-rpc-game_biz": "hk4e_global", "x-rpc-language": "en-us",
        ...(realm !== "SG" && { "x-rpc-domain_redirect": "true" }),
      },
    });
  } catch {
    await guard();
    throw transportError();
  }

  if (deadline.aborted || response.status !== 200 || response.redirected || (response.url && response.url !== endpoint.href)) {
    void response.body?.cancel().catch(() => undefined);
    await guard();
    throw new HoyoRequestError("http", "官方通行证国际服 Cookie 验证返回 HTTP 错误。", response.status);
  }
  const challenge = response.headers.get("x-rpc-aigis")?.trim();
  if (challenge && challenge !== "{}") {
    void response.body?.cancel().catch(() => undefined);
    await guard();
    throw new HoyoRequestError("api", "官方通行证需要额外验证，请在 HoYoLAB 处理。");
  }

  const payload = await readGameRecordPayload(response, 32 * 1024, deadline);
  await guard();
  const retcode = payload?.retcode;
  if (typeof retcode !== "number" || !Number.isSafeInteger(retcode)) invalidProof();
  if (retcode !== 0) throw new HoyoRequestError("api", "官方通行证未接受该国际服 Cookie。", response.status, retcode);
  const data = record(payload?.data);
  const user = record(data?.user_info);
  if (!data || !user || accountIdOf(user.aid) !== accountId) invalidProof();
  for (const fields of [data, user]) {
    if (identityFields.some(key => Object.hasOwn(fields, key) && accountIdOf(fields[key]) !== accountId) ||
        (mid !== undefined && midFields.some(key => Object.hasOwn(fields, key) && fields[key] !== mid)) ||
        (Object.hasOwn(fields, "ma_passport_region") && realmOf(fields.ma_passport_region) !== realm)) invalidProof();
  }
  const responseRealm = response.headers.get("x-rpc-ma_passport_region");
  if (responseRealm !== null && realmOf(responseRealm) !== realm) invalidProof();
  return { cookie, accountId, realm };
}
