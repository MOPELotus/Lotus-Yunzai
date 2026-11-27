import type { AppliedUpdateReport } from "./update-report.ts";
import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { constants } from "node:fs";
import { link, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isInstallName } from "./install-command.ts";
import { isGitRevision } from "./local-git.ts";

type ReceiptAdapter = "milky";
type ReceiptAccount = { readonly botId: number; readonly adapter?: ReceiptAdapter };
type ReceiptTarget =
  | { readonly type: "terminal" }
  | (ReceiptAccount & { readonly type: "masters"; readonly pendingUsers?: readonly number[] })
  | (ReceiptAccount & { readonly type: "group" | "private"; readonly id: number });

type ProcessOrUpdate = { readonly target: ReceiptTarget } & (
  | { readonly kind: "stop" | "restart" }
  | { readonly kind: "update"; readonly result: "updated"; readonly revision: string; readonly repositories?: number; readonly preserved?: true; readonly reports?: readonly AppliedUpdateReport[] }
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
const maxFileBytes = 256 * 1024;

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function processReceiptUsers(value: unknown): number[] | undefined {
  if (Array.isArray(value) && value.length > 0 && value.every(positiveInteger)) return [...new Set(value)];
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
    const reports = value.reports === undefined ? undefined : parseUpdateReports(value.reports);
    if (value.reports !== undefined && !reports) return;
    return { kind, at, target: session, result: value.result, revision: value.revision,
      ...(reports ? { reports } : {}),
      ...(repositories === undefined ? {} : { repositories }),
      ...(value.preserved ? { preserved: true } : {}) };
  }
}

function parseUpdateReports(value: unknown): AppliedUpdateReport[] | undefined {
  if (!Array.isArray(value) || value.length > 129) return;
  const reports: AppliedUpdateReport[] = [], names = new Set<string>();
  let bytes = 0;
  for (const item of value) {
    if (!isRecord(item) || typeof item.name !== "string" ||
        !/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,127}$/u.test(item.name) || names.has(item.name) ||
        typeof item.date !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(item.date) ||
        !Array.isArray(item.lines) || item.lines.length > 100) return;
    const lines: string[] = [];
    for (const line of item.lines) {
      if (typeof line !== "string" || line.length > 600 || /[\u0000-\u001f\u007f-\u009f]/u.test(line)) return;
      bytes += Buffer.byteLength(line);
      if (bytes > 96 * 1024) return;
      lines.push(line);
    }
    names.add(item.name);
    reports.push({ name: item.name, date: item.date, lines });
  }
  return reports;
}

function receiptTarget(target: Record<string, unknown>): ProcessReceipt["target"] | undefined {
  const { type, botId, id, adapter, pendingUsers } = target;
  if (type === "terminal") return adapter === undefined ? { type } : undefined;
  if (!positiveInteger(botId) || (adapter !== undefined && adapter !== "milky")) return;
  const account: ReceiptAccount = adapter === undefined ? { botId } : { botId, adapter };
  if (type === "masters") {
    if (pendingUsers === undefined) return { type, ...account };
    const users = processReceiptUsers(pendingUsers);
    return users && { type, ...account, pendingUsers: users };
  }
  if ((type === "group" || type === "private") && positiveInteger(id)) {
    return { type, ...account, id };
  }
}

function receiptSlot(kind: ProcessReceipt["kind"]): ReceiptSlot {
  return kind === "install" ? kind : kind === "update";
}

function isFresh(receipt: ProcessReceipt) {
  const age = Date.now() - receipt.at;
  return age >= -maxClockSkew && age <= maxAge;
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
      throw new Error($t("lib.process-receipts.text_d073f11fc2"));
    }
    if (botId === undefined) return join(directory, `terminal${suffix}`);
    if (positiveInteger(botId)) return join(directory, `${adapter === "milky" ? "milky-" : ""}${botId}${suffix}`);
    throw new Error($t("lib.process-receipts.text_4171ad36a0"));
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
      if (isFresh(receipt)) return receipt;
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

  async function write(receipt: ProcessReceipt, retry: boolean): Promise<void> {
    const value = receiptFrom(receipt);
    if (!value) throw new Error($t("lib.process-receipts.text_aa7d61e34a"));
    if (retry && !isFresh(value)) return;
    const content = JSON.stringify(value);
    if (Buffer.byteLength(content) > maxFileBytes) throw new Error($t("lib.process-receipts.text_b2f3c87708"));
    const { target } = value;
    const slot = receiptSlot(value.kind);
    const file = target.type === "terminal" ? receiptPath(undefined, undefined, slot) : receiptPath(target.botId, target.adapter, slot);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const staged = join(directory, `.write-${crypto.randomUUID()}`);
    try {
      const handle = await open(staged, "wx", 0o600);
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (retry) {
        await link(staged, file).catch(error => {
          if (errorCode(error) !== "EEXIST") throw error;
        });
      } else {
        await rename(staged, file);
      }
    } finally {
      await rm(staged, { force: true }).catch(() => undefined);
    }
  }

  return {
    save: (receipt: ProcessReceipt) => write(receipt, false),
    restore: (receipt: ProcessReceipt) => write(receipt, true),
    take,
    takeUpdate: (botId?: number, adapter?: ReceiptAdapter) => claim(botId, adapter, true),
    takeInstall: (botId?: number, adapter?: ReceiptAdapter) => claim(botId, adapter, "install"),
    async discard(botId?: number, adapter?: ReceiptAdapter): Promise<void> {
      await rm(receiptPath(botId, adapter, false), { force: true });
    },
  };
}
