import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { isInstallName } from "./install-command.ts";

export interface ManagedUpdateRequest {
  readonly requested?: string;
  readonly install?: string;
  readonly all?: boolean;
  readonly force?: boolean;
  readonly quiet: boolean;
  readonly target: { readonly type: "terminal" } |
    { readonly type: "group" | "private"; readonly botId: number; readonly id: number } |
    { readonly type: "scheduled"; readonly botIds: readonly number[]; readonly terminal: boolean };
  readonly directories: readonly { readonly name: string; readonly path: string; readonly packageName: string }[];
}

const progress = ["checking", "building", "switching", "busy", "current", "dirty", "ahead", "diverged",
  "rejected", "unavailable", "failed"] as const;
export type ManagedUpdateProgress = typeof progress[number];

const knownProgress: ReadonlySet<string> = new Set(progress);
const directoryName = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u;
const scopedName = /^@[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const requestId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const controls = /[\u0000-\u001f\u007f-\u009f]/u;
export const managedUpdateDirectoryLimit = 128;
export const managedUpdateScheduledBotLimit = 128;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function isManagedUpdateName(value: unknown): value is string {
  return typeof value === "string" && value.length <= 214 && value.trim() === value &&
    (directoryName.test(value) || scopedName.test(value));
}

export function isManagedPluginDirectory(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 255 && value !== "." && value !== ".." &&
    !/[/\\]/u.test(value) && !controls.test(value);
}

function parseTarget(value: unknown): ManagedUpdateRequest["target"] | undefined {
  if (!record(value)) return;
  const { type, botId, id } = value;
  if (type === "terminal") return { type };
  if ((type === "group" || type === "private") && positiveId(botId) && positiveId(id)) return { type, botId, id };
  if (type === "scheduled") {
    const { botIds, terminal } = value;
    if (!Array.isArray(botIds) || botIds.length > managedUpdateScheduledBotLimit || typeof terminal !== "boolean") return;
    const unique = new Set<number>();
    for (const id of botIds) {
      if (!positiveId(id) || unique.has(id)) return;
      unique.add(id);
    }
    return { type, botIds: [...unique], terminal };
  }
}

export function parseManagedUpdateRequest(value: unknown): ManagedUpdateRequest | undefined {
  if (!record(value)) return;
  const { requested, install, all, force, quiet, target, directories } = value;
  if ((all !== undefined && typeof all !== "boolean") || (force !== undefined && typeof force !== "boolean") ||
      (requested !== undefined && (all === true || !isManagedUpdateName(requested))) || typeof quiet !== "boolean" ||
      !Array.isArray(directories) || directories.length > managedUpdateDirectoryLimit) return;
  const recipient = parseTarget(target);
  if (!recipient) return;
  if (recipient.type === "scheduled" && (all !== true || quiet !== true || force === true)) return;
  if (install !== undefined && (!isInstallName(install) || install === "插件" || requested !== undefined ||
      all !== undefined || force !== undefined || quiet || recipient.type === "scheduled")) return;

  const plugins: ManagedUpdateRequest["directories"][number][] = [];
  const names = new Set<string>();
  for (const plugin of directories) {
    if (!record(plugin)) return;
    const { name, path, packageName } = plugin;
    if (!isManagedPluginDirectory(name) || names.has(name) ||
        typeof packageName !== "string" || packageName.length === 0 || packageName.length > 512 || controls.test(packageName) ||
        typeof path !== "string" || path.length > 4_096 || controls.test(path) || !isAbsolute(path) ||
        normalize(path) !== path || basename(dirname(path)) !== "plugins" || join(dirname(path), name) !== path) return;
    names.add(name);
    plugins.push({ name, path, packageName });
  }

  return {
    ...(requested === undefined ? {} : { requested }), ...(install === undefined ? {} : { install }),
    ...(all === undefined ? {} : { all }),
    ...(force === undefined ? {} : { force }),
    quiet, target: recipient, directories: plugins,
  };
}

export function isManagedUpdateRequestId(value: unknown): value is string {
  return typeof value === "string" && value.length === 36 && requestId.test(value);
}

export function isManagedUpdateProgress(value: unknown): value is ManagedUpdateProgress {
  return typeof value === "string" && knownProgress.has(value);
}

export function isTerminalManagedUpdateProgress(value: ManagedUpdateProgress): boolean {
  return value !== "checking" && value !== "building";
}
