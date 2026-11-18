import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isGitRevision } from "./local-git.ts";

export type ProcessReceipt = {
  readonly at: number;
  readonly target:
    | { readonly type: "terminal" }
    | { readonly type: "masters"; readonly botId: number }
    | { readonly type: "group" | "private"; readonly botId: number; readonly id: number };
} & (
  | { readonly kind: "stop" | "restart" }
  | { readonly kind: "update"; readonly result: "updated"; readonly revision: string; readonly repositories?: number; readonly preserved?: true }
  | { readonly kind: "update"; readonly result: "rolled-back" }
);

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
  const { type, botId, id } = target;
  if (type === "terminal") return { type };
  if (!positiveInteger(botId)) return;
  if (type === "masters") return { type, botId };
  if ((type === "group" || type === "private") && positiveInteger(id)) {
    return { type, botId, id };
  }
}

function targetBotId(receipt: ProcessReceipt): number | undefined {
  return receipt.target.type === "terminal" ? undefined : receipt.target.botId;
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

  function receiptPath(botId?: number, update = false): string {
    const suffix = update ? ".update.json" : ".json";
    if (botId === undefined) return join(directory, `terminal${suffix}`);
    if (positiveInteger(botId)) return join(directory, `${botId}${suffix}`);
    throw new Error("进程回执的机器人账号无效。");
  }

  return {
    async save(receipt: ProcessReceipt): Promise<void> {
      const value = receiptFrom(receipt);
      if (!value) throw new Error("进程回执无效。");
      const file = receiptPath(targetBotId(value), value.kind === "update");
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

    async take(botId?: number, update = false): Promise<ProcessReceipt | undefined> {
      const file = receiptPath(botId, update);
      const claimed = join(directory, `.claim-${crypto.randomUUID()}`);
      try {
        await rename(file, claimed);
      } catch (error) {
        if (errorCode(error) === "ENOENT") return;
        throw error;
      }

      try {
        const receipt = await readReceipt(claimed);
        if (!receipt || targetBotId(receipt) !== botId || (receipt.kind === "update") !== update) return;
        const age = Date.now() - receipt.at;
        if (age >= -maxClockSkew && age <= maxAge) return receipt;
      } finally {
        await rm(claimed, { force: true });
      }
    },

    async discard(botId?: number): Promise<void> {
      await rm(receiptPath(botId), { force: true });
    },
  };
}
