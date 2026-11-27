import "../lib/i18n-preload.ts";
import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { beginInitialization, finishInitialization } from "../lib/initialization-state.ts";
import { installTerminalLogging } from "../lib/terminal-log-format.ts";
import { fileURLToPath } from "node:url";
import manifest from "../package.json";
import { createInitializationProgress } from "../lib/initialization-progress.ts";

installTerminalLogging();

const requiredVersion = manifest.packageManager.slice("bun@".length);
if (Bun.version !== requiredVersion) {
  console.error($t("scripts.bootstrap.text_166356e16f", { "requiredVersion": requiredVersion, "version": Bun.version }));
  process.exit(1);
}

const args = Bun.argv.slice(2);
const buildOnly = args.includes("--build-only");
const channels = args.filter(arg => arg !== "--verify-v3-renderer" && arg !== "--build-only");
if (channels.length > 1 || (channels[0] !== undefined && channels[0] !== "latest" && channels[0] !== "live") ||
    (buildOnly && channels.length)) {
  console.error($t("scripts.bootstrap.text_aeeb309739"));
  process.exit(1);
}
const channel = channels[0];

const root = new URL("..", import.meta.url);
const options = { cwd: fileURLToPath(root), stdout: "inherit", stderr: "inherit" } as const;
const initializationRun = buildOnly ? undefined : await beginInitialization(root);

async function command(message: string, argv: string[], stdin: "inherit" | "ignore" = "ignore", nested = false) {
  // Subprocesses retain their own terminal progress; parent stages use full log lines.
  const progress = createInitializationProgress($t("scripts.bootstrap.text_65622e8ee9"), { isTTY: false,
    ...(nested && { heartbeatMs: Number.MAX_SAFE_INTEGER }) });
  progress.update({ stage: message, message });
  try {
    const code = await Bun.spawn(argv, { ...options, stdin }).exited;
    if (code === 0) progress.complete($t("scripts.bootstrap.text_3991f69bdf", { "message": message }));
    else progress.fail($t("scripts.bootstrap.text_51fd5ff84a", { "message": message, "code": code }));
    return code;
  } catch (error) {
    progress.fail($t("scripts.bootstrap.text_4ca0acdae3", { "message": message }));
    throw error;
  } finally { progress.close(); }
}


if (await Bun.file(new URL(".gitmodules", root)).exists()) {
  const git = Bun.which("git");
  if (!git) {
    console.error($t("scripts.bootstrap.text_dea0d4e42c"));
    process.exit(1);
  }
  let initialized = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const update = await command($t("scripts.bootstrap.text_7bdd98b1eb", { "attempt": attempt }),
      [git, "submodule", "update", "--init", "--recursive", "--checkout"]);
    if (update === 0) {
      // An interrupted clone can leave HEAD at the requested commit before any files are checked out.
      const checkout = await command($t("scripts.bootstrap.text_fac6d60468"), [
        git, "submodule", "foreach", "--quiet", "--recursive",
        'index=$(git rev-parse --git-path index) && { test -f "$index" || git read-tree -m -u HEAD; }',
      ]);
      if (checkout !== 0) break;

      console.info($t("scripts.bootstrap.text_fef56304fb"));
      const status = Bun.spawn([git, "submodule", "status", "--recursive"], { ...options, stdout: "pipe" });
      const [code, revisions] = await Promise.all([status.exited, new Response(status.stdout).text()]);
      if (code === 0 && !/^[-+U]/m.test(revisions)) {
        const count = revisions.split(/\r?\n/u).filter(Boolean).length;
        console.info($t("scripts.bootstrap.text_0caa104338", { "count": count, "value2": count }));
        initialized = true;
        break;
      }
    }
    if (attempt === 1) console.error($t("scripts.bootstrap.text_247a3bc233"));
  }
  if (!initialized) {
    console.error($t("scripts.bootstrap.text_d358114aef"));
    process.exit(1);
  }
}

const installArgs = [process.execPath, "install", "--frozen-lockfile"];
let installCode = await command($t("scripts.bootstrap.text_efb49f60da"), installArgs);
const prepared = installCode === 0 ? 0 : await command($t("scripts.bootstrap.text_7b014aff02"), [...installArgs, "--ignore-scripts"]);
if (prepared === 0) {
  const native = await command($t("lib.native-build.checking", { name: $t("lib.native-build.label") }), [process.execPath, "--no-env-file", "scripts/native-check.ts"]);
  if (native !== 0) process.exit(native);
  if (installCode !== 0) installCode = await command($t("scripts.bootstrap.text_0deb4d5776"), installArgs);
}
// Load each probe in a fresh Bun process so a failed import does not survive native recovery.
const loadSkiaNative = () => Bun.spawn(
  [process.execPath, "--eval", 'await import("./packages/skia/index.ts")'],
  { ...options, stdout: "ignore", stderr: "ignore" },
).exited.then(code => code === 0);
console.info($t("scripts.bootstrap.text_93f6c07edf") );
let skiaReady = prepared === 0 && await loadSkiaNative();
if (prepared === 0 && !skiaReady) {
  try {
    const { recoverSkiaBinary } = await import("./skia-binary.ts");
    const repair = createInitializationProgress($t("scripts.bootstrap.text_65622e8ee9"));
    let recovered: boolean;
    try {
      repair.update({ stage: "skia", message: $t("scripts.bootstrap.text_af2d401c6c") });
      recovered = await recoverSkiaBinary(root, { onTaskProgress: repair.update });
      if (recovered) repair.complete($t("scripts.bootstrap.text_cd6d974c53")); else repair.fail($t("scripts.bootstrap.text_334b36c22a"));
    } finally { repair.close(); }
    if (recovered) {
      console.log($t("scripts.bootstrap.text_fec3d14cf8"));
      if (installCode !== 0) installCode = await command($t("scripts.bootstrap.text_0deb4d5776"), installArgs);
      if (installCode === 0) skiaReady = await loadSkiaNative();
    }
  } catch {
    console.error($t("scripts.bootstrap.text_036fbf96e5"));
  }
}
if (installCode !== 0) process.exit(installCode);
if (skiaReady) console.log($t("scripts.bootstrap.text_dad8b8555f"));
else {
  console.error($t("scripts.bootstrap.text_9c9476be10"));
  process.exitCode = 1;
}

if (!process.exitCode && Bun.argv.includes("--verify-v3-renderer")) {
  try {
    // This launcher may have started before node_modules existed.
    const probe = Bun.spawn([process.execPath, "--eval",
      'const { verifyStaticRenderer } = await import("./lib/renderer/shotium.ts"); await verifyStaticRenderer();',
    ], { ...options, stdout: "ignore", stderr: "ignore" });
    if (await probe.exited !== 0) throw new Error($t("scripts.bootstrap.text_85e47db7b2"));
    console.log($t("scripts.bootstrap.text_599db98745"));
  } catch {
    console.error($t("scripts.bootstrap.text_7384dc4f72"));
    process.exitCode = 1;
  }
}

if (!process.exitCode) {
  const build = await command($t("scripts.bootstrap.text_8503502024"), [process.execPath, "run", "build:panel"]);
  if (build !== 0) {
    console.error($t("scripts.bootstrap.text_7a8d2e1c9d"));
    process.exitCode = build;
  }
}


if (!process.exitCode && !buildOnly) {
  const resources = await command($t("scripts.bootstrap.text_e052933f97"), [process.execPath, "--no-env-file", "scripts/verify-builtin-resources.ts"]);
  if (resources !== 0) process.exit(resources);
  // Run after dependency installation in a new process, with the same terminal
  // for first-run choices. The launcher keeps the startup lock and prepares models once.
  const initialized = await command($t("scripts.bootstrap.text_91b9d97edc"), [process.execPath, "--no-env-file", "scripts/launcher.ts", "init", ...(channel ? [channel] : [])], "inherit", true);
  if (initialized !== 0) {
    console.error($t("scripts.bootstrap.text_1f203f8f0a"));
    process.exitCode = initialized;
  } else {
    if (initializationRun) await finishInitialization(root, initializationRun);
    console.log($t("scripts.bootstrap.text_b2fbf7d700"));
  }
}
