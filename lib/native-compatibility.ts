import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { buildNativeArtifact, nativeSourceMode, rememberNativeSourceMode, type NativeBuildComponent } from "./native-build.ts";
import { nativeRoute, type NativeComponent } from "./native-policy.ts";
import { nativeHostFingerprint, type NativeCpu } from "./native-cpu.ts";
import { createTranslator } from "../packages/i18n/index.ts";
import catalog from "../i18n/zh-CN.json";
const $t = createTranslator("core", catalog.messages);

export interface NativeProbeResult { code: number; timedOut?: boolean; diagnostic?: string }

export async function prepareNativeComponent(options: {
  component: NativeComponent;
  version: string;
  cpu: NativeCpu;
  binary: string;
  cacheRoot: string;
  probe: () => Promise<NativeProbeResult>;
  build?: typeof buildNativeArtifact;
  progress?: (line: string) => void;
  signal?: AbortSignal;
}) {
  const { component, cpu, cacheRoot, binary, version, signal, progress, probe } = options;
  signal?.throwIfAborted();
  progress?.($t("lib.native-build.checking", { name: component }));
  const receipt = binary + ".source-mode.json", host = nativeHostFingerprint(cpu);
  const installedSource = await readFile(receipt, "utf8").then(text => {
    const state = JSON.parse(text); return state.format === 1 && state.component === component && state.host === host;
  }).catch(() => false);
  const sourceMode = installedSource || await nativeSourceMode(cacheRoot, component, cpu);
  const before = await probe();
  const route = nativeRoute(component, cpu, { ...before, sourceMode, version });
  if (route === "prebuilt") {
    progress?.($t("lib.native-build.prebuilt", { name: component, version }));
    return { route, changed: false } as const;
  }
  if (route === "blocked") throw new Error($t("lib.native-build.unsupported_source", { name: component, platform: cpu.platform, arch: cpu.arch }));
  if (route !== "source") throw new Error($t("lib.native-build.failed", { name: component, details: before.diagnostic ?? String(before.code) }));
  progress?.($t("lib.native-build.selected-source", { name: component, version }));
  await rememberNativeSourceMode(cacheRoot, component, cpu);
  const candidate = await (options.build ?? buildNativeArtifact)({ component: component as NativeBuildComponent, version, cpu, cacheRoot, signal, progress });
  const original = await readFile(binary).catch(() => undefined);
  if (original && original.equals(await readFile(candidate)) && before.code === 0 && !before.timedOut) return { route, changed: false } as const;
  await mkdir(dirname(binary), { recursive: true });
  const temporary = binary + ".native-" + randomUUID(), backup = binary + ".previous-" + randomUUID();
  let replaced = false, retained = false, accepted = false;
  try {
    await copyFile(candidate, temporary);
    await chmod(temporary, 0o700);
    signal?.throwIfAborted();
    if (original) { await rename(binary, backup); retained = true; }
    await rename(temporary, binary); replaced = true;
    const after = await probe();
    signal?.throwIfAborted();
    if (after.code !== 0 || after.timedOut) throw new Error($t("lib.native-build.failed", { name: component, details: after.diagnostic ?? String(after.code) }));
    const temporaryReceipt = receipt + ".part-" + randomUUID();
    try {
      await writeFile(temporaryReceipt, JSON.stringify({ format: 1, component, host }), { mode: 0o600 });
      await rename(temporaryReceipt, receipt);
    } finally { await rm(temporaryReceipt, { force: true }); }
    accepted = true;
    return { route, changed: true } as const;
  } catch (error) {
    if (replaced) await rm(binary, { force: true });
    if (retained) { await rename(backup, binary); retained = false; }
    throw error;
  } finally {
    await rm(temporary, { force: true });
    if (accepted && retained) await rm(backup, { force: true });
  }
}
