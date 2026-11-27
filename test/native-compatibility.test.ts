import { test, expect } from "bun:test";
import { link, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareNativeComponent } from "../lib/native-compatibility.ts";
import type { NativeCpu } from "../lib/native-cpu.ts";
import { hasNativeSourceMode, nativeSourceMode, rememberNativeSourceMode } from "../lib/native-build.ts";

const cpu: NativeCpu = { platform: "linux", arch: "x64", known: true, system: "glibc:2.39", features: ["sse2"] };
test("compatible components do not create compiler directories or call builders on old CPUs", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-native-ready-"));
  try {
    const result = await prepareNativeComponent({ component: "skia-canvas", version: "4.0.1", cpu, binary: join(root, "binary"), cacheRoot: join(root, "cache"),
      probe: async () => ({ code: 0 }), build: async () => { throw Error("must not provision tools"); } });
    expect(result).toEqual({ route: "prebuilt", changed: false });
    expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("source preference survives runtime updates but does not transfer to a different CPU", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-native-mode-"));
  try {
    expect(await hasNativeSourceMode(root, cpu)).toBe(false);
    await rememberNativeSourceMode(root, "skia-canvas", cpu);
    expect(await hasNativeSourceMode(root, { ...cpu, runtime: "updated" })).toBe(true);
    expect(await nativeSourceMode(root, "skia-canvas", { ...cpu, runtime: "updated" })).toBe(true);
    expect(await nativeSourceMode(root, "resvg", cpu)).toBe(false);
    expect(await hasNativeSourceMode(root, { ...cpu, features: [...cpu.features, "avx2"] })).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("incompatible component replacement rolls back a failed probe without mutating hardlinked originals", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-native-rollback-"));
  const binary = join(root, "binary"), candidate = join(root, "candidate"), original = join(root, "original");
  await writeFile(original, "original"); await link(original, binary); await writeFile(candidate, "built");
  let calls = 0;
  try {
    await expect(prepareNativeComponent({ component: "skia-canvas", version: "4.0.1", cpu, binary, cacheRoot: join(root, "cache"),
      probe: async () => ({ code: ++calls === 1 ? 132 : 1, diagnostic: "fixture probe" }), build: async () => candidate })).rejects.toThrow("fixture probe");
    expect(await readFile(binary, "utf8")).toBe("original");
    expect(await readFile(original, "utf8")).toBe("original");
    expect((await readdir(root)).sort()).toEqual(["binary", "cache", "candidate", "original"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("installed source receipt preserves the build route when the compiler cache has been removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-native-recover-"));
  const binary = join(root, "binary"), candidate = join(root, "candidate"), cacheRoot = join(root, "cache");
  await writeFile(binary, "original"); await writeFile(candidate, "built");
  let builds = 0, probes = 0;
  const options = { component: "skia-canvas" as const, version: "4.0.1", cpu, binary, cacheRoot,
    build: async () => { builds++; return candidate; }, probe: async () => ({ code: ++probes % 2 ? 132 : 0 }) };
  try {
    await prepareNativeComponent(options);
    await rm(cacheRoot, { recursive: true, force: true });
    probes = 0;
    const repaired = await prepareNativeComponent({ ...options, probe: async () => ({ code: ++probes === 1 ? 1 : 0 }) });
    expect(repaired).toEqual({ route: "source", changed: true });
    expect(builds).toBe(2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
