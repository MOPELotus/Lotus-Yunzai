import type { MessageEvent } from "../messages.ts";
import { createMilkyApi } from "./milky-api.ts";
import type { MilkySettings } from "./milky-config.ts";
import { milkyMessage } from "./milky-message.ts";

export interface MilkyTransportOptions {
  readonly signal: AbortSignal;
  readonly dispatch: (event: MessageEvent) => Promise<void>;
  readonly onSent?: (event: MessageEvent, message: unknown) => void;
}

export interface MilkySession {
  receive(value: unknown): "accepted" | "invalid" | "foreign" | "offline";
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export async function openMilkySession(settings: MilkySettings, options: MilkyTransportOptions): Promise<MilkySession | undefined> {
  const { signal, dispatch, onSent } = options;
  const call = createMilkyApi(settings, signal);
  const login = await call("get_login_info", {});
  const account = login?.uin;
  if (signal.aborted || !positiveId(account)) return;

  const recalls = new Set<ReturnType<typeof setTimeout>>();
  signal.addEventListener("abort", () => {
    for (const timer of recalls) clearTimeout(timer);
    recalls.clear();
  }, { once: true });

  function scheduleRecall(action: string, params: Record<string, unknown>, seconds: number) {
    if (signal.aborted) return;
    const timer = setTimeout(async () => {
      recalls.delete(timer);
      if (!await call(action, params) && !signal.aborted) console.warn("[Milky] 消息撤回未获确认。");
    }, seconds * 1_000);
    timer.unref();
    recalls.add(timer);
  }

  return { receive(body) {
    if (signal.aborted) return "offline";
    if (!record(body) || !positiveId(body.self_id) || typeof body.event_type !== "string" ||
        !body.event_type || !record(body.data)) return "invalid";
    if (body.self_id !== account) return "foreign";
    if (body.event_type === "bot_offline") return "offline";

    const message = milkyMessage(body, account, async (action, params) => {
      const result = await call(action, params);
      const sequence = result?.message_seq;
      if (message && typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence >= 0) {
        onSent?.(message, params.message);
      }
      return result;
    }, scheduleRecall);
    if (message) void dispatch(message).catch(() => console.warn("[Milky] 处理事件失败。"));
    return "accepted";
  } };
}
