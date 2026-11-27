import { expect, test } from "bun:test";
import { nativeComponents, nativeRoute } from "../lib/native-policy.ts";
import type { NativeCpu } from "../lib/native-cpu.ts";

const old: NativeCpu = { platform: "linux", arch: "x64", known: true, system: "glibc:2.39", features: ["sse2", "sse4_2"] };
const modern = { ...old, features: [...old.features, "avx", "avx2"] };

test("CPU policy is per component and does not provision tools for compatible prebuilt packages", () => {
  expect(nativeRoute("tuneweave", old)).toBe("source");
  expect(nativeRoute("tuneweave", modern)).toBe("probe");
  expect(nativeRoute("tuneweave", old, { version: "1.0.0-beta.4", code: 0 })).toBe("source");
  expect(nativeRoute("tuneweave", old, { version: "1.0.0-beta.5", code: 0 })).toBe("prebuilt");
  expect(nativeRoute("tuneweave", old, { version: "1.0.0-beta.5", sourceMode: true })).toBe("source");
  for (const name of Object.keys(nativeComponents) as (keyof typeof nativeComponents)[]) {
    expect(nativeRoute(name, modern, { code: 0 })).toBe("prebuilt");
    if (name !== "tuneweave") expect(nativeRoute(name, old, { code: 0 })).toBe("prebuilt");
  }
});

test("probe failures do not invent CPU requirements or promise unsupported source builds", () => {
  expect(nativeRoute("skia-canvas", old, { code: 132 })).toBe("source");
  expect(nativeRoute("skia-canvas", old, { code: 1 })).toBe("repair");
  expect(nativeRoute("skia-canvas", old, { code: 132, timedOut: true })).toBe("repair");
  expect(nativeRoute("sharp", old, { code: 132 })).toBe("source");
  expect(nativeRoute("sharp", old, { code: 127, diagnostic: "CPU ISA level is lower than required" })).toBe("source");
  expect(nativeRoute("onnxruntime", old, { code: 132 })).toBe("blocked");
  expect(nativeRoute("skia-canvas", modern, { sourceMode: true })).toBe("source");
  expect(nativeRoute("skia-canvas", { ...old, known: false }, {})).toBe("probe");
  expect(nativeRoute("skia-canvas", { ...old, platform: "win32" }, { code: 132 })).toBe("blocked");
  expect(nativeRoute("skia-canvas", { ...old, system: "unknown" }, { code: 132 })).toBe("blocked");
  expect(nativeRoute("skia-canvas", { ...old, system: "glibc:2.17" }, { code: 132 })).toBe("blocked");
});
