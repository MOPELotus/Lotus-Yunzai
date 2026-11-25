import { createTranslator as createTextTranslator } from "../i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("hoyo-client", messageCatalog.messages);
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { readGameRecordPayload } from "./game-record.ts";

const endpoint = "https://api.lelaer.com/ys/getTeamResult.php";
const maxBytes = 2 * 1024 * 1024;

export interface TeamDamageArtifact {
  readonly artifacts_name: string;
  readonly artifacts_type: string;
  readonly level: number;
  readonly maintips: string;
  readonly mainvalue: string;
  readonly tips1: string;
  readonly tips2: string;
  readonly tips3: string;
  readonly tips4: string;
}

export interface TeamDamageRole {
  readonly uid: string;
  readonly role: string;
  readonly role_class: number;
  readonly level: number;
  readonly weapon: string;
  readonly weapon_level: number;
  readonly weapon_class: string;
  readonly hp: number;
  readonly base_hp: number;
  readonly attack: number;
  readonly base_attack: number;
  readonly defend: number;
  readonly base_defend: number;
  readonly element: number;
  readonly crit: string;
  readonly crit_dmg: string;
  readonly heal: string;
  readonly recharge: string;
  readonly physical_dmg: string;
  readonly fire_dmg: string;
  readonly water_dmg: string;
  readonly ice_dmg: string;
  readonly thunder_dmg: string;
  readonly wind_dmg: string;
  readonly rock_dmg: string;
  readonly grass_dmg: string;
  readonly ability1: number;
  readonly ability2: number;
  readonly ability3: number;
  readonly artifacts: string;
  readonly artifacts_detail: readonly TeamDamageArtifact[];
}

export interface TeamDamagePayload {
  readonly uid: string;
  readonly server: string;
  readonly role_data: readonly TeamDamageRole[];
}

export async function readGenshinTeamDamage(body: TeamDamagePayload, options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
  transport: HoyoTransport = fetch) {
  const { signal, timeoutMs = 15_000 } = options;
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(timeoutMs);
  const active = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await transport(new URL(endpoint), {
      method: "POST",
      // Fixed legacy API contract from Lotus-Plugin e28c6df. No logged-in request context is accepted here.
      headers: {
        "Content-Type": "application/json",
        Referer: "https://servicewechat.com/wx2ac9dce11213c3a8/192/page-frame.html",
        "User-Agent": "Mozilla/5.0 (Linux; Android 12; Mobile) AppleWebKit/537.36 MicroMessenger/8.0 MiniProgramEnv/android",
      },
      credentials: "omit", redirect: "error", signal: active, body: JSON.stringify(body),
    });
  } catch {
    throw new HoyoRequestError("transport", timeout.aborted ? $t("genshin-team-damage.text_b00b203061") : $t("genshin-team-damage.text_1db0db0de7"));
  }
  if (!response.ok || response.redirected || (response.url && response.url !== endpoint)) {
    await response.body?.cancel().catch(() => undefined);
    throw new HoyoRequestError("http", $t("genshin-team-damage.text_eb579cf89a"), response.status);
  }
  const payload = await readGameRecordPayload(response, maxBytes, active);
  if (active.aborted) throw new HoyoRequestError("transport", timeout.aborted ? $t("genshin-team-damage.text_b00b203061") : $t("genshin-team-damage.text_4cbfe44036"));
  if (!payload) throw new HoyoRequestError("response", $t("genshin-team-damage.text_435ca78aaa"));
  if (payload.code !== 200) throw new HoyoRequestError("api", $t("genshin-team-damage.text_a28fb1470b"));
  if (!payload.result || typeof payload.result !== "object" || Array.isArray(payload.result)) {
    throw new HoyoRequestError("response", $t("genshin-team-damage.text_5501cdc4e9"));
  }
  const result = payload.result as Record<string, unknown>;
  if ([payload.uid, result.uid].filter(uid => uid !== undefined && uid !== "").some(uid => String(uid) !== body.uid)) {
    throw new HoyoRequestError("response", $t("genshin-team-damage.text_59ce920bd4"));
  }
  return result;
}
