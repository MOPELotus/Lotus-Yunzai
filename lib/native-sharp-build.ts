import { mkdir, readFile, writeFile, rename, rm, readdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, relative, resolve, sep, isAbsolute } from "node:path";
import { lockFile } from "./file-lock.ts";
import { nativeBuildKey, type NativeCpu } from "./native-cpu.ts";
import { runNativeCommand } from "./native-process.ts";
import { prepareNativeToolchain, nativeToolchainIdentity, type NativeTools } from "./native-toolchain.ts";

export const sharpToolchainPackages = ["meson", "glib", "expat", "libjpeg-turbo", "libpng", "libtiff", "libwebp", "giflib", "libheif", "librsvg", "lcms2", "libexif", "libarchive", "zlib", "libffi", "libxml2-devel", "libimagequant"] as const;
export interface SharpBuildArtifact { readonly file: string; readonly prefix: string; readonly packageDirectory: string; readonly libvipsVersion: string; }
export interface SharpBuildOptions {
  readonly version: string; readonly cpu: NativeCpu; readonly cacheRoot: string;
  readonly signal?: AbortSignal; readonly progress?: (line: string) => void;
  readonly tools?: NativeTools;
}
export function sharpLibvipsVersion(config: unknown): string {
  const value = (config as { libvips?: unknown })?.libvips;
  const match = typeof value === "string" && /^>=([0-9]+\.[0-9]+\.[0-9]+)$/u.exec(value);
  if (!match) throw new TypeError("sharp.config.libvips");
  return match[1]!;
}
export async function buildSharpArtifact(options: SharpBuildOptions): Promise<SharpBuildArtifact> {
  const { cpu, cacheRoot, signal, progress } = options;
  const glibc = /(?:^|\n)glibc:(\d+)\.(\d+)(?:\.\d+)?\s*$/u.exec(cpu.system ?? "");
  if (cpu.platform !== "linux" || cpu.arch !== "x64" || !glibc || Number(glibc[1]) < 2 || (Number(glibc[1]) === 2 && Number(glibc[2]) < 28)) throw new TypeError("sharp.platform");
  if (!/^\d+\.\d+\.\d+$/u.test(options.version)) throw new TypeError("sharp.version");
  const key = nativeBuildKey("sharp", options.version, `source-vips-1:${nativeToolchainIdentity}:${cacheRoot}:${sharpToolchainPackages.join(",")}`, cpu);
  const root = join(cacheRoot, "sharp", key);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = await lockFile(join(root, "build.sqlite"), "sharp", 60_000);
  const templates = join(root, "source-cache");
  const inside = (value: unknown): value is string => {
    if (typeof value !== "string" || !isAbsolute(value)) return false;
    const child = relative(root, resolve(value));
    return child !== "" && child !== ".." && !child.startsWith(".." + sep);
  };
  const environment = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const digest = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex");
  async function clone(repo: string, tag: string, path: string, local?: string) {
    if (await readFile(join(path, ".lotus-source.json"), "utf8").then(text => {
      const state = JSON.parse(text); return state.repo === repo && state.tag === tag && /^[a-f0-9]{40}$/u.test(state.revision);
    }).catch(() => false)) return;
    await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
    const localReady = local && await readFile(join(local, ".lotus-source.json"), "utf8").then(text => {
      const state = JSON.parse(text); return state.repo === repo && state.tag === tag;
    }).catch(() => false);
    const temporary = path + ".prepare-" + randomUUID();
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        await rm(temporary, { recursive: true, force: true });
        const result = await runNativeCommand(["git", "-c", "core.hooksPath=/dev/null", "clone", ...(localReady ? ["--shared"] : ["--depth=1", "--single-branch"]), "--branch", tag, localReady ? local! : repo, temporary],
          { cwd: root, env: environment, signal, progress, timeoutMs: 600_000 });
        if (result.code !== 0) { if (attempt === 2) throw new Error(result.diagnostic); continue; }
        const head = await runNativeCommand(["git", "rev-parse", "HEAD"], { cwd: temporary, env: environment, signal });
        if (head.code !== 0 || !/^[a-f0-9]{40}$/u.test(head.stdout.trim())) throw new Error(head.diagnostic);
        await writeFile(join(temporary, ".lotus-source.json"), JSON.stringify({ repo, tag, revision: head.stdout.trim() }));
        await rm(path, { recursive: true, force: true }); await rename(temporary, path); return;
      }
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  try {
    signal?.throwIfAborted();
    const manifestFile = join(root, "artifact.json");
    const cached = await readFile(manifestFile, "utf8").then(async text => {
      const state = JSON.parse(text);
      if (!inside(state.prefix) || !inside(state.packageDirectory) || !inside(state.file) || state.file !== join(state.packageDirectory, "src/build/Release", `sharp-linux-x64-${options.version}.node`)) return;
      if (state.verified !== "formats-v1" || state.key !== key || state.binding !== await digest(state.file) || !Array.isArray(state.libraries) || !state.libraries.length) return;
      for (const entry of state.libraries) {
        if (typeof entry.name !== "string" || !/^lib[0-9A-Za-z_.-]+\.so(?:\.[0-9.]+)?$/u.test(entry.name) || entry.sha256 !== await digest(join(state.prefix, "lib", entry.name))) return;
      }
      return { file: state.file, prefix: state.prefix, packageDirectory: state.packageDirectory, libvipsVersion: state.libvipsVersion } as SharpBuildArtifact;
    }).catch(() => undefined);
    if (cached) return cached;
    const publishedPrefix = await readFile(manifestFile, "utf8").then(text => JSON.parse(text).prefix).catch(() => undefined);
    const pendingFile = join(root, "pending.json");
    const pending = await readFile(pendingFile, "utf8").then(async text => {
      const state = JSON.parse(text);
      if (state.key !== key || !inside(state.attempt) || !/^[0-9a-f-]{36}$/u.test(relative(join(root, "attempts"), state.attempt)) ||
          publishedPrefix === join(state.attempt, "runtime") || await readFile(join(state.attempt, "sealed.json")).then(() => true).catch(() => false)) return;
      return state.attempt as string;
    }).catch(() => undefined);
    const attempt = pending ?? join(root, "attempts", randomUUID());
    const cgifSource = join(attempt, "cgif");
    const source = join(attempt, "sharp"), vipsSource = join(attempt, "vips"), prefix = join(attempt, "runtime");
    const pendingTemporary = pendingFile + ".part-" + randomUUID();
    try {
      await writeFile(pendingTemporary, JSON.stringify({ key, attempt }), { mode: 0o600 });
      await rename(pendingTemporary, pendingFile);
    } finally { await rm(pendingTemporary, { force: true }); }
    await clone("https://github.com/lovell/sharp.git", `v${options.version}`, join(templates, "sharp"), join(root, "sharp"));
    await clone("https://github.com/lovell/sharp.git", `v${options.version}`, source, join(templates, "sharp"));
    const metadata = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
    if (metadata.version !== options.version) throw new TypeError("sharp.source.version");
    const libvipsVersion = sharpLibvipsVersion(metadata.config);
    await clone("https://github.com/libvips/libvips.git", `v${libvipsVersion}`, join(templates, "vips"), join(root, "vips"));
    await clone("https://github.com/libvips/libvips.git", `v${libvipsVersion}`, vipsSource, join(templates, "vips"));
    await clone("https://github.com/dloebl/cgif.git", "v0.5.4", join(templates, "cgif"), join(root, "cgif"));
    await clone("https://github.com/dloebl/cgif.git", "v0.5.4", cgifSource, join(templates, "cgif"));
    const tools = options.tools ?? await prepareNativeToolchain(join(cacheRoot, "toolchain"), { signal, progress, packages: sharpToolchainPackages });
    const env = { ...environment, SHARP_FORCE_GLOBAL_LIBVIPS: "1", SHARP_IGNORE_GLOBAL_LIBVIPS: "",
      NODE_PATH: join(attempt, "build-dependencies/node_modules"), npm_config_nodedir: tools.prefix,
      npm_config_cache: join(cacheRoot, "npm"), npm_config_userconfig: "/dev/null",
      PKG_CONFIG_PATH: `${join(prefix, "lib/pkgconfig")}:${join(tools.prefix, "lib/pkgconfig")}`, PKG_CONFIG_SYSROOT_DIR: "",
      LD_LIBRARY_PATH: `${join(prefix, "lib")}:${join(tools.prefix, "lib")}` };
    async function run(argv: readonly string[], cwd: string) {
      for (let retry = 0; retry < 3; retry++) {
        let networkFailure = false;
        const result = await tools.run(["env", `PATH=${join(attempt, "build-dependencies/node_modules/.bin")}:${join(tools.prefix, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`, `PKG_CONFIG_PATH=${env.PKG_CONFIG_PATH}`, "PKG_CONFIG_SYSROOT_DIR=", `LD_LIBRARY_PATH=${env.LD_LIBRARY_PATH}`, `CFLAGS=-march=x86-64 -mtune=generic -Wl,-rpath,${join(tools.prefix, "lib")}`,
          `CXXFLAGS=-march=x86-64 -mtune=generic -Wl,-rpath,${join(tools.prefix, "lib")}`,
          `LDFLAGS=-Wl,-rpath,${join(prefix, "lib")} -Wl,-rpath,${join(tools.prefix, "lib")}`, ...argv],
          { cwd, env, signal, progress: line => {
            networkFailure ||= /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|TLS.*(?:error|failed)|SSL.*(?:error|EOF)|fetch.*failed/iu.test(line);
            progress?.(line);
          }, timeoutMs: 3 * 60 * 60_000 });
        if (result.code === 0 && !result.timedOut) return result;
        if (argv[0] !== "npm" || !networkFailure || retry === 2 || result.timedOut) throw new Error(result.diagnostic);
        signal?.throwIfAborted();
        await new Promise(resolve => setTimeout(resolve, 1000 * (retry + 1)));
      }
      throw new Error("sharp.build");
    }
    const cgifBuild = join(cgifSource, "build");
    await run(["meson", "setup", cgifBuild, `--prefix=${prefix}`, "--libdir=lib", "--buildtype=release", "-Dexamples=false", "-Dtests=false", "--reconfigure"], cgifSource);
    await run(["meson", "compile", "-C", cgifBuild, "-j", "2"], cgifSource);
    await run(["meson", "install", "-C", cgifBuild], cgifSource);
    const build = join(vipsSource, "build");
    await run(["meson", "setup", build, `--prefix=${prefix}`, "--libdir=lib", "--buildtype=release", "--wrap-mode=nofallback",
      "-Dintrospection=disabled", "-Dexamples=false", "-Ddocs=false", "-Dcpp-docs=false", "-Dvapi=false", "-Dcplusplus=true", "-Dmodules=disabled",
      "-Djpeg=enabled", "-Dpng=enabled", "-Dwebp=enabled", "-Dtiff=enabled", "-Dheif=enabled", "-Drsvg=enabled", "-Dimagequant=enabled", "-Dcgif=enabled",
      "-Dmagick=disabled", "-Dpoppler=disabled", "-Dopenslide=disabled", "-Dhighway=disabled", "-Dorc=disabled", "--reconfigure"], vipsSource);
    await run(["meson", "compile", "-C", build, "-j", "2"], vipsSource);
    await run(["meson", "install", "-C", build], vipsSource);
    await run(["npm", "install", "--ignore-scripts", "--omit=dev", "--omit=optional", "--no-audit", "--no-fund"], source);
    await run(["npm", "install", "--prefix", join(attempt, "build-dependencies"), "--ignore-scripts", "--no-audit", "--no-fund", "node-addon-api@8.9.2", "node-gyp@12.4.0"], source);
    await run(["node", "scripts/build.mjs"], source);
    await run(["node", "install/build.js"], source);
    const file = join(source, "src/build/Release", `sharp-linux-x64-${options.version}.node`);
    await run(["node", "--eval", `const assert=require('node:assert/strict');const sharp=require(${JSON.stringify(source)});
(async()=>{for(const format of ['png','jpeg','webp','gif','tiff','avif']) {
const encoded=await sharp(Buffer.alloc(16,128),{raw:{width:2,height:2,channels:4}}).toFormat(format,{effort:1}).toBuffer();
const info=await sharp(encoded).metadata();assert.equal(info.width,2);assert.equal(info.height,2);
assert.equal((await sharp(encoded).ensureAlpha().raw().toBuffer()).length,16);
} const svg=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>')).raw().toBuffer();assert.ok(svg.length>=12);
})().catch(error=>{console.error(error);process.exitCode=1});`], source);
    const artifact = { file, prefix, packageDirectory: source, libvipsVersion };
    const libraries = await Promise.all((await readdir(join(prefix, "lib"), { withFileTypes: true }))
      .filter(entry => entry.isFile() && /^lib.*\.so(?:\.[0-9.]+)?$/u.test(entry.name))
      .map(async entry => ({ name: entry.name, sha256: await digest(join(prefix, "lib", entry.name)) })));
    const temporary = manifestFile + ".part-" + randomUUID();
    try {
      await writeFile(temporary, JSON.stringify({ key, ...artifact, verified: "formats-v1", binding: await digest(file), libraries,
        sharp: JSON.parse(await readFile(join(source, ".lotus-source.json"), "utf8")), source: JSON.parse(await readFile(join(vipsSource, ".lotus-source.json"), "utf8")), cgif: JSON.parse(await readFile(join(cgifSource, ".lotus-source.json"), "utf8")), sdk: tools.prefix }), { mode: 0o600 });
      signal?.throwIfAborted();
      await writeFile(join(attempt, "sealed.json"), JSON.stringify({ key }), { mode: 0o600 });
      signal?.throwIfAborted();
      await rename(temporary, manifestFile);
      await rm(pendingFile, { force: true });
    } finally { await rm(temporary, { force: true }); }
    return artifact;
  } finally { lock.close(); }
}
