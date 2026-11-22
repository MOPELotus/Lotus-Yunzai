import { isDeepStrictEqual } from "node:util";
import { watchConfigFiles } from "./config-watch.ts";
import { readOptionalConfigFile } from "./config.ts";

const otherPolicyPaths = ["config/other.yaml", "config/config/other.yaml"] as const;
type OtherConfig = Readonly<Record<string, unknown>>;
export type OtherPolicyFiles = readonly [primary: OtherConfig | undefined, legacy: OtherConfig | undefined];

async function readOtherPolicyFiles(root: URL) {
  const [primary, legacy] = otherPolicyPaths;
  return Promise.allSettled([readOptionalConfigFile(root, primary), readOptionalConfigFile(root, legacy)] as const);
}

export function otherPolicySetting([primary, legacy]: OtherPolicyFiles, key: string):
  { readonly primary: unknown } | { readonly legacy: OtherConfig } | undefined {
  if (primary && Object.hasOwn(primary, key)) return { primary: primary[key] };
  // TRSS applied the bundled deny lists before its runtime overlay.
  if (legacy) return { legacy: { blackGroup: [213_938_015], blackUser: [528_952_540], ...legacy, ...primary } };
}

export function requestAutomationSettings(files: OtherPolicyFiles) {
  const friend = otherPolicySetting(files, "autoFriend");
  const friendValue = friend && ("primary" in friend ? friend.primary :
    Object.hasOwn(friend.legacy, "autoFriend") ? friend.legacy.autoFriend : 1);
  const autoFriend = friendValue === 1 || friendValue === "1" ||
    (friendValue === true && !!friend && "legacy" in friend);
  const group = otherPolicySetting(files, "autoGroup");
  let autoGroup: "all" | "owners" | "off" = "off";
  if (group && "legacy" in group) autoGroup = group.legacy.autoGroup === 1 ? "all" : "owners";
  if (group && "primary" in group) {
    if (group.primary === 1 || group.primary === "1") autoGroup = "all";
    if (group.primary === 0 || group.primary === "0") autoGroup = "owners";
  }
  const quit = otherPolicySetting(files, "autoQuit");
  const quitValue = quit && ("primary" in quit ? quit.primary :
    Object.hasOwn(quit.legacy, "autoQuit") ? quit.legacy.autoQuit : 50);
  const threshold = typeof quitValue === "string" && /^\d+$/u.test(quitValue.trim()) ? Number(quitValue) : quitValue;
  const autoQuit = typeof threshold === "number" && Number.isSafeInteger(threshold) && threshold > 0 ? threshold : 0;
  return { autoFriend, autoGroup, autoQuit };
}

function initialOtherPolicyFiles([primary, legacy]: Awaited<ReturnType<typeof readOtherPolicyFiles>>): OtherPolicyFiles {
  if (primary.status === "rejected") throw primary.reason;
  if (legacy.status === "rejected" && !primary.value) throw legacy.reason;
  return [primary.value, legacy.status === "fulfilled" ? legacy.value : undefined];
}

export async function readRequestOtherPolicyFiles(root: URL) {
  return initialOtherPolicyFiles(await readOtherPolicyFiles(root));
}

export async function readRequestOtherPolicies(root: URL, watchSignal?: AbortSignal) {
  let current = await readRequestOtherPolicyFiles(root);
  let pending: Promise<void> | undefined;
  const warned = new Set<string>();

  async function reload() {
    const results = await readOtherPolicyFiles(root);
    if (watchSignal?.aborted) return;
    const read = (index: 0 | 1) => {
      const path = otherPolicyPaths[index];
      const result = results[index];
      if (result.status === "fulfilled") {
        warned.delete(path);
        return result.value;
      }
      if (!warned.has(path)) console.warn(`[请求策略] ${path} 重载失败，保留上次有效设置。`);
      warned.add(path);
      return current[index];
    };
    const next = [read(0), read(1)] as const;
    if (!isDeepStrictEqual(current, next)) current = next;
  }

  async function refresh(force = false) {
    if ((!watchSignal && !force) || watchSignal?.aborted) return;
    if (pending) await pending;
    if (!watchSignal?.aborted) return pending ??= reload().finally(() => { pending = undefined; });
  }

  if (watchSignal) watchConfigFiles(watchSignal, refresh,
    () => console.warn("[请求策略] other.yaml 重载失败，保留上次有效设置。"));
  return { current: () => current, refresh };
}

export type RequestOtherPolicies = Awaited<ReturnType<typeof readRequestOtherPolicies>>;
