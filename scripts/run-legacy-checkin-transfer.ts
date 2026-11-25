import "../lib/i18n-preload.ts";
import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { createHash } from "node:crypto";
import { lstat, mkdtemp, open, readdir, readFile, realpath, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { createProfileStore } from "@lotus-yunzai/account";
import { guardedCheckinLegacyVersion, previewGuardedLegacyCheckinTransfer, runGuardedLegacyCheckinTransfer,
  type ReceiptTransfer } from "../lib/checkin-schedule-handback.ts";
import { checkinScheduleClock, isCheckinScheduleDate } from "../lib/checkin-schedule-plan.ts";
import { createCheckinScheduleStore } from "../lib/checkin-schedule-store.ts";
import { lockFile, managedHostLockPath, managedStartupLockPath } from "../lib/file-lock.ts";
import { containsPath } from "./legacy-gacha-output.ts";

const runnerFile = "services/checkin/scheduled.js";
const receiver = {
  [runnerFile]: "c081548f00896b0ae9ba72182c59be975236ea6831fd7b4fb149de4424286a5f",
  "services/checkin/profileSignin.js": "7946dba0f344d603a7996cdb773e8d0a1ee70cdfba1e6830ab6bb282d31bcceb",
  "services/miyoushe/tasks.js": "4a97f5d0c8b1560cb54417da1ac0e584da2813bde23882570aaaafe5a368b8c5",
};

function safeFailure(message: string): never {
  throw new Error(message);
}

async function localDirectory(path: string, privateMode = false) {
  const state = await lstat(path);
  if (!state.isDirectory() || state.uid !== process.getuid?.() || (privateMode && (state.mode & 0o077) !== 0) ||
      path !== await realpath(path)) safeFailure($t("scripts.run-legacy-checkin-transfer.text_7c1947625e"));
}

async function verifyStateTree(path: string): Promise<void> {
  const state = await lstat(path);
  if (state.uid !== process.getuid?.()) safeFailure($t("scripts.run-legacy-checkin-transfer.text_02fe74cb23"));
  if (state.isFile() && state.nlink === 1) return;
  if (!state.isDirectory() || path !== await realpath(path)) safeFailure($t("scripts.run-legacy-checkin-transfer.text_f4c5454473"));
  for (const child of await readdir(path)) await verifyStateTree(join(path, child));
}

async function git(path: string, ...args: string[]) {
  const child = Bun.spawn(["git", "-C", path, "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], {
    env: { PATH: process.env.PATH, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    stdout: "pipe", stderr: "ignore",
  });
  const [exit, value] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  if (exit !== 0) safeFailure($t("scripts.run-legacy-checkin-transfer.text_d375e8e06f"));
  return value;
}

async function verifyReceiver(root: string) {
  const gitDir = join(root, ".git");
  await localDirectory(gitDir);
  const [topLevel, metadata] = (await git(root, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir")).trimEnd().split("\n");
  if (topLevel !== root || metadata !== gitDir) safeFailure($t("scripts.run-legacy-checkin-transfer.text_9f078b87b3"));
  if ((await git(root, "rev-parse", "HEAD^{commit}")).trim() !== guardedCheckinLegacyVersion) safeFailure($t("scripts.run-legacy-checkin-transfer.text_10fbddc726"));
  const changes = (await git(root, "diff", "--no-ext-diff", "--ignore-submodules=none", "--name-status", "-z", "HEAD", "--")).split("\0");
  const allowed = Object.keys(receiver).sort();
  if (changes.length !== allowed.length * 2 + 1 || allowed.some((file, i) => changes[i * 2] !== "M" || changes[i * 2 + 1] !== file) ||
      (await git(root, "ls-files", "--others", "--exclude-standard", "-z")) ||
      (await git(root, "ls-files", "-v", "-z")).split("\0").some(file => file && !file.startsWith("H "))) {
    safeFailure($t("scripts.run-legacy-checkin-transfer.text_56e9441aff"));
  }
  for (const [file, digest] of Object.entries(receiver)) {
    const path = join(root, file);
    const state = await lstat(path);
    if (!state.isFile() || state.nlink !== 1 || await realpath(path) !== path ||
        createHash("sha256").update(await readFile(path)).digest("hex") !== digest) safeFailure($t("scripts.run-legacy-checkin-transfer.text_52fab7ccfb"));
  }
}

function profileLoader(modern: string, legacy: string) {
  const stores = [modern, legacy].map(path => createProfileStore(join(path, "data", "users")));
  return async (qq: string, id: number) => {
    const snapshots = await Promise.all(stores.map(async store => {
      const settings = await store.checkinSettings(qq, id);
      const view = settings.enabled && settings.loggedIn ? await store.accountContext(qq, id) : undefined;
      return view && view.revision === settings.revision ? { view, settings } : undefined;
    })).catch(() => []);
    const [newAccount, oldAccount] = snapshots;
    if (!newAccount || !oldAccount) return;
    const old = oldAccount.view.account;
    const latest = newAccount.view.account;
    if ((old.stuid && old.ltuid && old.stuid !== old.ltuid) || (old.stuid || old.ltuid) !== (latest.stuid || latest.ltuid)) return;
    const before = oldAccount.settings;
    const after = newAccount.settings;
    const games = Object.keys(after.games).filter(key => {
      const previous = before.games[key];
      const current = after.games[key];
      return !!(previous?.enabled && current?.enabled &&
        isDeepStrictEqual([...previous.blacklist].sort(), [...current.blacklist].sort()));
    });
    const ready = [newAccount.view.device, oldAccount.view.device].every(device => device.id && device.fp);
    const forums = ready ? after.communityForums.filter(forum => before.communityForums.includes(forum)) : [];
    return { ...newAccount.view, checkinTargets: { forums, games } };
  };
}

type WorkingPlan = { date: string; entries: readonly unknown[] };
type LegacyRunner = {
  ScheduledSigninService: new (options: {
    scheduler: { getOrCreatePlan: (date: string) => Promise<WorkingPlan | undefined>; savePlan: (plan: WorkingPlan) => Promise<void> };
  }) => { receiveHandoff: (transfer: ReceiptTransfer) => Promise<unknown> };
};

async function createReceiver(root: string, workspace: string) {
  await localDirectory(join(root, "node_modules"));
  const { ScheduledSigninService } = await import(pathToFileURL(join(root, runnerFile)).href) as LegacyRunner;
  return async (transfer: ReceiptTransfer) => {
    const workingDirectory = await mkdtemp(join(workspace, "checkin-run-"));
    const file = join(workingDirectory, `${transfer.date}.json`);
    const directory = await open(workingDirectory, "r");
    let current: WorkingPlan;
    async function savePlan(plan: WorkingPlan) {
      const stage = file + ".tmp";
      const handle = await open(stage, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(plan, null, 2) + "\n");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(stage, file);
      await directory.sync();
      current = structuredClone(plan);
    }
    try {
      await savePlan({ date: transfer.date, entries: transfer.entries.map(scope => ({
        qq: scope.qq, profileId: scope.profileId, notified: false, done: false, communityRetry: scope.retry,
        handoffAccountKey: scope.accountKey, handoffReceiptId: transfer.id, handoffPlanDigest: transfer.planDigest,
      })) });
      const runner = new ScheduledSigninService({ scheduler: {
        getOrCreatePlan: async date => date === transfer.date ? structuredClone(current) : undefined,
        savePlan,
      } });
      const cwd = process.cwd();
      // Keep the old refresh's optional Yunzai cache lookup away from installed plugins.
      process.chdir(workingDirectory);
      try { return await runner.receiveHandoff(transfer); }
      finally { process.chdir(cwd); }
    } finally {
      await directory.close();
    }
  };
}

async function withStoppedCopies<T>(modern: string, legacy: string, run: () => Promise<T>) {
  const locks = [];
  try {
    for (const root of [modern, legacy]) {
      locks.push(await lockFile(managedStartupLockPath(root), $t("scripts.run-legacy-checkin-transfer.text_837c8d2798"), 0, $t("scripts.run-legacy-checkin-transfer.text_2e716e3322")));
      locks.push(await lockFile(managedHostLockPath(root), $t("scripts.run-legacy-checkin-transfer.text_e533bb7ee6"), 0, $t("scripts.run-legacy-checkin-transfer.text_e854efca82")));
    }
    return await run();
  } finally {
    for (const lock of locks.reverse()) lock.close();
  }
}

async function main(path: string, date: string, execute: boolean) {
  const workspace = resolve(path);
  const installed = await realpath(fileURLToPath(new URL("../", import.meta.url)));
  if (containsPath(installed, workspace) || containsPath(workspace, installed)) safeFailure($t("scripts.run-legacy-checkin-transfer.text_80accd8d14"));
  await localDirectory(workspace, true);
  const modern = join(workspace, "modern");
  const legacy = join(workspace, "legacy");
  async function inspect() {
    for (const root of [modern, legacy]) {
      await localDirectory(root);
      await verifyStateTree(join(root, "data"));
    }
    await verifyReceiver(legacy);
  }
  const sourceStore = createCheckinScheduleStore(join(modern, "data", "schedules"));
  const legacyStore = createCheckinScheduleStore(join(legacy, "data", "schedules"));
  const loadAccount = profileLoader(modern, legacy);
  if (!execute) {
    await inspect();
    const [source, history] = await Promise.all([sourceStore.read(date), legacyStore.read(date)]);
    if (!source) safeFailure($t("scripts.run-legacy-checkin-transfer.text_b29031fb26"));
    const counts = await previewGuardedLegacyCheckinTransfer(source, history, { loadAccount });
    return { mode: "dry-run", date, version: guardedCheckinLegacyVersion, ...counts, executed: 0 };
  }
  await localDirectory(modern);
  await localDirectory(legacy);
  return withStoppedCopies(modern, legacy, async () => {
    await inspect();
    const history = await legacyStore.read(date);
    if (!await sourceStore.read(date)) safeFailure($t("scripts.run-legacy-checkin-transfer.text_b29031fb26"));
    const runInline = await createReceiver(legacy, workspace);
    const result = await runGuardedLegacyCheckinTransfer(sourceStore, date, { loadAccount, legacy: history, runInline });
    if (!result.acquired) safeFailure($t("scripts.run-legacy-checkin-transfer.text_7e91541424"));
    return { mode: "execute", date, version: guardedCheckinLegacyVersion, executed: result.value };
  });
}

if (import.meta.main) {
  process.env.TZ = "Asia/Shanghai";
  const args = process.argv.slice(2);
  const execute = args[0] === "--execute";
  const [path, date, ...extra] = execute ? args.slice(1) : args;
  if (!path || path.startsWith("--") || !isCheckinScheduleDate(date) || extra.length) {
    console.error($t("scripts.run-legacy-checkin-transfer.text_e3c2b23a4f"));
    process.exitCode = 2;
  } else if (date !== checkinScheduleClock(Date.now()).date) {
    console.error($t("scripts.run-legacy-checkin-transfer.text_b82d1f09d1"));
    process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(await main(path, date, execute))); }
    catch (error) {
      console.error(error instanceof Error && !("code" in error) ? error.message : $t("scripts.run-legacy-checkin-transfer.text_bb06936170"));
      process.exitCode = 1;
    }
  }
}
