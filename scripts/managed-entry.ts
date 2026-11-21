import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { lockFile } from "../lib/file-lock.ts";
import { backgroundCleanStop, managedProcess, setManagedWorkerReady } from "../lib/managed-exit.ts";
import { recoverUpdateActivation } from "../lib/update-activation.ts";

const [root, readyFile, attempt] = process.argv.slice(2);
await managedProcess(async ready => {
  // This entry and its working directory must survive replacement of the checkout.
  if (!root || !readyFile) throw new Error("PM2 宿主启动参数缺失。");
  const attemptFile = join(dirname(readyFile), "host-start-attempt");
  function checkAttempt() {
    if (attempt === undefined) return;
    let current: string | undefined;
    try { current = readFileSync(attemptFile, "utf8"); } catch {}
    if (attempt !== current) throw new Error("本次后台启动已取消或被替换。");
  }
  checkAttempt();
  const lock = await lockFile(join(dirname(root), `.${basename(root)}.lotus-host.sqlite`),
    "托管宿主", 0, "当前目录已有托管宿主运行。");
  try {
    await recoverUpdateActivation(root);
  } finally {
    lock.close();
  }
  process.chdir(root);
  const moduleUrl = pathToFileURL(join(root, "scripts", "run-managed.ts"));
  const { runManaged } = await import(moduleUrl.href) as typeof import("./run-managed.ts");
  checkAttempt();
  let available: boolean | undefined;
  let announced = false;
  const status = await runManaged(root, ready && (async () => {
    checkAttempt();
    if (available === false) throw new Error("后台工作进程尚未就绪。");
    announced = true;
    await ready();
  }), (workerReady) => {
    available = workerReady;
    if (announced) setManagedWorkerReady(readyFile, workerReady);
  });
  // PM2 reports signal exits as zero. Give an orderly stop its own exit code.
  return status === 0 ? backgroundCleanStop : status;
}, readyFile);
