import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
interface OnlineNoticeOptions {
  readonly signal?: AbortSignal;
  readonly version?: string;
  readonly masterIds: (botId: number) => readonly number[];
  readonly claim: (botId: number, seconds: number) => Promise<boolean>;
  readonly send: (botId: number, userId: number, message: string) => Promise<boolean | void>;
}

const defaultMinutes = 1_440;
const maxSeconds = Math.floor(Number.MAX_SAFE_INTEGER / 1_000);
const decimal = /^(?:\d+(?:\.\d*)?|\.\d+)$/u;
const help = [
  $t("lib.online-notice.text_6b32aec4ae"),
  $t("lib.online-notice.text_f7ca78b573"),
  $t("lib.online-notice.text_3d495cefdd"),
  $t("lib.online-notice.text_ac37618b87"),
  $t("lib.online-notice.text_a41ec89f1f"),
  $t("lib.online-notice.text_f3cecbf587"),
  $t("lib.online-notice.text_18d5648094"),
  $t("lib.online-notice.text_aac4f2b766"),
  $t("lib.online-notice.text_0e15cc26ff"),
].join("\n");

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function onlineNoticeSeconds(value: unknown): number | undefined {
  const configured = value === undefined ? defaultMinutes : value;
  const minutes = typeof configured === "string" && decimal.test(configured.trim()) ? Number(configured) : configured;
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) return;
  const seconds = Math.ceil(minutes * 60);
  if (positiveInteger(seconds) && seconds <= maxSeconds) return seconds;
}

export async function notifyOnlineMasters(
  botId: number, seconds: number | undefined, { signal, version, masterIds, claim, send }: OnlineNoticeOptions,
): Promise<void> {
  if (!positiveInteger(botId) || !positiveInteger(seconds) || seconds > maxSeconds || signal?.aborted) return;
  const recipients = () => new Set(masterIds(botId).filter((id) => positiveInteger(id) && id !== botId));
  let current: Set<number>;
  try {
    if (!recipients().size || signal?.aborted || await claim(botId, seconds) !== true || signal?.aborted) return;
    current = recipients();
  } catch {
    return;
  }

  const welcome = $t("lib.online-notice.text_94c850185d", { "value1": version ? ` v${version}` : "", "help": help });
  for (const userId of current) {
    if (signal?.aborted) return;
    try {
      await send(botId, userId, welcome);
    } catch {
      // The delivery result is unknown. Keep the cooldown and continue with other owners.
    }
  }
}
