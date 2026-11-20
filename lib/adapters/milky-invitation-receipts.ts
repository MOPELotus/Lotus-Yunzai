import { createHash } from "node:crypto";

export interface MilkyInvitationOrigin {
  readonly groupId: number;
  readonly inviterId: number;
  readonly sequence: number;
}

interface ReceiptScope {
  readonly account: number;
  readonly owner: number;
  readonly message: number;
}

interface ReceiptStore {
  read(key: string): Promise<string | null>;
  write(key: string, value: string, ttl: number): Promise<void>;
}

interface Receipt {
  readonly origin: MilkyInvitationOrigin;
  readonly expires: number;
  readonly noticeHash: string;
}

const lifetimeSeconds = 3600;
const maxReceipts = 4096;

export function milkyInvitationNoticeHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validOrigin(origin: unknown): origin is MilkyInvitationOrigin {
  return record(origin) && positiveId(origin.groupId) && positiveId(origin.inviterId) && positiveId(origin.sequence);
}

function receiptKey({ account, owner, message }: ReceiptScope): string | undefined {
  if (positiveId(account) && positiveId(owner) && owner !== account && Number.isSafeInteger(message) && message >= 0) {
    return `receipt:milky:${account}:${owner}:${message}`;
  }
}

export function createMilkyInvitationReceipts(getStorage: () => ReceiptStore | undefined, now = Date.now) {
  const receipts = new Map<string, Receipt>();

  return {
    async record(scope: ReceiptScope, origin: MilkyInvitationOrigin, message: string) {
      const key = receiptKey(scope);
      if (!key || !validOrigin(origin) || origin.inviterId === scope.account || !message) return;
      const receipt = { origin, expires: now() + lifetimeSeconds * 1000, noticeHash: milkyInvitationNoticeHash(message) };
      if (receipts.size >= maxReceipts) receipts.delete(receipts.keys().next().value!);
      receipts.set(key, receipt);
      await getStorage()?.write(key, JSON.stringify(receipt), lifetimeSeconds + 60);
    },
    async read(scope: ReceiptScope): Promise<Receipt | undefined> {
      const key = receiptKey(scope);
      if (!key) return;
      const local = receipts.get(key);
      if (local) return local;
      try {
        const saved = await getStorage()?.read(key);
        const receipt: unknown = saved && JSON.parse(saved);
        if (record(receipt) && positiveId(receipt.expires) && validOrigin(receipt.origin) && receipt.origin.inviterId !== scope.account &&
            typeof receipt.noticeHash === "string" && /^[a-f0-9]{64}$/u.test(receipt.noticeHash)) {
          return { expires: receipt.expires, origin: receipt.origin, noticeHash: receipt.noticeHash };
        }
      } catch {
        return;
      }
    },
  };
}
