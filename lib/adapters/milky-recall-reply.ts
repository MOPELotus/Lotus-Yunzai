import type { MessageEvent, RecallResult } from "../messages.ts";
import type { MilkyConfirmation } from "./milky-api.ts";

type Confirm = (action: string, params: Record<string, unknown>) => Promise<MilkyConfirmation>;

const commandLimit = 4_096;

function isSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isId(value: unknown): value is number {
  return isSequence(value) && value > 0;
}

function replySequence(value: MessageEvent["reply_id"]): number | undefined {
  const sequence = typeof value === "string" && /^(?:0|[1-9]\d{0,15})$/u.test(value) ? Number(value) : value;
  return isSequence(sequence) ? sequence : undefined;
}

export function createMilkyRecallReply(signal: AbortSignal, confirm: Confirm, isMaster: (userId: number) => boolean) {
  const sending = new Set<string>();
  const completed = new Set<string>();
  signal.addEventListener("abort", () => {
    sending.clear();
    completed.clear();
  }, { once: true });

  async function recall(action: string, params: Record<string, unknown>): Promise<RecallResult> {
    if (signal.aborted) return "rejected";
    try {
      return (await confirm(action, params)).status;
    } catch {
      return "unknown";
    }
  }

  return (event: MessageEvent): MessageEvent["recallReply"] => {
    const { self_id: account, user_id: user, group_id: group, message_type: scene, message_id: command } = event;
    if (signal.aborted || !isId(account) || !isId(user) || user === account || !isSequence(command) || !isMaster(user)) return;
    const target = scene === "group" && isId(group) ? { group_id: group }
      : scene === "private" && group === undefined ? { user_id: user } : undefined;
    if (!target) return;
    const action = scene === "group" ? "recall_group_message" : "recall_private_message";
    const quoted = replySequence(event.reply_id);
    if (event.reply_id !== undefined && quoted !== command) return;
    const key = `${scene}:${target.group_id ?? target.user_id}:${command}`;

    return async () => {
      if (signal.aborted || !isMaster(user) || sending.has(key) || completed.has(key) || sending.size >= commandLimit) return;
      if (sending.size + completed.size >= commandLimit) completed.delete(completed.values().next().value!);
      sending.add(key);
      try {
        const results = [await recall(action, { ...target, message_seq: command })];
        if (!signal.aborted && isMaster(user)) return results;
      } finally {
        sending.delete(key);
        if (!signal.aborted) completed.add(key);
      }
    };
  };
}
