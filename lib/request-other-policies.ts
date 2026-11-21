import { isDeepStrictEqual } from "node:util";
import { watchConfigFiles } from "./config-watch.ts";
import { readOptionalConfigFile } from "./config.ts";

const otherPolicyPaths = ["config/other.yaml", "config/config/other.yaml"] as const;
type OtherConfig = Readonly<Record<string, unknown>>;
type OtherPolicyFiles = readonly [primary: OtherConfig | undefined, legacy: OtherConfig | undefined];

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

function initialOtherPolicyFiles([primary, legacy]: Awaited<ReturnType<typeof readOtherPolicyFiles>>): OtherPolicyFiles {
  if (primary.status === "rejected") throw primary.reason;
  if (legacy.status === "rejected" && !primary.value) throw legacy.reason;
  return [primary.value, legacy.status === "fulfilled" ? legacy.value : undefined];
}

export async function readRequestOtherPolicies(root: URL, watchSignal?: AbortSignal) {
  let current = initialOtherPolicyFiles(await readOtherPolicyFiles(root));
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
