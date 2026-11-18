import { fileURLToPath } from "node:url";
import manifest from "../package.json";

const requiredVersion = manifest.packageManager.slice("bun@".length);
if (Bun.version !== requiredVersion) {
  console.error(`需要 Bun ${requiredVersion}，当前版本为 ${Bun.version}。`);
  process.exit(1);
}

const root = new URL("..", import.meta.url);
const options = { cwd: fileURLToPath(root), stdout: "inherit", stderr: "inherit" } as const;

if (await Bun.file(new URL(".gitmodules", root)).exists()) {
  const git = Bun.which("git");
  if (!git) {
    console.error("初始化 Git 子模块需要 Git。");
    process.exit(1);
  }
  const update = Bun.spawn([git, "submodule", "update", "--init", "--recursive", "--checkout"], options);
  const exitCode = await update.exited;
  if (exitCode !== 0) {
    console.error("子模块初始化失败。请检查主仓是否通过 Git 克隆，以及子模块是否可访问。");
    process.exit(exitCode);
  }
}

const installation = Bun.spawn([process.execPath, "install", "--frozen-lockfile"], options);
const installCode = await installation.exited;
if (installCode !== 0) process.exit(installCode);

try {
  await import("../packages/skia/index.ts");
  console.log("[初始化] Skia 原生库已加载。");
} catch {
  console.error("Skia 原生库加载失败，请检查安装日志及系统运行库。");
  process.exitCode = 1;
}

if (!process.exitCode) {
  try {
    const { verifyStaticRenderer } = await import("../lib/renderer/shotium.ts");
    await verifyStaticRenderer();
    console.log("[初始化] Shotium 原生库已加载。");
  } catch {
    console.error("Shotium 原生库加载失败，请检查支持的平台及系统运行库。");
    process.exitCode = 1;
  }
}
