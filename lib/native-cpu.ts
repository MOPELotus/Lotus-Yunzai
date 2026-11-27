import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

export interface NativeCpu {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly features: readonly string[];
  readonly known: boolean;
  readonly runtime?: string;
  readonly system?: string;
}

export function linuxCpuFeatures(cpuinfo: string): readonly string[] | undefined {
  const processors = [...cpuinfo.matchAll(/^(?:flags|Features)\s*:\s*(.+)$/gmu)]
    .map(match => new Set(match[1]!.trim().toLowerCase().split(/\s+/u)));
  if (!processors.length) return;
  // A heterogeneous machine must be safe on every schedulable core.
  return [...processors[0]!].filter(feature => processors.every(set => set.has(feature))).sort();
}

export async function detectNativeCpu({ platform = process.platform, arch = process.arch,
  read = () => readFile("/proc/cpuinfo", "utf8"),
}: { platform?: NodeJS.Platform; arch?: string; read?: () => Promise<string> } = {}): Promise<NativeCpu> {
  const features = platform === "linux" ? linuxCpuFeatures(await read().catch(() => "")) : undefined;
  const distribution = platform === "linux" ? await readFile("/etc/os-release", "utf8").catch(() => "unknown") : platform;
  let libc = "unknown";
  if (platform === process.platform && arch === process.arch) {
    try {
      const header = (process.report.getReport() as { header?: { glibcVersionRuntime?: string } }).header;
      libc = header?.glibcVersionRuntime ? `glibc:${header.glibcVersionRuntime}` : "non-glibc";
    } catch {}
  }
  return { platform, arch, features: features ?? [], known: features !== undefined,
    runtime: `${process.version}:${process.versions.bun ?? ""}:${process.versions.napi ?? ""}`, system: `${distribution}\n${libc}` };
}

export function nativeCpuFingerprint(cpu: NativeCpu) {
  return createHash("sha256").update(JSON.stringify([cpu.platform, cpu.arch, cpu.known, cpu.runtime, cpu.system, [...cpu.features].sort()])).digest("hex");
}

export function needsBaselineBuild(cpu: NativeCpu, requiredFeatures: readonly string[]) {
  if (cpu.arch !== "x64" || !cpu.known) return false;
  return requiredFeatures.some(feature => !cpu.features.includes(feature));
}

export type NativeProbeOutcome = "ready" | "illegal-instruction" | "failed" | "timeout";
export function nativeProbeOutcome(code: number, timedOut = false): NativeProbeOutcome {
  if (timedOut) return "timeout";
  if (code === 0) return "ready";
  return code === 132 || code === -4 ? "illegal-instruction" : "failed";
}

export function nativeBuildKey(component: string, version: string, source: string, cpu: NativeCpu) {
  return createHash("sha256").update(JSON.stringify([component, version, source, nativeCpuFingerprint(cpu)])).digest("hex");
}
