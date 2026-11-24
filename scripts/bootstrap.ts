import { fileURLToPath } from "node:url";
import manifest from "../package.json";

const requiredVersion = manifest.packageManager.slice("bun@".length);
if (Bun.version !== requiredVersion) {
  console.error(`需要 Bun ${requiredVersion}，当前版本为 ${Bun.version}。`);
  process.exit(1);
}

const args = Bun.argv.slice(2);
const buildOnly = args.includes("--build-only");
const channels = args.filter(arg => arg !== "--verify-v3-renderer" && arg !== "--build-only");
if (channels.length > 1 || (channels[0] !== undefined && channels[0] !== "latest" && channels[0] !== "live") ||
    (buildOnly && channels.length)) {
  console.error("用法：bun run bootstrap [latest|live]。");
  process.exit(1);
}
const channel = channels[0];

const root = new URL("..", import.meta.url);
const options = { cwd: fileURLToPath(root), stdout: "inherit", stderr: "inherit" } as const;

if (await Bun.file(new URL(".gitmodules", root)).exists()) {
  const git = Bun.which("git");
  if (!git) {
    console.error("初始化 Git 子模块需要 Git。");
    process.exit(1);
  }
  let initialized = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const update = await Bun.spawn(
      [git, "submodule", "update", "--init", "--recursive", "--checkout"], options,
    ).exited;
    if (update === 0) {
      // An interrupted clone can leave HEAD at the requested commit before any files are checked out.
      const checkout = await Bun.spawn([
        git, "submodule", "foreach", "--quiet", "--recursive",
        'index=$(git rev-parse --git-path index) && { test -f "$index" || git read-tree -m -u HEAD; }',
      ], options).exited;
      if (checkout !== 0) break;

      const status = Bun.spawn([git, "submodule", "status", "--recursive"], { ...options, stdout: "pipe" });
      const [code, revisions] = await Promise.all([status.exited, new Response(status.stdout).text()]);
      if (code === 0 && !/^[-+U]/m.test(revisions)) {
        initialized = true;
        break;
      }
    }
    if (attempt === 1) console.error("[初始化] 子模块检出尚未完成，正在重试。");
  }
  if (!initialized) {
    console.error("子模块初始化失败。请检查主仓是否通过 Git 克隆，以及子模块是否可访问。");
    process.exit(1);
  }
}

const installArgs = [process.execPath, "install", "--frozen-lockfile"];
let installCode = await Bun.spawn(installArgs, options).exited;
const prepared = installCode === 0 ? 0 : await Bun.spawn([...installArgs, "--ignore-scripts"], options).exited;
// Load each probe in a fresh Bun process so a failed import does not survive native recovery.
const loadSkiaNative = () => Bun.spawn(
  [process.execPath, "--eval", 'await import("./packages/skia/index.ts")'],
  { ...options, stdout: "ignore", stderr: "ignore" },
).exited.then(code => code === 0);
let skiaReady = prepared === 0 && await loadSkiaNative();
if (prepared === 0 && !skiaReady) {
  try {
    const { recoverSkiaBinary } = await import("./skia-binary.ts");
    if (await recoverSkiaBinary(root)) {
      console.log("[初始化] 已重新下载并校验 Skia 原生库。");
      if (installCode !== 0) installCode = await Bun.spawn(installArgs, options).exited;
      if (installCode === 0) skiaReady = await loadSkiaNative();
    }
  } catch {
    console.error("Skia 原生库重试下载未完成或校验失败，请检查发布资源是否可访问。");
  }
}
if (installCode !== 0) process.exit(installCode);
if (skiaReady) console.log("[初始化] Skia 原生库已加载。");
else {
  console.error("Skia 原生库加载失败，请检查安装日志及系统运行库。");
  process.exitCode = 1;
}

if (!process.exitCode && Bun.argv.includes("--verify-v3-renderer")) {
  try {
    // This launcher may have started before node_modules existed.
    const probe = Bun.spawn([process.execPath, "--eval",
      'const { verifyStaticRenderer } = await import("./lib/renderer/shotium.ts"); await verifyStaticRenderer();',
    ], { ...options, stdout: "ignore", stderr: "ignore" });
    if (await probe.exited !== 0) throw new Error("Shotium 探测失败。");
    console.log("[初始化] Shotium 原生库已加载。");
  } catch {
    console.error("Shotium 原生库加载失败，请检查支持的平台及系统运行库。");
    process.exitCode = 1;
  }
}

if (!process.exitCode) {
  const build = await Bun.spawn([process.execPath, "run", "build:panel"], options).exited;
  if (build !== 0) {
    console.error("管理面板构建失败，请检查构建日志。");
    process.exitCode = build;
  }
}


if (!process.exitCode && !buildOnly) {
  // Run after dependency installation in a new process, with the same terminal
  // for first-run choices. The launcher keeps the startup lock and prepares models once.
  const initialized = await Bun.spawn([process.execPath, "--no-env-file", "scripts/launcher.ts", "init", ...(channel ? [channel] : [])], {
    ...options, stdin: "inherit",
  }).exited;
  if (initialized !== 0) {
    console.error("[初始化] 运行资料未准备完成，请排查上述错误后重新运行 bun run bootstrap。");
    process.exitCode = initialized;
  } else {
    console.log("[初始化] 全部准备完成，运行 bun run start 即可启动机器人。");
  }
}
