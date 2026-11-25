import "../lib/i18n-preload.ts";
import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { managedDispatchPauseFile } from "../lib/managed-dispatch-pause.ts";
import { lockFile, managedHostLockPath } from "../lib/file-lock.ts";
import { backgroundCleanStop, managedProcess, setManagedWorkerReady } from "../lib/managed-exit.ts";
import { recoverUpdateActivation } from "../lib/update-activation.ts";

const [root, readyFile, attempt] = process.argv.slice(2);
await managedProcess(async ready => {
  // This entry and its working directory must survive replacement of the checkout.
  if (!root || !readyFile) throw new Error($t("scripts.managed-entry.text_43184a21ab"));
  const attemptFile = join(dirname(readyFile), "host-start-attempt");
  function checkAttempt() {
    if (attempt === undefined) return;
    let current: string | undefined;
    try { current = readFileSync(attemptFile, "utf8"); } catch {}
    if (attempt !== current) throw new Error($t("scripts.managed-entry.text_9a37bc1321"));
  }
  checkAttempt();
  const lock = await lockFile(managedHostLockPath(root),
    $t("scripts.managed-entry.text_e533bb7ee6"), 0, $t("scripts.managed-entry.text_b7751da923"));
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
    if (available === false) throw new Error($t("scripts.managed-entry.text_4393811e31"));
    announced = true;
    await ready();
  }), (workerReady) => {
    available = workerReady;
    if (announced) setManagedWorkerReady(readyFile, workerReady);
  }, attempt === undefined ? undefined : { path: join(dirname(readyFile), managedDispatchPauseFile), attempt });
  // PM2 reports signal exits as zero. Give an orderly stop its own exit code.
  return status === 0 ? backgroundCleanStop : status;
}, readyFile);
