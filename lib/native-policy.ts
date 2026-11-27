import { nativeProbeOutcome, needsBaselineBuild, type NativeCpu } from "./native-cpu.ts";

export const nativeComponents = {
  bun: { features: ["sse4_2"], probe: "runtime", source: false },
  tuneweave: { features: ["avx", "avx2"], probe: "provider-crypto", source: true },
  "skia-canvas": { features: [], probe: "canvas-png", source: true },
  sharp: { features: ["sse4_2"], probe: "image-encode", source: true },
  resvg: { features: [], probe: "svg-raster", source: true },
  onnxruntime: { features: [], probe: "tensor-inference", source: false },
  shotium: { features: [], probe: "html-raster", source: false },
  rolldown: { features: [], probe: "bundle", source: true },
  valkey: { features: [], probe: "server-command", source: true },
  ffmpeg: { features: [], probe: "media-encode", source: false },
} as const;

export type NativeComponent = keyof typeof nativeComponents;
export type NativeRoute = "prebuilt" | "source" | "probe" | "repair" | "blocked";

export function nativeSourceSupported(cpu: NativeCpu): boolean {
  if (cpu.platform !== "linux" || cpu.arch !== "x64" || cpu.system?.includes("non-glibc")) return false;
  const glibc = /(?:^|\n)glibc:(\d+)\.(\d+)/u.exec(cpu.system ?? "");
  return Boolean(glibc && (Number(glibc[1]) > 2 || Number(glibc[1]) === 2 && Number(glibc[2]) >= 28));
}

export function nativeRoute(component: NativeComponent, cpu: NativeCpu, input: {
  readonly sourceMode?: boolean;
  readonly code?: number;
  readonly timedOut?: boolean;
  readonly diagnostic?: string;
  readonly version?: string;
} = {}): NativeRoute {
  const policy = nativeComponents[component];
  const features = component === "tuneweave" && input.version && !["1.0.0-beta.3", "1.0.0-beta.4"].includes(input.version.replace(/^v/u, "")) ? [] : policy.features;
  const outcome = input.code === undefined ? undefined : nativeProbeOutcome(input.code, input.timedOut);
  const incompatible = outcome === "illegal-instruction" || /CPU ISA level is lower than required/iu.test(input.diagnostic ?? "");
  const requiresSource = input.sourceMode || needsBaselineBuild(cpu, features) || incompatible;
  if (requiresSource) return policy.source && nativeSourceSupported(cpu) ? "source" : "blocked";
  if (outcome === "ready") return "prebuilt";
  if (outcome !== undefined) return "repair";
  return "probe";
}
