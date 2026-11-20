import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { lockFile } from "../lib/file-lock.ts";
import { backgroundCleanStop, managedProcess } from "../lib/managed-exit.ts";
import { recoverUpdateActivation } from "../lib/update-activation.ts";

const [root, readyFile] = process.argv.slice(2);
await managedProcess(async ready => {
  // This entry and its working directory must survive replacement of the checkout.
  if (!root || !readyFile) throw new Error("PM2 宿主启动参数缺失。");
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
  const status = await runManaged(root, ready);
  // PM2 reports signal exits as zero. Give an orderly stop its own exit code.
  return status === 0 ? backgroundCleanStop : status;
}, readyFile);
