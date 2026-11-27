import { mkdir, readFile, writeFile, copyFile, rename, rm, chmod, symlink, readdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lockFile } from "./file-lock.ts";
import { prepareNativeToolchain, nativeToolchainIdentity, type NativeTools } from "./native-toolchain.ts";
import { runNativeCommand } from "./native-process.ts";
import { nativeBuildKey, nativeHostFingerprint, type NativeCpu } from "./native-cpu.ts";
import { createTranslator } from "../packages/i18n/index.ts";
import catalog from "../i18n/zh-CN.json";
import { buildSharpArtifact } from "./native-sharp-build.ts";
import { nativeSourceSupported } from "./native-policy.ts";
const $t = createTranslator("core", catalog.messages);

export type NativeBuildComponent = "tuneweave" | "skia-canvas" | "valkey" | "resvg" | "rolldown" | "sharp";
const recipes = {
  tuneweave: { repo: "https://github.com/MOPELotus/TuneWeave.git", output: "target/release/tuneweave",
    command: ["cargo", "build", "--release", "--locked", "--package", "tuneweave-server", "--bin", "tuneweave"] },
  "skia-canvas": { repo: "https://github.com/samizdatco/skia-canvas.git", output: "target/release/libskia_canvas.so",
    command: ["cargo", "build", "--release", "--locked", "--features", "vulkan,freetype"] },
  valkey: { repo: "https://github.com/valkey-io/valkey.git", output: "src/valkey-server",
    command: ["make", "-j2", "CC=clang", "MALLOC=libc", "BUILD_TLS=no", "OPTIMIZATION=-O2", "valkey-server"] },
  resvg: { repo: "https://github.com/yisibl/resvg-js.git", output: "target/release/libresvg_js.so",
    command: ["cargo", "build", "--release", "--locked"] },
  rolldown: { repo: "https://github.com/rolldown/rolldown.git", output: "target/release/librolldown_binding.so",
    command: ["cargo", "build", "--release", "--locked", "--package", "rolldown_binding"] },
} as const;
const recipeVersion = "baseline-3";

export function nativeBuildCacheRoot() {
  return resolve(fileURLToPath(new URL("../", import.meta.url)), process.env.LOTUS_NATIVE_BUILD_ROOT?.trim() || "data/native-build");
}

export function unsupportedNativeSource(component: string, cpu: NativeCpu) {
  return new Error($t("lib.native-build.unsupported_source", { name: component, platform: cpu.platform, arch: cpu.arch }));
}

export async function nativeSourceMode(cacheRoot: string, component: string, cpu: NativeCpu) {
  return readFile(join(cacheRoot, "modes", `${component}-${nativeHostFingerprint(cpu)}.json`), "utf8")
    .then(text => JSON.parse(text).mode === "source").catch(() => false);
}

export async function hasNativeSourceMode(cacheRoot: string, cpu: NativeCpu) {
  const directory = join(cacheRoot, "modes"), suffix = `-${nativeHostFingerprint(cpu)}.json`;
  const files = await readdir(directory).catch(() => []);
  for (const file of files) {
    if (file.endsWith(suffix) && await readFile(join(directory, file), "utf8").then(text => JSON.parse(text).mode === "source").catch(() => false)) return true;
  }
  return false;
}

export async function rememberNativeSourceMode(cacheRoot: string, component: string, cpu: NativeCpu) {
  await mkdir(join(cacheRoot, "modes"), { recursive: true, mode: 0o700 });
  const file = join(cacheRoot, "modes", `${component}-${nativeHostFingerprint(cpu)}.json`);
  const temporary = file + ".part-" + randomUUID();
  try { await writeFile(temporary, JSON.stringify({ mode: "source", component, cpu }), { mode: 0o600 }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}

export async function buildNativeArtifact(options: {
  readonly component: NativeBuildComponent;
  readonly version: string;
  readonly cpu: NativeCpu;
  readonly cacheRoot: string;
  readonly signal?: AbortSignal;
  readonly progress?: (line: string) => void;
  readonly tools?: NativeTools;
}): Promise<string> {
  const { component, cpu, cacheRoot, signal, progress } = options;
  if (!nativeSourceSupported(cpu)) throw unsupportedNativeSource(component, cpu);
  if (component === "sharp") return (await buildSharpArtifact(options)).file;
  const version = options.version.replace(/^v/u, "");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/u.test(version)) throw new TypeError("version");
  const recipe = recipes[component];
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const lock = await lockFile(join(cacheRoot, `${component}.sqlite`), $t("lib.native-build.busy"), 60_000);
  const fail = (details: string) => new Error($t("lib.native-build.failed", { name: component, details }));
  const env = { ...process.env, CARGO_HOME: join(cacheRoot, "cargo"), CARGO_BUILD_JOBS: "2",
    CARGO_TARGET_DIR: join(cacheRoot, "targets", component), FORCE_SKIA_BUILD: "1",
    RUSTFLAGS: "-C target-cpu=x86-64", CFLAGS: "-march=x86-64 -mtune=generic", CXXFLAGS: "-march=x86-64 -mtune=generic",
    GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const source = join(cacheRoot, "sources", component, version);
  const temporary = source + ".prepare-" + randomUUID();
  try {
    signal?.throwIfAborted();
    progress?.($t("lib.native-build.source", { name: component }));
    let revision = await readFile(join(source, ".lotus-source.json"), "utf8").then(text => {
      const state = JSON.parse(text); return state.repo === recipe.repo && state.version === version && /^[a-f0-9]{40}$/u.test(state.revision) ? state.revision as string : undefined;
    }).catch(() => undefined);
    if (!revision) {
      await mkdir(join(cacheRoot, "sources", component), { recursive: true });
      let cloned = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        await rm(temporary, { recursive: true, force: true });
        const result = await runNativeCommand(["git", "-c", "core.hooksPath=/dev/null", "clone", "--depth=1", "--single-branch", "--branch", `${component === "valkey" ? "" : "v"}${version}`, recipe.repo, temporary],
          { cwd: cacheRoot, env, signal, progress, timeoutMs: 10 * 60_000 });
        if (result.code === 0) { cloned = true; break; }
        if (attempt === 2) throw fail(result.diagnostic);
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      }
      if (!cloned) throw fail("Git clone");
      const head = await runNativeCommand(["git", "rev-parse", "HEAD"], { cwd: temporary, env, signal });
      revision = head.stdout.trim();
      if (head.code !== 0 || !/^[a-f0-9]{40}$/u.test(revision)) throw fail(head.diagnostic);
      await writeFile(join(temporary, ".lotus-source.json"), JSON.stringify({ repo: recipe.repo, version, revision }), { mode: 0o600 });
      await rm(source, { recursive: true, force: true });
      await rename(temporary, source);
    }
    const rustManifest = await readFile(join(source, "Cargo.toml"), "utf8").catch(() => "");
    const rustToolchain = await readFile(join(source, "rust-toolchain.toml"), "utf8").catch(() => "");
    const rustVersions = [rustManifest.match(/^rust-version\s*=\s*"(\d+\.\d+(?:\.\d+)?)"/mu)?.[1],
      rustToolchain.match(/^channel\s*=\s*"(\d+\.\d+(?:\.\d+)?)"/mu)?.[1]].filter((value): value is string => Boolean(value));
    rustVersions.sort((a, b) => {
      const left = a.split(".").map(Number), right = b.split(".").map(Number);
      for (let index = 0; index < 3; index++) { const difference = (right[index] ?? 0) - (left[index] ?? 0); if (difference) return difference; }
      return 0;
    });
    const requiredPackages = rustVersions.length ? [`rust>=${rustVersions[0]}`] : [];
    const prepareTools = () => prepareNativeToolchain(join(cacheRoot, "toolchain"), { signal, progress, packages: requiredPackages });
    let tools = options.tools;
    let cargoLock = await readFile(join(source, "Cargo.lock")).catch(() => undefined);
    if (component === "resvg" && !cargoLock) {
      tools ??= await prepareTools();
      const generated = await tools.run(["cargo", "generate-lockfile"], { cwd: source, env, signal, progress, timeoutMs: 10 * 60_000 });
      if (generated.code !== 0 || generated.timedOut) throw fail(generated.diagnostic);
      cargoLock = await readFile(join(source, "Cargo.lock"));
    }
    const dependencyLock = cargoLock ? createHash("sha256").update(cargoLock).digest("hex") : "none";
    const key = nativeBuildKey(component, version, `${recipe.repo}:${revision}:${recipeVersion}:${cacheRoot}:${nativeToolchainIdentity}:${options.tools?.prefix ?? "managed"}:${dependencyLock}:${requiredPackages.join(",")}`, cpu);
    const destination = join(cacheRoot, "artifacts", component, key);
    const file = join(destination, "binary");
    const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    const cached = await readFile(join(destination, "build.json"), "utf8").then(async text => {
      const state = JSON.parse(text); return state.key === key && state.sha256 === digest(await readFile(file));
    }).catch(() => false);
    if (cached) { progress?.($t("lib.native-build.cached", { name: component })); return file; }
    progress?.($t("lib.native-build.building", { name: component, version }));
    tools ??= await prepareTools();
    if (component === "valkey") {
      const clean = await tools.run(["make", "distclean"], { cwd: source, env, signal, progress, timeoutMs: 60_000 });
      if (clean.code !== 0) throw fail(clean.diagnostic);
    }
    const headers = join(cacheRoot, "headers", component);
    if (component === "skia-canvas") {
      await mkdir(headers, { recursive: true });
      await rm(join(headers, "fontconfig"), { recursive: true, force: true });
      await symlink(join(tools.prefix, "include/fontconfig"), join(headers, "fontconfig"));
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      let networkFailure = false;
      const command = component === "skia-canvas"
        ? ["env", `PKG_CONFIG_PATH=${join(tools.prefix, "lib/pkgconfig")}`, "PKG_CONFIG_SYSROOT_DIR=", `LIBCLANG_PATH=${join(tools.prefix, "lib")}`,
          `CPATH=${headers}`, `LIBRARY_PATH=${join(tools.prefix, "lib")}`, ...recipe.command]
        : [...recipe.command];
      const result = await tools.run(command, { cwd: source, env, signal,
        progress: line => {
          networkFailure ||= /gnutls|TLS.*(?:error|failed)|SSL.*(?:error|EOF)|Could not resolve|failed to download|spurious network|unable to access/iu.test(line);
          progress?.(line);
        }, timeoutMs: 6 * 60 * 60_000 });
      if (result.code === 0 && !result.timedOut) break;
      if (!networkFailure || attempt === 2 || result.timedOut) throw fail(result.diagnostic);
      signal?.throwIfAborted();
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
    if (component === "tuneweave") {
      progress?.($t("lib.native-build.probe", { name: component }));
      const testDirectory = join(source, "crates/tuneweave-provider-bilibili/tests");
      await mkdir(testDirectory, { recursive: true });
      await writeFile(join(testDirectory, "lotus_native_cpu.rs"), `use aws_lc_rs::{digest, hmac};
#[test] fn native_cpu_known_vectors() {
assert_eq!(hex::encode(digest::digest(&digest::SHA256, b"abc").as_ref()), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
let key = hmac::Key::new(hmac::HMAC_SHA256, &[0x0b; 20]);
assert_eq!(hex::encode(hmac::sign(&key, b"Hi There").as_ref()), "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
}`);
      const checked = await tools.run(["cargo", "test", "--release", "--locked", "--package", "tuneweave-provider-bilibili", "--test", "lotus_native_cpu"],
        { cwd: source, env, signal, progress, timeoutMs: 2 * 60 * 60_000 });
      if (checked.code !== 0 || checked.timedOut) throw fail(checked.diagnostic);
    }
    const built = recipe.output.startsWith("target/") ? join(env.CARGO_TARGET_DIR, recipe.output.slice("target/".length))
      : join(source, recipe.output);
    await mkdir(destination, { recursive: true, mode: 0o700 });
    const candidate = file + ".part-" + randomUUID();
    try {
      await copyFile(built, candidate); await chmod(candidate, 0o700); signal?.throwIfAborted();
      await rename(candidate, file);
      await writeFile(join(destination, "build.json"), JSON.stringify({ key, version, revision, cpu, recipeVersion,
        dependencyLock, requiredPackages, toolchain: nativeToolchainIdentity, toolchainPrefix: tools.prefix,
        sha256: digest(await readFile(file)) }), { mode: 0o600 });
    } finally { await rm(candidate, { force: true }); }
    return file;
  } finally { lock.close(); await rm(temporary, { recursive: true, force: true }); }
}
