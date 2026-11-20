import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createManagedSupervisor } from "../lib/managed-supervisor.ts";
import { backgroundStartupFailure } from "../lib/managed-exit.ts";
import { createProcessReceipts } from "../lib/process-receipts.ts";
import { activateUpdate } from "../lib/update-activation.ts";

const liveValue = "production fixture environment";
const config = "active production configuration";
const oldRevision = "a".repeat(40);
const newRevision = "b".repeat(40);

test("后台入口区分未就绪失败、正常退出和就绪后崩溃", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "lotus-managed-exit-"));
  const active = join(temporary, "active");
  await mkdir(active);
  try {
    await writeFile(join(active, "app.ts"), `
      const { FIXTURE_READY, FIXTURE_STATUS, FIXTURE_MARKER, LOTUS_MANAGED_TOKEN } = process.env;
      if (FIXTURE_READY === "1") {
        process.send({ type: "lotus-ready", token: LOTUS_MANAGED_TOKEN });
        while (!await Bun.file(FIXTURE_MARKER).exists()) await Bun.sleep(10);
      }
      process.exit(Number(FIXTURE_STATUS));
    `);
    for (const [ready, status, expected] of [
      [false, 0, backgroundStartupFailure], [false, 42, backgroundStartupFailure],
      [true, 0, 0], [true, 42, 42], [true, backgroundStartupFailure, 1],
    ] as const) {
      const marker = join(temporary, `ready-${ready}-${status}`);
      const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../scripts/run-managed.ts", import.meta.url)), active, marker], {
        cwd: active, stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 2_000,
        env: { PATH: process.env.PATH, FIXTURE_READY: ready ? "1" : "0", FIXTURE_STATUS: String(status), FIXTURE_MARKER: marker },
      });
      expect(await child.exited).toBe(expected);
      expect(await Bun.file(marker).exists()).toBe(ready);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

type WorkerEvent = {
  readonly event: "launch" | "ready" | "serving" | "cleanup" | "failed";
  readonly revision: string;
  readonly pid: number;
  readonly held: boolean;
  readonly config: string;
  readonly production: string;
  readonly previousCleanup: string;
};

function worker(revision: string, mode: "ready" | "fail-on-production" | "wait") {
  return `
    import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
    const revision = ${JSON.stringify(revision)};
    const mode = ${JSON.stringify(mode)};
    const token = process.env.LOTUS_MANAGED_TOKEN;
    if (!token) {
      if (process.env.FIXTURE_PRODUCTION) process.exit(12);
      console.log("isolated fixture startup succeeded");
      process.exit(0);
    }

    const held = process.env.LOTUS_MANAGED_HELD === "1";
    const config = readFileSync("config/profile.txt", "utf8");
    const previousCleanup = await Bun.file("data/last-cleanup").exists() ? readFileSync("data/last-cleanup", "utf8") : "";
    function audit(event) {
      appendFileSync(process.env.FIXTURE_AUDIT, JSON.stringify({
        event, revision, pid: process.pid, held, config, production: process.env.FIXTURE_PRODUCTION, previousCleanup,
      }) + "\\n");
    }
    let stopping = false;
    async function cleanup() {
      if (stopping) return;
      stopping = true;
      await Bun.sleep(35);
      writeFileSync("data/last-cleanup", revision);
      audit("cleanup");
      process.exit(0);
    }
    process.on("SIGTERM", cleanup);
    process.on("SIGINT", cleanup);
    process.on("message", (message) => {
      if (held && message?.type === "lotus-activate" && message.token === token) audit("serving");
    });
    audit("launch");
    if (mode === "fail-on-production" && process.env.FIXTURE_PRODUCTION) {
      audit("failed");
      process.exit(9);
    }
    if (mode !== "wait") {
      process.send({ type: "lotus-ready", token, revision });
      audit("ready");
      if (!held) audit("serving");
    }
    // Bound the lifetime of a fixture even when a supervisor regression misses shutdown.
    setTimeout(() => process.exit(30), 8_000);
  `;
}

async function waitFor<T>(read: () => Promise<T | undefined>, description: string): Promise<T> {
  const end = performance.now() + 4_000;
  do {
    const result = await read();
    if (result !== undefined) return result;
    await Bun.sleep(10);
  } while (performance.now() < end);
  throw new Error(description);
}

type Supervisor = ReturnType<typeof createManagedSupervisor>;
type Stage = Parameters<Supervisor["replace"]>[0];

async function fixture(mode: "ready" | "fail-on-production" | "wait", run: (fixture: {
  active: string;
  candidate: string;
  supervisor: Supervisor;
  stage: Stage;
  events(): Promise<WorkerEvent[]>;
  waitForEvent(filter: (event: WorkerEvent) => boolean): Promise<WorkerEvent>;
}) => Promise<void>) {
  const temporary = await mkdtemp(join(tmpdir(), "lotus-managed-supervisor-"));
  let supervisor: Supervisor | undefined;
  try {
    const active = join(temporary, "active");
    const candidate = join(temporary, "staging", "checkout");
    const audit = join(temporary, "worker-events.jsonl");
    await Promise.all([
      mkdir(join(active, "config"), { recursive: true }), mkdir(join(active, "data"), { recursive: true }),
      mkdir(candidate, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(active, "app.ts"), worker(oldRevision, "ready")),
      writeFile(join(active, "revision.txt"), oldRevision),
      writeFile(join(active, "config/profile.txt"), config),
      writeFile(join(candidate, "app.ts"), worker(newRevision, mode)),
      writeFile(join(candidate, "revision.txt"), newRevision),
      writeFile(audit, ""),
    ]);
    const events = async () => (await readFile(audit, "utf8")).trim().split("\n").filter(Boolean)
      .map((entry): WorkerEvent => JSON.parse(entry));
    const waitForEvent = (filter: (event: WorkerEvent) => boolean) =>
      waitFor(async () => (await events()).find(filter), "未收到进程夹具事件。");
    supervisor = createManagedSupervisor(active, { env: {
      PATH: process.env.PATH, FIXTURE_PRODUCTION: liveValue, FIXTURE_AUDIT: audit,
    } });
    const stage: Stage = {
      revision: newRevision,
      async activate(verify) {
        expect((await events()).filter((event) => event.event === "cleanup" && event.revision === oldRevision)).toHaveLength(1);
        expect(await readFile(join(active, "data/last-cleanup"), "utf8")).toBe(oldRevision);
        expect(await readFile(join(active, "revision.txt"), "utf8")).toBe(oldRevision);
        return activateUpdate(active, candidate, verify);
      },
    };
    await supervisor.start();
    await waitForEvent((event) => event.event === "serving" && event.revision === oldRevision);
    await run({ active, candidate, supervisor, stage, events, waitForEvent });
  } finally {
    try {
      await supervisor?.stop();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

test("托管更新等待旧进程清理，候选用活动配置验证并在提交后接管", () => fixture("ready", async ({
  active, supervisor, stage, events, waitForEvent,
}) => {
  const allowCommit = Promise.withResolvers<void>();
  const validationFinished = Promise.withResolvers<true>();
  const replacement = supervisor.replace({
    ...stage,
    activate: (verify) => stage.activate(async (directory) => {
      await verify(directory);
      validationFinished.resolve(true);
      await allowCommit.promise;
    }),
  });
  try {
    const outcome = await Promise.race([validationFinished.promise, replacement]);
    expect(outcome).toBe(true);
    const launched = await waitForEvent((event) => event.event === "ready" && event.revision === newRevision);
    expect(launched).toMatchObject({ held: true, config, production: liveValue, previousCleanup: oldRevision });
    expect((await events()).filter((event) => event.revision === newRevision && event.event === "serving")).toEqual([]);
  } finally {
    allowCommit.resolve();
  }

  expect(await replacement).toBe("updated");
  await waitForEvent((event) => event.event === "serving" && event.revision === newRevision);
  expect(await readFile(join(active, "revision.txt"), "utf8")).toBe(newRevision);
  expect(await readFile(join(active, "config/profile.txt"), "utf8")).toBe(config);
  expect((await events()).filter((event) => event.event === "launch").map((event) => event.revision))
    .toEqual([oldRevision, newRevision]);
}), 14_000);

test("隔离探测通过但活动环境启动失败时回滚并重启旧工作进程", () => fixture("fail-on-production", async ({
  active, candidate, supervisor, stage, events, waitForEvent,
}) => {
  const isolated = Bun.spawn([process.execPath, "--no-env-file", "app.ts"], {
    cwd: candidate, env: { PATH: process.env.PATH }, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 3_000,
  });
  const [status, output] = await Promise.all([isolated.exited, new Response(isolated.stdout).text()]);
  expect(status).toBe(0);
  expect(output).toContain("isolated fixture startup succeeded");
  const initial = (await events()).find((event) => event.event === "launch")!;
  expect(await supervisor.replace(stage)).toBe("rolled-back");
  const failed = await waitForEvent((event) => event.event === "failed" && event.revision === newRevision);
  expect(failed).toMatchObject({ held: true, config, production: liveValue, previousCleanup: oldRevision });
  const restored = await waitForEvent((event) => event.event === "serving" && event.revision === oldRevision && event.pid !== initial.pid);
  expect(restored).toMatchObject({ held: false, config, production: liveValue });
  expect(await readFile(join(active, "revision.txt"), "utf8")).toBe(oldRevision);
  expect(await readFile(join(candidate, "revision.txt"), "utf8")).toBe(newRevision);
  expect((await events()).filter((event) => event.event === "serving").map((event) => event.revision))
    .toEqual([oldRevision, oldRevision]);
}), 14_000);

test("候选验证期间外部停止会回滚并结束托管器，旧进程不再启动", () => fixture("wait", async ({
  active, candidate, supervisor, stage, events, waitForEvent,
}) => {
  const replacement = supervisor.replace(stage);
  await waitForEvent((event) => event.event === "launch" && event.revision === newRevision);
  const stopped = supervisor.stop("SIGTERM");
  expect(await replacement).toBe("stopped");
  expect(await stopped).toBe(143);
  expect(await supervisor.done).toBe(143);
  expect(await readFile(join(active, "revision.txt"), "utf8")).toBe(oldRevision);
  expect(await readFile(join(candidate, "revision.txt"), "utf8")).toBe(newRevision);
  const recorded = await events();
  expect(recorded.filter((event) => event.event === "launch").map((event) => event.revision)).toEqual([oldRevision, newRevision]);
  expect(recorded.filter((event) => event.event === "serving").map((event) => event.revision)).toEqual([oldRevision]);
  expect(recorded.filter((event) => event.event === "cleanup").map((event) => event.revision)).toEqual([oldRevision, newRevision]);
}), 14_000);

test("候选在提交后退出时，反向切换保留实际迁移的插件状态", () => fixture("ready", async ({
  active, candidate, supervisor, stage, waitForEvent,
}) => {
  await mkdir(join(active, "plugins"));
  await writeFile(join(active, "plugins/loose.js"), "// local script");
  const replacement = await supervisor.replace({
    ...stage,
    async activate(verify) {
      const result = await activateUpdate(active, candidate, verify, ["plugins/loose.js"]);
      const { pid } = await waitForEvent((event) => event.event === "ready" && event.revision === newRevision);
      process.kill(pid, "SIGKILL");
      await waitFor(async () => {
        try {
          process.kill(pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
          throw error;
        }
      }, "候选夹具没有退出。");
      return result;
    },
  });
  expect(replacement).toBe("rolled-back");
  expect(await readFile(join(active, "revision.txt"), "utf8")).toBe(oldRevision);
  expect(await readFile(join(active, "plugins/loose.js"), "utf8")).toBe("// local script");
}), 14_000);

function gitFixture(directory: string, ...args: string[]): string {
  const child = Bun.spawnSync([
    "git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", ...args,
  ], { cwd: directory, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  if (child.exitCode !== 0) throw new Error(`Git 夹具命令失败（${args[0]}）。\n${child.stderr.toString()}`);
  return child.stdout.toString().trimEnd();
}

test.skipIf(!Bun.which("git"))("托管更新通过 IPC 保存 Milky 会话回执，同 QQ 的 OneBot 不能领取", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "lotus-managed-milky-receipt-"));
  let supervisor: Supervisor | undefined;
  try {
    const writer = join(temporary, "writer");
    const active = join(temporary, "active");
    const origin = join(temporary, "origin.git");
    const audit = join(temporary, "worker-events.jsonl");
    const target = { type: "private", adapter: "milky", botId: 99, id: 51 } as const;
    gitFixture(temporary, "init", "--bare", "--quiet", "--initial-branch=main", origin);
    gitFixture(temporary, "init", "--quiet", "--initial-branch=main", writer);
    await mkdir(join(writer, "scripts"));
    const handoffModule = fileURLToPath(new URL("../lib/managed-handoff.ts", import.meta.url));
    await Promise.all([
      writeFile(join(writer, ".gitignore"), "/config/\n/data/\n/logs/\n"),
      writeFile(join(writer, "package.json"), JSON.stringify({
        name: "lotus-yunzai", private: true, type: "module", scripts: { typecheck: "bun --version" },
      })),
      writeFile(join(writer, "scripts/bootstrap.ts"), "export {};\n"),
      writeFile(join(writer, "revision.txt"), "initial worker\n"),
      writeFile(join(writer, "app.ts"), `
        import { appendFileSync } from "node:fs";
        import { createManagedHandoff } from ${JSON.stringify(handoffModule)};
        const result = Bun.spawnSync(["git", "rev-parse", "HEAD"]);
        if (result.exitCode !== 0) process.exit(11);
        const revision = result.stdout.toString().trim();
        const held = Bun.env.LOTUS_MANAGED_HELD === "1";
        const handoff = createManagedHandoff();
        if (!handoff.managed) {
          const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () =>
            Response.json({ status: "ok", revision }) });
          console.log("HTTP 正在监听 " + server.url.origin + "/status");
        } else {
          const audit = ${JSON.stringify(audit)};
          function record(event) { appendFileSync(audit, event + "\\n"); }
          process.on("SIGTERM", () => process.exit(143));
          const timeout = setTimeout(() => process.exit(30), 14_000);
          await handoff.ready(revision, new AbortController().signal);
          record("active " + revision);
          if (!held && !handoff.update({ quiet: true, target: ${JSON.stringify(target)}, directories: [] }, record)) {
            record("IPC rejected");
            clearTimeout(timeout);
            process.exit(12);
          }
        }
      `),
      writeFile(audit, ""),
    ]);
    gitFixture(writer, "add", "--all");
    gitFixture(writer, "commit", "--quiet", "-m", "Fixture active host");
    gitFixture(writer, "push", "--quiet", origin, "main");
    gitFixture(temporary, "clone", "--quiet", "--no-local", origin, active);
    await writeFile(join(writer, "revision.txt"), "candidate worker\n");
    gitFixture(writer, "commit", "--quiet", "-am", "Fixture candidate host");
    gitFixture(writer, "push", "--quiet", origin, "main");
    const revision = gitFixture(writer, "rev-parse", "HEAD");

    supervisor = createManagedSupervisor(active, { env: { PATH: process.env.PATH } });
    await supervisor.start();
    await waitFor(async () => {
      const events = (await readFile(audit, "utf8")).trim().split("\n");
      if (events.includes(`active ${revision}`)) return true;
      const failure = events.find((event) => ["IPC rejected", "failed", "unavailable", "rejected", "current"].includes(event));
      if (failure) throw new Error(`Milky 更新夹具未切换（${failure}）。`);
    }, "Milky 更新候选未接管。");

    await supervisor.stop();
    const receipts = createProcessReceipts(pathToFileURL(`${active}/`));
    expect(await receipts.takeUpdate(99)).toBeUndefined();
    expect(await receipts.takeUpdate(99, "milky")).toMatchObject({ kind: "update", result: "updated", revision, target });
    expect(await receipts.takeUpdate(99, "milky")).toBeUndefined();
  } finally {
    try {
      await supervisor?.stop();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}, 18_000);
