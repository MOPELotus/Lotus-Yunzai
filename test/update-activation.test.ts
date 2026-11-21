import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadImagePreviews } from "../lib/image-previews.ts";
import { activateUpdate, previousUpdateDirectory, recoverUpdateActivation } from "../lib/update-activation.ts";

const pluginState = "plugins/fixture/state";
const additionalState = [pluginState] as const;
const activationTestTimeout = 20_000;
const runtime = {
  "config/settings.txt": "active configuration",
  "data/store.txt": "active data",
  "logs/runtime.log": "active logs",
  "backup/plugins/merged/private.yaml": "previous local configuration",
  ".env": "FIXTURE_ENV=active-env\n",
  ".env.production": "FIXTURE_PROFILE=active-profile\n",
  ".env.staging": "FIXTURE_PROFILE=custom-stage-profile\n",
  [`${pluginState}/state.json`]: '{"fixture":"active plugin state"}\n',
};

function code(revision: string, healthy = true) {
  return `
    if (!${healthy}) process.exit(9);
    const config = await Bun.file("config/settings.txt").text();
    console.log(JSON.stringify({ revision: ${JSON.stringify(revision)}, config }));
  `;
}

function buildFiles(revision: string, healthy = true) {
  return {
    "app.ts": code(revision, healthy),
    "node_modules/fixture.txt": `${revision} dependencies`,
    "panel/dist/index.html": `${revision} panel`,
    "plugins/fixture/index.js": `${revision} plugin`,
  };
}

async function writeFiles(root: string, files: Record<string, string>) {
  await Promise.all(Object.entries(files).map(async ([name, value]) => {
    const file = join(root, name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, value);
  }));
}

async function assertFiles(root: string, files: Record<string, string>) {
  for (const [name, value] of Object.entries(files)) expect(await readFile(join(root, name), "utf8")).toBe(value);
}

async function withDirectories(
  healthy: boolean,
  run: (paths: { parent: string; active: string; candidate: string }) => Promise<void>,
) {
  const temporary = await mkdtemp(join(tmpdir(), "lotus-update-activation-"));
  try {
    const parent = await realpath(temporary);
    const active = join(parent, "active");
    const candidate = join(parent, "staging", "checkout");
    await Promise.all([
      writeFiles(active, { ...buildFiles("previous"), ...runtime }),
      writeFiles(candidate, buildFiles("candidate", healthy)),
    ]);
    await run({ parent, active, candidate });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function checkStartup(directory: string, revision: string) {
  const processProbe = Bun.spawn([process.execPath, "--no-env-file", "app.ts"], {
    cwd: directory, stdout: "pipe", stderr: "ignore", stdin: "ignore", timeout: 3_000, killSignal: "SIGKILL",
    env: { PATH: process.env.PATH },
  });
  const [status, output] = await Promise.all([processProbe.exited, new Response(processProbe.stdout).text()]);
  if (status !== 0) throw new Error(`启动探测未通过，退出码 ${status}。`);
  expect(JSON.parse(output)).toEqual({ revision, config: runtime["config/settings.txt"] });
}

async function stateIdentities(root: string) {
  return Promise.all(["config", "data", "logs", "backup", ".env", ".env.production", ".env.staging", pluginState].map(async (name) => {
    const info = await stat(join(root, name));
    return [info.dev, info.ino];
  }));
}

test("切换保留新代码和构建产物、原用户状态与上一个已知版本", () => withDirectories(true, async ({ active, candidate }) => {
  const identity = await stateIdentities(active);
  const { previous } = await activateUpdate(active, candidate, async (directory) => {
    expect(directory).toBe(active);
    await checkStartup(directory, "candidate");
  }, additionalState);

  expect(await realpath(previous)).not.toBe(await realpath(active));
  await assertFiles(active, { ...buildFiles("candidate"), ...runtime });
  await assertFiles(previous, buildFiles("previous"));
  await expect(lstat(join(previous, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await stateIdentities(active)).toEqual(identity);
  await expect(lstat(candidate)).rejects.toMatchObject({ code: "ENOENT" });
}), activationTestTimeout);

test("候选启动失败恢复原安装并把候选送回暂存区", () => withDirectories(false, async ({ active, candidate }) => {
  const identity = await stateIdentities(active);
  let verified = false;
  await expect(activateUpdate(active, candidate, async (directory) => {
    verified = true;
    await writeFile(join(directory, ".env.local"), "FIXTURE_PROBE=candidate-only\n");
    await checkStartup(directory, "candidate");
  }, additionalState)).rejects.toThrow();
  expect(verified).toBe(true);
  await assertFiles(active, { ...buildFiles("previous"), ...runtime });
  await assertFiles(candidate, { ...buildFiles("candidate", false), ".env.local": "FIXTURE_PROBE=candidate-only\n" });
  expect(await stateIdentities(active)).toEqual(identity);
  await expect(lstat(join(candidate, "config/settings.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(join(active, ".env.local"))).rejects.toMatchObject({ code: "ENOENT" });
  await checkStartup(active, "previous");
}), activationTestTimeout);

test("候选接管后可从当前切换归档导入旧缓存", () => withDirectories(true, async ({ active, candidate }) => {
  const file = "temp/Lotus-Plugin/poetry/lines.json";
  const old = { [file]: '{"lines":["  旧摘要  "]}\n' };
  const target = "data/image-previews/lines.json";
  await writeFiles(active, old);
  expect(await previousUpdateDirectory(active)).toBeUndefined();
  let previous: string | undefined;
  const activated = await activateUpdate(active, candidate, async (directory) => {
    previous = await previousUpdateDirectory(directory);
    expect(previous).toBeDefined();
    await expect(lstat(join(directory, target))).rejects.toMatchObject({ code: "ENOENT" });
  }, additionalState);
  expect(previous).toBe(activated.previous);
  expect(await previousUpdateDirectory(active)).toBeUndefined();
  const root = pathToFileURL(active + "/");
  const archived = pathToFileURL(activated.previous + "/");
  expect(await loadImagePreviews(root, archived)).toEqual(["旧摘要"]);
  await assertFiles(activated.previous, old);
  await assertFiles(active, { [target]: '{"lines":["旧摘要"]}' });
  expect(await loadImagePreviews(root)).toEqual(["旧摘要"]);
}), activationTestTimeout);

test("归档缓存路径经过链接时不读取链接目标", () => withDirectories(true, async ({ parent, active, candidate }) => {
  const folder = "temp/Lotus-Plugin/poetry";
  const outside = join(parent, "outside");
  await writeFiles(outside, { "lines.json": '{"lines":["不属于归档"]}' });
  await mkdir(join(active, dirname(folder)), { recursive: true });
  await symlink(outside, join(active, folder), "dir");
  const { previous } = await activateUpdate(active, candidate, async () => {}, additionalState);
  expect(await loadImagePreviews(pathToFileURL(active + "/"), pathToFileURL(previous + "/"))).toEqual([]);
}), activationTestTimeout);

test("候选包含受保护路径时拒绝切换并保留两份状态", () => withDirectories(true, async ({ active, candidate }) => {
  const candidateState = { "config/settings.txt": "candidate defaults" };
  await writeFiles(candidate, candidateState);
  let verified = false;
  await expect(activateUpdate(active, candidate, async () => { verified = true; }, additionalState)).rejects.toThrow();
  expect(verified).toBe(false);
  await assertFiles(active, { ...buildFiles("previous"), ...runtime });
  await assertFiles(candidate, { ...buildFiles("candidate"), ...candidateState });
}));

test("启动验证未结束时并发切换不能替换候选或使用用户状态", () => withDirectories(true, async ({ parent, active, candidate }) => {
  const other = join(parent, "other-staging", "checkout");
  await writeFiles(other, buildFiles("other candidate"));
  const entered = Promise.withResolvers<void>();
  const continueVerification = Promise.withResolvers<void>();
  const running = activateUpdate(active, candidate, async (directory) => {
    entered.resolve();
    await continueVerification.promise;
    await checkStartup(directory, "candidate");
  }, additionalState);
  let competing: Promise<"accepted" | "rejected"> | undefined;
  try {
    await Promise.race([entered.promise, running.then(() => { throw new Error("首个切换提前结束。"); })]);
    let competingProbe = false;
    competing = activateUpdate(active, other, async () => { competingProbe = true; }, additionalState)
      .then(() => "accepted", () => "rejected");
    const status = await Promise.race([competing, Bun.sleep(1_000).then(() => "blocked")]);
    expect(status).toBe("rejected");
    expect(competingProbe).toBe(false);
    await assertFiles(active, { ...buildFiles("candidate"), ...runtime });
    await assertFiles(other, buildFiles("other candidate"));
  } finally {
    continueVerification.resolve();
    await running;
    await competing;
  }
  await assertFiles(active, { ...buildFiles("candidate"), ...runtime });
}));

test.skipIf(process.platform === "win32").each([false, true])(
  "切换进程被终止后依照日志恢复，暂存父目录被清理 %p",
  (removed) => withDirectories(true, async ({ active, candidate, parent }) => {
  const identity = await stateIdentities(active);
  const activationModule = new URL("../lib/update-activation.ts", import.meta.url).href;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", `
    import { activateUpdate } from ${JSON.stringify(activationModule)};
    await activateUpdate(Bun.env.FIXTURE_ACTIVE, Bun.env.FIXTURE_CANDIDATE, async (directory) => {
      if (await Bun.file(directory + "/config/settings.txt").text() !== "active configuration") process.exit(2);
      console.log("candidate reached startup verification");
      process.kill(process.pid, "SIGKILL");
    }, ${JSON.stringify(additionalState)});
  `], {
    env: { PATH: process.env.PATH, FIXTURE_ACTIVE: active, FIXTURE_CANDIDATE: candidate },
    stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 4_000, killSignal: "SIGKILL",
  });
  const [status, output, error] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect(status).toBe(137);
  expect(output + error).toContain("candidate reached startup verification");
  await assertFiles(active, buildFiles("candidate"));
  if (removed) await rm(dirname(candidate), { recursive: true });

  expect(await recoverUpdateActivation(active)).toBe(true);
  expect(await recoverUpdateActivation(active)).toBe(false);
  await assertFiles(active, { ...buildFiles("previous"), ...runtime });
  const failed = removed ? (await readdir(parent)).find((name) => name.startsWith(".active.lotus-failed-")) : undefined;
  if (removed) expect(failed).toBeDefined();
  await assertFiles(failed ? join(parent, failed) : candidate, buildFiles("candidate"));
  expect(await stateIdentities(active)).toEqual(identity);
  await checkStartup(active, "previous");
}));
