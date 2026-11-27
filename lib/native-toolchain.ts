import { mkdir, chmod, readFile, writeFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { lockFile } from "./file-lock.ts";
import { runNativeCommand, type NativeRunOptions } from "./native-process.ts";
import { createTranslator } from "../packages/i18n/index.ts";
import catalog from "../i18n/zh-CN.json";
const $t = createTranslator("core", catalog.messages);

const managerVersion = "2.10.0-0";
const managerDigest = "701f39c06f8e6a670a0e186c8479b9e5c0502a2f0cda6cef65d83bdd2875e8bd";
const managerUrl = `https://github.com/mamba-org/micromamba-releases/releases/download/${managerVersion}/micromamba-linux-64`;
const packages = ["rust>=1.95", "c-compiler", "cxx-compiler", "sysroot_linux-64=2.28", "clang", "libclang", "cmake", "ninja", "pkg-config", "make", "python", "fontconfig", "freetype", "openssl", "nodejs", "perl"];
const schema = createHash("sha256").update(JSON.stringify([managerVersion, packages, "location-v1"])).digest("hex");
export const nativeToolchainIdentity = schema;
export interface NativeTools {
  readonly prefix: string;
  readonly manager: string;
  run(argv: readonly string[], options: NativeRunOptions): ReturnType<typeof runNativeCommand>;
}

export async function prepareNativeToolchain(root: string, options: {
  readonly signal?: AbortSignal;
  readonly progress?: (line: string) => void;
  readonly platform?: string;
  readonly arch?: string;
  readonly fetch?: typeof fetch;
  readonly run?: typeof runNativeCommand;
  readonly packages?: readonly string[];
} = {}): Promise<NativeTools> {
  root = resolve(root);
  const platform = options.platform ?? process.platform, arch = options.arch ?? process.arch;
  if (platform !== "linux" || arch !== "x64") throw new Error($t("lib.native-build.unsupported", { platform, arch }));
  const run = options.run ?? runNativeCommand;
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = await lockFile(join(root, "toolchain.sqlite"), $t("lib.native-build.busy"), 60_000);
  const selectedPackages = [...new Set([...packages, ...options.packages ?? []])];
  const profileSchema = options.packages?.length ? createHash("sha256").update(JSON.stringify([managerVersion, selectedPackages, "location-v1"])).digest("hex") : schema;
  const location = createHash("sha256").update(profileSchema + ":" + root).digest("hex");
  const manager = join(root, "micromamba"), prefix = join(root, "environment-" + location.slice(0, 16));
  const marker = join(prefix, ".lotus-ready.json");
  const env = { ...process.env, MAMBA_ROOT_PREFIX: join(root, "mamba"), CONDA_OVERRIDE_ARCHSPEC: "x86_64",
    CONDA_PKGS_DIRS: join(root, "packages"), MAMBA_NO_BANNER: "1" };
  const execute = (argv: readonly string[], settings: NativeRunOptions) => run([
    manager, "--no-rc", "run", "--prefix", prefix, "env",
    `RUSTFLAGS=-C target-cpu=x86-64 -C link-arg=-Wl,-rpath,${join(prefix, "lib")}`, "CFLAGS=-march=x86-64 -mtune=generic", "CXXFLAGS=-march=x86-64 -mtune=generic",
    ...argv,
  ], { ...settings, env: { ...env, ...settings.env } });
  try {
    options.signal?.throwIfAborted();
    const installed = await readFile(manager).catch(() => undefined);
    if (!installed || createHash("sha256").update(installed).digest("hex") !== managerDigest) {
      let bytes: Buffer | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        options.signal?.throwIfAborted();
        try {
          const signal = AbortSignal.any([AbortSignal.timeout(120_000), ...(options.signal ? [options.signal] : [])]);
          const response = await (options.fetch ?? fetch)(managerUrl, { signal });
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error($t("lib.native-build.failed", { name: "micromamba", details: `HTTP ${response.status}` }));
          }
          bytes = Buffer.from(await response.arrayBuffer());
          break;
        } catch (error) {
          options.signal?.throwIfAborted();
          if (attempt === 2) throw error;
          await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        }
      }
      if (!bytes) throw new Error("micromamba");
      if (createHash("sha256").update(bytes).digest("hex") !== managerDigest) throw new Error($t("lib.native-build.checksum", { name: "micromamba" }));
      const temporary = manager + ".part-" + randomUUID();
      try { await writeFile(temporary, bytes, { mode: 0o700 }); await rename(temporary, manager); }
      finally { await rm(temporary, { force: true }); }
    }
    await chmod(manager, 0o700);
    const cached = await readFile(marker, "utf8").then(value => JSON.parse(value).schema === profileSchema).catch(() => false);
    if (!cached) {
      options.progress?.($t("lib.native-build.tools", { name: "Rust/C/C++" }));
      const result = await run([manager, "--no-rc", "create", "--yes", "--prefix", prefix, "--override-channels", "--channel", "conda-forge", ...selectedPackages],
        { cwd: root, env, signal: options.signal, progress: options.progress, timeoutMs: 2 * 60 * 60_000 });
      if (result.code !== 0 || result.timedOut) throw new Error($t("lib.native-build.failed", { name: "Rust/C/C++", details: result.diagnostic }));
      const verified = await execute(["rustc", "--version"], { cwd: root, signal: options.signal });
      if (verified.code !== 0) throw new Error($t("lib.native-build.failed", { name: "rustc", details: verified.diagnostic }));
      const versions = await run([manager, "--no-rc", "list", "--prefix", prefix, "--explicit"], { cwd: root, env, signal: options.signal });
      await writeFile(join(prefix, ".lotus-packages.txt"), versions.stdout, { mode: 0o600 });
      await writeFile(marker, JSON.stringify({ schema: profileSchema, compiler: verified.diagnostic }), { mode: 0o600 });
    }
    return { manager, prefix, run: execute };
  } finally { lock.close(); }
}
