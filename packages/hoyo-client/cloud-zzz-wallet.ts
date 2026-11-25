import { createTranslator as createTextTranslator } from "../i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("hoyo-client", messageCatalog.messages);
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { readGameRecordPayload } from "./game-record.ts";

export interface CloudZzzWallet {
  readonly freeTimeMinutes: number;
  readonly grantedMinutes?: number;
}

interface CloudZzzWalletOptions {
  readonly signal?: AbortSignal;
  readonly verifyProfile?: () => Promise<void>;
}

const walletUrl = "https://cg-nap-api.mihoyo.com/nap_cn/cg/wallet/wallet/get?cost_method=0&get_type=0";
const sessionField = "[A-Za-z0-9._~+/%-]+={0,2}";
const signedSession = new RegExp(`^ai=[1-9]\\d{0,9};ci=\\d{1,10};oi=${sessionField};ct=${sessionField};si=${sessionField};bi=nap_cn$`, "u");
const walletErrors = {
  expired: $t("cloud-zzz-wallet.text_2e7b160f1a"),
  risk: $t("cloud-zzz-wallet.text_0e5832f176"),
  "rate-limited": $t("cloud-zzz-wallet.text_68a9afe81c"),
  "missing-balance": $t("cloud-zzz-wallet.text_fa1317abca"),
  "invalid-balance": $t("cloud-zzz-wallet.text_a89cc5da36"),
} as const;

export class CloudZzzWalletError extends HoyoRequestError {
  constructor(readonly reason: keyof typeof walletErrors, status: number, retcode?: number) {
    const code = status >= 400 ? "http" : reason === "missing-balance" || reason === "invalid-balance" ? "response" : "api";
    super(code, walletErrors[reason], status, retcode);
  }
}

export function normalizeCloudZzzComboToken(input: string): string {
  if (typeof input === "string" && input.length <= 8192 && !/[^\x20-\x7e]/u.test(input)) {
    const token = input.trim();
    // Preserve the Android session header and its existing signature verbatim.
    if (signedSession.test(token)) return token;
  }
  throw new HoyoRequestError("invalid-input", $t("cloud-zzz-wallet.text_889267d504"));
}

function object(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
}

function minutes(value: unknown) {
  const count = typeof value === "string" && /^\d{1,16}$/u.test(value) ? Number(value) : value;
  if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) return count === 0 ? 0 : count;
}

function readBalance(data: unknown, status: number): CloudZzzWallet {
  if (data == null) throw new CloudZzzWalletError("missing-balance", status);
  const wallet = object(data);
  const time = wallet?.free_time;
  if (wallet && time == null) throw new CloudZzzWalletError("missing-balance", status);
  const freeTime = object(time);
  const value = freeTime?.free_time;
  if (freeTime && value == null) throw new CloudZzzWalletError("missing-balance", status);
  const freeTimeMinutes = minutes(value);
  if (freeTimeMinutes === undefined) throw new CloudZzzWalletError("invalid-balance", status);
  const grantedMinutes = minutes(freeTime?.send_freetime);
  return { freeTimeMinutes, ...(grantedMinutes !== undefined && { grantedMinutes }) };
}

/** Queries the authorized CN cloud session's balance using the Android client's wallet defaults. */
export async function readCloudZzzWallet(comboToken: string, transport: HoyoTransport,
  { signal, verifyProfile }: CloudZzzWalletOptions = {},
): Promise<CloudZzzWallet> {
  const token = normalizeCloudZzzComboToken(comboToken);
  const timeout = AbortSignal.timeout(10_000);
  const deadline = signal ? AbortSignal.any([timeout, signal]) : timeout;
  const unavailable = () => new HoyoRequestError("transport", $t("cloud-zzz-wallet.text_f26d79ea5f"));
  async function guard() {
    signal?.throwIfAborted();
    await verifyProfile?.();
    signal?.throwIfAborted();
    if (timeout.aborted) throw unavailable();
  }

  await guard();
  let response: Response;
  try {
    response = await transport(new URL(walletUrl), {
      method: "GET", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", signal: deadline,
      headers: {
        Accept: "application/json",
        "x-rpc-combo_token": token,
        "x-rpc-client_type": "2",
        "x-rpc-app_version": "3.3.0",
        "x-rpc-cg_game_biz": "nap_cn",
        "x-rpc-op_biz": "clgm_nap-cn",
      },
    });
  } catch {
    await guard();
    throw unavailable();
  }

  const { status } = response;
  const challenge = response.headers.get("x-rpc-aigis")?.trim();
  const unexpectedUrl = response.redirected || (response.url && response.url !== walletUrl);
  if (unexpectedUrl || status === 429 || (challenge && challenge !== "{}") || (status !== 200 && status !== 401)) {
    void response.body?.cancel().catch(() => undefined);
    await guard();
    if (!unexpectedUrl && status === 429) throw new CloudZzzWalletError("rate-limited", status);
    if (!unexpectedUrl && challenge && challenge !== "{}") throw new CloudZzzWalletError("risk", status);
    throw new HoyoRequestError("http", $t("cloud-zzz-wallet.text_a9b1b1a325"), status);
  }

  const payload = await readGameRecordPayload(response, 128 * 1024, deadline);
  await guard();
  const retcode = payload?.retcode;
  if (retcode === -100) throw new CloudZzzWalletError("expired", status, retcode);
  if (status !== 200) throw new HoyoRequestError("http", $t("cloud-zzz-wallet.text_d796e8beb1"), status);
  if (typeof retcode !== "number" || !Number.isSafeInteger(retcode)) {
    throw new HoyoRequestError("response", $t("cloud-zzz-wallet.text_53978e659e"));
  }
  if (retcode !== 0) throw new HoyoRequestError("api", $t("cloud-zzz-wallet.text_d796e8beb1"), status, retcode);
  return readBalance(payload?.data, status);
}
