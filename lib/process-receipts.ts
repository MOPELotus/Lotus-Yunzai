import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isInstallName } from "./install-command.ts";
import { isGitRevision } from "./local-git.ts";

type ReceiptAdapter = "milky";
type ReceiptAccount = { readonly botId: number; readonly adapter?: ReceiptAdapter };
type ReceiptTarget =
  | { readonly type: "terminal" }
  | (ReceiptAccount & { readonly type: "masters" })
  | (ReceiptAccount & { readonly type: "group" | "private"; readonly id: number });

type ProcessOrUpdate = { readonly target: ReceiptTarget } & (
  | { readonly kind: "stop" | "restart" }
  | { readonly kind: "update"; readonly result: "updated"; readonly revision: string; readonly repositories?: number; readonly preserved?: true }
  | { readonly kind: "update"; readonly result: "rolled-back" }
);

type InstallReceipt = {
  readonly kind: "install";
  readonly target: Exclude<ReceiptTarget, { type: "masters" }>;
  readonly name: string;
} & (
  | { readonly result: "installed"; readonly revision: string }
  | { readonly result: "rolled-back" }
);

export type ProcessReceipt = { readonly at: number } & (ProcessOrUpdate | InstallReceipt);
type ReceiptSlot = boolean | "install";

const maxAge = 30 * 24 * 60 * 60 * 1_000;
const maxClockSkew = 5 * 60 * 1_000;
const maxFileBytes = 4_096;

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function receiptFrom(value: unknown): ProcessReceipt | undefined {
  if (!isRecord(value)) return;
  const { kind, at, target } = value;
  if (!positiveInteger(at) || !isRecord(target)) return;
  const session = receiptTarget(target);
  if (!session) return;
  if (kind === "stop" || kind === "restart") return { kind, at, target: session };
  if (kind === "install") {
    const { name, result, revision } = value;
    if (session.type === "masters" || !isInstallName(name)) return;
    if (result === "rolled-back") return { kind, at, target: session, name, result };
    if (result === "installed" && typeof revision === "string" && isGitRevision(revision)) {
      return { kind, at, target: session, name, result, revision };
    }
    return;
  }
  if (kind !== "update") return;
  if (value.result === "rolled-back") return { kind, at, target: session, result: value.result };
  if (value.result === "updated" && typeof value.revision === "string" && isGitRevision(value.revision)) {
    const repositories = value.repositories;
    if (repositories !== undefined && (!positiveInteger(repositories) || repositories > 129)) return;
    if (value.preserved !== undefined && value.preserved !== true) return;
    return { kind, at, target: session, result: value.result, revision: value.revision,
      ...(repositories === undefined ? {} : { repositories }),
      ...(value.preserved ? { preserved: true } : {}) };
  }
}

function receiptTarget(target: Record<string, unknown>): ProcessReceipt["target"] | undefined {
  const { type, botId, id, adapter } = target;
  if (type === "terminal") return adapter === undefined ? { type } : undefined;
  if (!positiveInteger(botId) || (adapter !== undefined && adapter !== "milky")) return;
  const account: ReceiptAccount = adapter === undefined ? { botId } : { botId, adapter };
  if (type === "masters") return { type, ...account };
  if ((type === "group" || type === "private") && positiveInteger(id)) {
    return { type, ...account, id };
  }
}

function receiptSlot(kind: ProcessReceipt["kind"]): ReceiptSlot {
  return kind === "install" ? kind : kind === "update";
}

async function readReceipt(file: string): Promise<ProcessReceipt | undefined> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (errorCode(error) === "ELOOP") return;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxFileBytes) return;
    const buffer = Buffer.alloc(maxFileBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxFileBytes) return;
    try {
      return receiptFrom(JSON.parse(buffer.toString("utf8", 0, length)));
    } catch {
      return;
    }
  } finally {
    await handle.close();
  }
}

export function createProcessReceipts(root: URL) {
  const directory = fileURLToPath(new URL("data/process-receipts/", root));

  function receiptPath(botId: number | undefined, adapter: ReceiptAdapter | undefined, slot: ReceiptSlot): string {
    const suffix = slot === "install" ? ".install.json" : slot ? ".update.json" : ".json";
    if (adapter !== undefined && (adapter !== "milky" || botId === undefined)) {
      throw new Error("进程回执的适配器无效。");
    }
    if (botId === undefined) return join(directory, `terminal${suffix}`);
    if (positiveInteger(botId)) return join(directory, `${adapter === "milky" ? "milky-" : ""}${botId}${suffix}`);
    throw new Error("进程回执的机器人账号无效。");
  }

  async function claim(botId: number | undefined, adapter: ReceiptAdapter | undefined, slot: ReceiptSlot): Promise<ProcessReceipt | undefined> {
    const file = receiptPath(botId, adapter, slot);
    const claimed = join(directory, `.claim-${crypto.randomUUID()}`);
    try {
      await rename(file, claimed);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }

    try {
      const receipt = await readReceipt(claimed);
      if (!receipt || receiptSlot(receipt.kind) !== slot) return;
      const { target } = receipt;
      if (target.type === "terminal" ? botId !== undefined : target.botId !== botId || target.adapter !== adapter) return;
      const age = Date.now() - receipt.at;
      if (age >= -maxClockSkew && age <= maxAge) return receipt;
    } finally {
      await rm(claimed, { force: true });
    }
  }

  function take(botId?: number, adapter?: ReceiptAdapter): Promise<ProcessReceipt | undefined>;
  function take(botId: number | undefined, slot: ReceiptSlot): Promise<ProcessReceipt | undefined>;
  function take(botId?: number, adapter?: ReceiptAdapter | ReceiptSlot): Promise<ProcessReceipt | undefined> {
    if (adapter === true || adapter === false || adapter === "install") return claim(botId, undefined, adapter);
    return claim(botId, adapter, false);
  }

  return {
    async save(receipt: ProcessReceipt): Promise<void> {
      const value = receiptFrom(receipt);
      if (!value) throw new Error("进程回执无效。");
      const { target } = value;
      const slot = receiptSlot(value.kind);
      const file = target.type === "terminal" ? receiptPath(undefined, undefined, slot) : receiptPath(target.botId, target.adapter, slot);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const staged = join(directory, `.write-${crypto.randomUUID()}`);
      try {
        const handle = await open(staged, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify(value), "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(staged, file);
      } catch (error) {
        await rm(staged, { force: true }).catch(() => undefined);
        throw error;
      }
    },

    take,
    takeUpdate: (botId?: number, adapter?: ReceiptAdapter) => claim(botId, adapter, true),
    takeInstall: (botId?: number, adapter?: ReceiptAdapter) => claim(botId, adapter, "install"),
    async discard(botId?: number, adapter?: ReceiptAdapter): Promise<void> {
      await rm(receiptPath(botId, adapter, false), { force: true });
    },
  };
}
