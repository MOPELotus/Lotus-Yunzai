import { expect, test } from "bun:test";
import { detectNativeCpu, linuxCpuFeatures, nativeBuildKey, nativeCpuFingerprint, nativeHostFingerprint, nativeProbeOutcome, needsBaselineBuild } from "../lib/native-cpu.ts";

test("CPU flags are intersected across cores and unavailable data does not invent capabilities", async () => {
  expect(linuxCpuFeatures("processor: 0\nflags : sse2 avx avx2\nprocessor: 1\nflags : sse2 avx\n")).toEqual(["avx", "sse2"]);
  expect(linuxCpuFeatures("unavailable")).toBeUndefined();
  expect((await detectNativeCpu({ platform: "linux", arch: "x64", read: async () => { throw Error("denied"); } })).known).toBe(false);
});

test("modern hosts keep prebuilt mode while N5000 and AVX-only CPUs select only incompatible components", async () => {
  const cpu = (flags: string) => detectNativeCpu({ platform: "linux", arch: "x64", read: async () => `flags : ${flags}` });
  const modern = await cpu("sse2 sse4_2 avx avx2 bmi1 bmi2");
  expect(needsBaselineBuild(modern, ["avx", "avx2"])).toBe(false);
  expect(needsBaselineBuild(await cpu("sse2 sse4_2"), ["avx"])).toBe(true);
  expect(needsBaselineBuild(await cpu("sse2 avx"), ["avx2"])).toBe(true);
  expect(needsBaselineBuild(await cpu("sse2 sse4_2"), [])).toBe(false);
  expect(needsBaselineBuild({ ...modern, arch: "arm64" }, ["avx2"])).toBe(false);
});

test("cache identity includes version, source and CPU; SIGILL stays distinct from missing files and timeouts", async () => {
  const cpu = await detectNativeCpu({ platform: "linux", arch: "x64", read: async () => "flags : sse2 avx2 avx" });
  expect(nativeCpuFingerprint(cpu)).toBe(nativeCpuFingerprint({ ...cpu, features: [...cpu.features].reverse() }));
  const key = nativeBuildKey("skia", "4.0.1", "sha-a", cpu);
  expect(nativeBuildKey("skia", "4.0.2", "sha-a", cpu)).not.toBe(key);
  expect(nativeBuildKey("skia", "4.0.1", "sha-b", cpu)).not.toBe(key);
  expect(nativeBuildKey("skia", "4.0.1", "sha-a", { ...cpu, features: ["sse2"] })).not.toBe(key);
  expect([0, 132, -4, 1].map(code => nativeProbeOutcome(code))).toEqual(["ready", "illegal-instruction", "illegal-instruction", "failed"]);
  expect(nativeProbeOutcome(132, true)).toBe("timeout");
  expect(nativeHostFingerprint(cpu)).toBe(nativeHostFingerprint({ ...cpu, runtime: "new-runtime" }));
  expect(nativeCpuFingerprint(cpu)).not.toBe(nativeCpuFingerprint({ ...cpu, runtime: "new-runtime" }));
  expect(nativeHostFingerprint(cpu)).not.toBe(nativeHostFingerprint({ ...cpu, features: ["sse2"] }));
});
