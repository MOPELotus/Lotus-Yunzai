import { createHash } from "node:crypto";
import type { QuotedMessage } from "./messages.ts";

export interface PrivateNoticeScope {
  readonly adapter: "onebot" | "milky";
  readonly account: number;
  readonly owner: number;
  readonly message: number;
}

export interface PrivateNoticeReceiptStore {
  read(key: string): Promise<string | null>;
  write(key: string, value: string, ttl: number): Promise<void>;
}

interface Receipt<Origin> {
  readonly origin: Origin;
  readonly expires: number;
  readonly noticeHash: string;
}

const maxReceipts = 4096;

export function hashPrivateNotice(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function privateNoticeText(source: QuotedMessage["message"], allowAttachments: boolean) {
  if (typeof source === "string") return source;
  const text: string[] = [];
  for (const part of source) {
    if (part.type === "text" && typeof part.text === "string") text.push(part.text);
    else if (!allowAttachments || (part.type !== "image" && part.type !== "face")) return;
  }
  return text.join("");
}

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function receiptKey({ adapter, account, owner, message }: PrivateNoticeScope): string | undefined {
  if (!positiveId(account) || !positiveId(owner) || owner === account || !Number.isSafeInteger(message)) return;
  if (adapter === "milky" ? message < 0 : message === 0 || message < -2147483648 || message > 2147483647) return;
  return `receipt:${adapter}:${account}:${owner}:${message}`;
}

export function createPrivateNoticeReceipts<Origin>(getStorage: () => PrivateNoticeReceiptStore | undefined, lifetimeSeconds: number,
  isOrigin: (value: unknown, account: number) => value is Origin, now = Date.now) {
  const receipts = new Map<string, Receipt<Origin>>();

  return {
    async record(scope: PrivateNoticeScope, origin: Origin, message: string) {
      const key = receiptKey(scope);
      if (!key || !isOrigin(origin, scope.account) || !message) return;
      const receipt = { origin, expires: now() + lifetimeSeconds * 1000, noticeHash: hashPrivateNotice(message) };
      if (receipts.size >= maxReceipts) receipts.delete(receipts.keys().next().value!);
      receipts.set(key, receipt);
      await getStorage()?.write(key, JSON.stringify(receipt), lifetimeSeconds + 60);
    },
    async read(scope: PrivateNoticeScope): Promise<Receipt<Origin> | undefined> {
      const key = receiptKey(scope);
      if (!key) return;
      const local = receipts.get(key);
      if (local) return local;
      try {
        const saved = await getStorage()?.read(key);
        const receipt: unknown = saved && JSON.parse(saved);
        if (record(receipt) && positiveId(receipt.expires) && isOrigin(receipt.origin, scope.account) &&
            typeof receipt.noticeHash === "string" && /^[a-f0-9]{64}$/u.test(receipt.noticeHash)) {
          return { expires: receipt.expires, origin: receipt.origin, noticeHash: receipt.noticeHash };
        }
      } catch {
        return;
      }
    },
  };
}
