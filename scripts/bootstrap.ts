import { fileURLToPath } from "node:url";
import manifest from "../package.json";

const requiredVersion = manifest.packageManager.slice("bun@".length);
if (Bun.version !== requiredVersion) {
  console.error(`需要 Bun ${requiredVersion}，当前版本为 ${Bun.version}。`);
  process.exit(1);
}

const installation = Bun.spawn([process.execPath, "install", "--frozen-lockfile"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  stdout: "inherit",
  stderr: "inherit",
});
process.exitCode = await installation.exited;
