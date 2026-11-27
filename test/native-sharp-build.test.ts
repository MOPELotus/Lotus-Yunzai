import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSharpArtifact, sharpLibvipsVersion } from "../lib/native-sharp-build.ts";

test("Sharp uses its declared libvips minimum instead of a fixed npm prebuilt version", () => {
  expect(sharpLibvipsVersion({ libvips: ">=8.18.7" })).toBe("8.18.7");
  expect(sharpLibvipsVersion({ libvips: ">=8.19.1" })).toBe("8.19.1");
  for (const libvips of ["8.18.7", ">=8.18.7 || true", ">=8.18.7;exit", undefined]) {
    expect(() => sharpLibvipsVersion({ libvips })).toThrow();
  }
});

test("unsupported source targets and untrusted versions fail before creating a toolchain", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-sharp-build-test-"));
  try {
    const options = { version: "0.35.5", cpu: { platform: "linux", arch: "x64", known: true, features: [], system: "glibc:2.36" } as const, cacheRoot: root };
    await expect(buildSharpArtifact({ ...options, version: "0.35.5/../../untrusted" })).rejects.toThrow("sharp.version");
    await expect(buildSharpArtifact({ ...options, cpu: { ...options.cpu, arch: "arm64" } })).rejects.toThrow("sharp.platform");
    for (const system of ["non-glibc", "glibc:2.17", "unknown"]) {
      await expect(buildSharpArtifact({ ...options, cpu: { ...options.cpu, system } })).rejects.toThrow("sharp.platform");
    }
    expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rebuilds preserve published libraries and resume only unpublished attempts", async () => {
  const { nativeBuildKey } = await import("../lib/native-cpu.ts");
  const { nativeToolchainIdentity } = await import("../lib/native-toolchain.ts");
  const { sharpToolchainPackages } = await import("../lib/native-sharp-build.ts");
  const { mkdir, writeFile, readFile } = await import("node:fs/promises");
  const { execFileSync } = await import("node:child_process");
  const { createHash } = await import("node:crypto");
  const cacheRoot = await mkdtemp(join(tmpdir(), "lotus-sharp-publish-test-"));
  const cpu = { platform: "linux", arch: "x64", known: true, features: [], system: "glibc:2.36" } as const;
  const key = nativeBuildKey("sharp", "0.35.5", `source-vips-1:${nativeToolchainIdentity}:${cacheRoot}:${sharpToolchainPackages.join(",")}`, cpu);
  const root = join(cacheRoot, "sharp", key), prefix = join(root, "runtime"), source = join(root, "sharp");
  const file = join(source, "src/build/Release/sharp-linux-x64-0.35.5.node");
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  const seen: string[] = [];
  const tools = { prefix: "/unused", manager: "/unused", async run(argv: readonly string[]) {
    seen.push(argv.find(value => value.startsWith("--prefix="))!.slice(9));
    throw new Error("interrupted-build");
  } };
  try {
    for (const [name, repo, tag] of [["sharp", "lovell/sharp", "v0.35.5"], ["vips", "libvips/libvips", "v8.18.7"], ["cgif", "dloebl/cgif", "v0.5.4"]] as const) {
      const directory = join(root, name); await mkdir(directory, { recursive: true });
      const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-C", directory, ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
      git("init"); await writeFile(join(directory, "package.json"), JSON.stringify({ version: "0.35.5", config: { libvips: ">=8.18.7" } }));
      git("add", "package.json"); git("commit", "-m", "fixture"); git("tag", tag);
      await writeFile(join(directory, ".lotus-source.json"), JSON.stringify({ repo: `https://github.com/${repo}.git`, tag, revision: git("rev-parse", "HEAD") }));
    }
    await mkdir(join(prefix, "lib"), { recursive: true }); await writeFile(join(prefix, "lib/libvips.so.42"), "published-library");
    await mkdir(join(source, "src/build/Release"), { recursive: true }); await writeFile(file, "published-binding");
    const manifest = JSON.stringify({ key, file, prefix, packageDirectory: source, libvipsVersion: "8.18.7", verified: "formats-v1", binding: sha("published-binding"), libraries: [{ name: "libvips.so.42", sha256: sha("published-library") }] });
    await writeFile(join(root, "artifact.json"), manifest);
    expect((await buildSharpArtifact({ version: "0.35.5", cpu, cacheRoot, tools })).file).toBe(file);
    expect(seen).toEqual([]);
    const invalid = JSON.stringify({ ...JSON.parse(manifest), binding: "invalid" }); await writeFile(join(root, "artifact.json"), invalid);
    const fail = () => expect(buildSharpArtifact({ version: "0.35.5", cpu, cacheRoot, tools })).rejects.toThrow("interrupted-build");
    await fail(); await fail();
    expect(seen[0]).not.toBe(prefix); expect(seen[0]).toBe(seen[1]);
    expect(await readFile(join(root, "artifact.json"), "utf8")).toBe(invalid);
    expect(await readFile(file, "utf8")).toBe("published-binding");
    expect(await readFile(join(prefix, "lib/libvips.so.42"), "utf8")).toBe("published-library");
    await writeFile(join(seen[0]!, "..", "sealed.json"), "{}");
    await fail(); expect(seen[2]).not.toBe(seen[0]);
    expect(await readFile(join(prefix, "lib/libvips.so.42"), "utf8")).toBe("published-library");
  } finally { await rm(cacheRoot, { recursive: true, force: true }); }
});
