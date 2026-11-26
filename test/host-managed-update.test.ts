import { expect, test } from "bun:test";
import { appendFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

const token = "managed-update-onebot-fixture";
const liveFailure = "fixture candidate exited only under the supervisor environment";
const startupLine = "Lotus-Yunzai 已启动。";

type Target = { readonly user_id: number } | { readonly group_id: number };
type UpdateTarget = "host" | "plugin" | "all";
type Schedule = "interval" | "legacy-default" | "cron";
interface Frame {
  readonly action: string;
  readonly echo?: string;
  readonly params: { readonly user_id?: number; readonly group_id?: number; readonly message: string };
}

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync([
    "git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgSign=false", ...args,
  ], {
    cwd: root,
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  if (result.exitCode !== 0) throw new Error(`Git 夹具命令失败（${args[0]}）。\n${result.stderr.toString()}`);
  return result.stdout.toString().trimEnd();
}

function isDetailedProgress(message: unknown) {
  return typeof message === "string" && /^(?:正在(?:检查|更新) [\p{L}\p{N}._-]+。|[\p{L}\p{N}._-]+ 已是最新。|正在准备候选版本，已耗时 \d+ 秒。|[A-Za-z0-9._-]+：)/u.test(message);
}

function deadline<T>(promise: Promise<T>, description: string, delay = 5_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(description)), delay);
    void promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function gateway(endpoint: string, botId?: number) {
  const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "X-Client-Role": "Universal" };
  if (botId !== undefined) headers["X-Self-ID"] = String(botId);
  const socket = new BunWebSocket(endpoint, { headers });
  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const closed = new Promise<void>((resolve) => socket.addEventListener("close", () => resolve(), { once: true }));
  const frames: Frame[] = [];
  const progressFrames: Frame[] = [];
  let ready = Promise.withResolvers<void>();
  socket.addEventListener("message", ({ data }) => {
    const frame: Frame = JSON.parse(data);
    if (frame.echo) socket.send(JSON.stringify({ echo: frame.echo, status: "ok", retcode: 0, data: { message_id: 77 } }));
    if (isDetailedProgress(frame.params?.message)) { progressFrames.push(frame); return; }
    frames.push(frame);
    ready.resolve();
  });
  let messageId = 0;
  return {
    socket, opened, closed, frames, progressFrames,
    async next(delay?: number) {
      if (!frames.length) await deadline(ready.promise, "未收到托管更新的 OneBot 回复。", delay);
      const frame = frames.shift()!;
      if (!frames.length) ready = Promise.withResolvers<void>();
      return frame;
    },
    command(message: string, userId: number, groupId?: number, role = "member") {
      socket.send(JSON.stringify({
        post_type: "message", message_type: groupId ? "group" : "private", sub_type: groupId ? "normal" : "friend",
        self_id: botId ?? 99, user_id: userId, group_id: groupId, message_id: ++messageId, message,
        sender: { role },
      }));
    },
  };
}

type Gateway = ReturnType<typeof gateway>;

function bootSupervisor(active: string, env: NodeJS.ProcessEnv = {}) {
  const clients: Gateway[] = [];
  const supervisor = Bun.spawn([process.execPath, "--no-env-file", "scripts/run-managed.ts", active], {
    cwd: active, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: { PATH: process.env.PATH, LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: token, FIXTURE_MANAGED_FAILURE: "1", ...env },
  });
  let stderrOutput = "";
  const stderr = supervisor.stderr.pipeThrough(new TextDecoderStream())
    .pipeTo(new WritableStream<string>({ write(chunk) { stderrOutput += chunk; } }))
    .then(() => stderrOutput);
  const reader = supervisor.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let lastStartupOutput = "";
  async function nextEndpoint() {
    while (true) {
      const started = output.indexOf(startupLine);
      if (started !== -1) {
        lastStartupOutput = output.slice(0, started);
        const endpoints = [...lastStartupOutput.matchAll(/ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/gu)];
        output = output.slice(started + startupLine.length);
        const endpoint = endpoints.at(-1)?.[0];
        if (endpoint) return endpoint;
        throw new Error("托管宿主启动时未公布 OneBot 地址。");
      }
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`未读到下一次托管宿主启动。\n${output}\n${await stderr}`);
      output += decoder.decode(chunk.value, { stream: true });
    }
  }
  return {
    stderr, nextEndpoint,
    startupDiagnostics() {
      return lastStartupOutput + stderrOutput;
    },
    async open(endpoint: string, id?: number) {
      const client = gateway(endpoint, id);
      clients.push(client);
      await deadline(client.opened, "托管更新测试网关连接超时。");
      return client;
    },
    async stop() {
      supervisor.kill("SIGTERM");
      expect(await deadline(supervisor.exited, "托管更新测试宿主退出超时。", 12_000)).toBe(0);
    },
    async close() {
      for (const { socket } of clients) socket.close();
      if (supervisor.exitCode === null && supervisor.signalCode === null) {
        supervisor.kill("SIGTERM");
        await deadline(supervisor.exited, "托管更新测试清理失败。", 3_000).catch(() => supervisor.kill("SIGKILL"));
      }
      await supervisor.exited;
      await reader.cancel();
      reader.releaseLock();
    },
  };
}

// Preserve real timers and move only the fixture's wall clock past the cron after handoff.
const cronClock = `
  import { existsSync as fixtureExists, readFileSync as fixtureRead, writeFileSync as fixtureWrite } from "node:fs";
  const fixtureEpoch = Bun.env.FIXTURE_UPDATE_EPOCH;
  if (fixtureEpoch) {
    const DateConstructor = Date;
    const replacement = fixtureExists(fixtureEpoch);
    if (!replacement) fixtureWrite(fixtureEpoch, String(DateConstructor.now()));
    const started = Number(fixtureRead(fixtureEpoch, "utf8"));
    const defaultClock = Bun.env.FIXTURE_DEFAULT_UPDATE_CLOCK === "1";
    const tick = defaultClock ? DateConstructor.UTC(2026, 10, 25, 4, 30) : Math.floor(started / 60_000) * 60_000;
    const offset = tick - 4_000 - started;
    const now = () => DateConstructor.now() + offset + (!defaultClock && replacement ? 60_000 : 0);
    globalThis.Date = new Proxy(DateConstructor, {
      get: (target, key, receiver) => key === "now" ? now : Reflect.get(target, key, receiver),
      construct: (target, args, constructor) => Reflect.construct(target, args.length ? args : [now()], constructor),
      apply: () => new DateConstructor(now()).toString(),
    });
  }
`;

async function fixtureRepository(temporary: string, fail: boolean, audit?: string, schedule?: Schedule) {
  const writer = join(temporary, "writer");
  const active = join(temporary, "active");
  const remote = join(temporary, "origin.git");
  await mkdir(writer);
  await copyHost(writer);
  await mkdir(join(writer, "scripts"));
  await cp(new URL("../scripts/run-managed.ts", import.meta.url), join(writer, "scripts/run-managed.ts"));
  const dependencies = await realpath(join(writer, "node_modules"));
  await Promise.all([
    writeFile(join(writer, ".gitignore"), "/node_modules\n/config/\n/data/\n/logs/\n/plugins/local-fixture/\n"),
    writeFile(join(writer, "package.json"), JSON.stringify({
      name: "lotus-yunzai", private: true, type: "module", packageManager: `bun@${Bun.version}`,
      scripts: { typecheck: "bun scripts/fixture-typecheck.ts" },
    })),
    writeFile(join(writer, "scripts/bootstrap.ts"), `
      import { symlink } from "node:fs/promises";
      await symlink(${JSON.stringify(dependencies)}, new URL("../node_modules", import.meta.url), "dir");
    `),
    writeFile(join(writer, "scripts/fixture-typecheck.ts"), 'if (!await Bun.file("app.ts").exists()) process.exit(1);\n'),
  ]);
  if (audit) {
    const app = join(writer, "app.ts");
    const original = await readFile(app, "utf8");
    await writeFile(app, `
      import { appendFileSync as recordFixtureWorker } from "node:fs";
      if (Bun.env.LOTUS_MANAGED_TOKEN && Bun.env.FIXTURE_WORKER_AUDIT) {
        recordFixtureWorker(Bun.env.FIXTURE_WORKER_AUDIT, process.pid + " " + Bun.env.LOTUS_MANAGED_HELD + "\\n");
      }
      ${original}
    `);
  }
  if (schedule === "cron" || schedule === "legacy-default") {
    const app = join(writer, "app.ts");
    await writeFile(app, cronClock + await readFile(app, "utf8"));
  }
  if (schedule === "legacy-default") {
    const supervisor = join(writer, "scripts/run-managed.ts");
    // The parent validates receipt lifetimes too; use the same controlled wall clock.
    await writeFile(supervisor, cronClock + await readFile(supervisor, "utf8"));
  }
  git(temporary, "init", "--bare", "--quiet", "--initial-branch=main", remote);
  git(writer, "init", "--quiet", "--initial-branch=main");
  git(writer, "add", "--all");
  git(writer, "commit", "--quiet", "-m", "Fixture running host");
  const old = git(writer, "rev-parse", "HEAD");
  git(writer, "remote", "add", "origin", remote);
  git(writer, "push", "--quiet", "-u", "origin", "main");
  git(temporary, "clone", "--quiet", "--no-local", remote, active);

  if (fail) {
    const app = join(writer, "app.ts");
    const original = await readFile(app, "utf8");
    await writeFile(app, `
      if (Bun.env.FIXTURE_MANAGED_FAILURE === "1") {
        console.error(${JSON.stringify(liveFailure)});
        process.exit(23);
      }
      ${original}
    `);
  } else {
    await appendFile(join(writer, "app.ts"), "\n// Fixture successful candidate revision.\n");
  }
  git(writer, "add", "app.ts");
  git(writer, "commit", "--quiet", "-m", "Fixture candidate host");
  const candidate = git(writer, "rev-parse", "HEAD");
  git(writer, "push", "--quiet", "origin", "main");

  await mkdir(join(active, "config/config"), { recursive: true });
  await symlink(dependencies, join(active, "node_modules"), "dir");
  await writeFile(join(active, "config/config/other.yaml"), schedule
    ? 'master: ["99:51", "100:52"]\n' : 'master: ["99:51", "100:51"]\n');
  if (schedule) {
    const botConfig = {
      interval: "update_time: 0.025\n",
      "legacy-default": "file_watch: false\n",
      cron: 'update_cron: "0 * * * * *"\n',
    };
    await writeFile(join(active, "config/config/bot.yaml"), botConfig[schedule]);
  }
  disableMemberPrewarm(active);
  if (audit) {
    await Promise.all([mkdir(join(active, "data")), mkdir(join(active, "logs"))]);
    await Promise.all([
      writeFile(join(active, "data/fixture-state.txt"), "active host state"),
      writeFile(join(active, "logs/fixture-marker.txt"), "active host log"),
    ]);
  }
  const localPlugin = join(active, "plugins", "local-fixture");
  await mkdir(join(localPlugin, "config"), { recursive: true });
  await mkdir(join(localPlugin, "data"), { recursive: true });
  await Promise.all([
    writeFile(join(localPlugin, "package.json"), JSON.stringify({
      name: "local-fixture", type: "module", lotusYunzai: { entry: "./index.ts" },
    })),
    writeFile(join(localPlugin, "index.ts"), "export default { commands: {} };"),
    writeFile(join(localPlugin, "config/default.json"), '{"default":true}'),
    writeFile(join(localPlugin, "config/live.json"), '{"active":true}'),
    writeFile(join(localPlugin, "data/state.txt"), "active plugin state"),
    writeFile(join(localPlugin, ".env.local"), "FIXTURE_LOCAL_CONFIG=active\n"),
  ]);
  git(localPlugin, "init", "--quiet", "--initial-branch=main");
  git(localPlugin, "add", "package.json", "index.ts", "config/default.json");
  git(localPlugin, "commit", "--quiet", "-m", "Fixture independent plugin");
  const pluginRemote = join(temporary, "plugin.git");
  git(temporary, "init", "--bare", "--quiet", "--initial-branch=main", pluginRemote);
  git(localPlugin, "remote", "add", "origin", pluginRemote);
  git(localPlugin, "push", "--quiet", "-u", "origin", "main");
  return { active, old, candidate, localPlugin, pluginRemote, writer };
}

function expectText(frame: Frame, target: Target, message: RegExp) {
  expect(frame.action).toBe("send_msg");
  expect(frame.params).toMatchObject(target);
  expect(frame.params.message).toMatch(message);
}

async function expectVersion(client: Gateway, revision: string) {
  client.command("#版本", 42);
  const frame = await client.next();
  expectText(frame, { user_id: 42 }, /^Lotus-Yunzai 版本/u);
  expect(frame.params.message).toContain(`宿主提交　${revision.slice(0, 12)}`);
}

async function captureLocalChanges(repository: string, source: string) {
  return {
    head: git(repository, "rev-parse", "HEAD"),
    branch: git(repository, "symbolic-ref", "HEAD"),
    privateCommit: git(repository, "rev-parse", "refs/heads/fixture-private"),
    staged: git(repository, "ls-files", "--stage", "--", source),
    status: git(repository, "status", "--porcelain", "--untracked-files=no"),
    working: await readFile(join(repository, source), "utf8"),
  };
}

async function addLocalChanges(repository: string, source: string) {
  const file = join(repository, source);
  await appendFile(file, "\n// fixture private commit\n");
  git(repository, "add", source);
  git(repository, "commit", "--quiet", "-m", "Fixture private change");
  git(repository, "branch", "fixture-private");
  await appendFile(file, "\n// fixture staged change\n");
  git(repository, "add", source);
  await appendFile(file, "\n// fixture unstaged change\n");
  const captured = await captureLocalChanges(repository, source);
  expect(captured.status).toBe(`MM ${source}`);
  return captured;
}

async function exerciseUpdate(fail: boolean, updateTarget: UpdateTarget = "host", force = false) {
  const temporary = await mkdtemp(join(tmpdir(), "lotus-trss-managed-update-"));
  const prefix = updateTarget === "all" ? "全部" : "";
  const argument = updateTarget === "plugin" ? "local-fixture" : "";
  const command = `#${prefix}${force ? "强制" : ""}更新${argument}`;
  try {
    const audit = updateTarget === "all" ? join(temporary, "fixture-workers.txt") : undefined;
    const { active, old, candidate, localPlugin, pluginRemote } = await fixtureRepository(temporary, fail && updateTarget === "host", audit);
    const exitState = join(active, "data/fixture-v3-exit.txt");
    await mkdir(join(active, "data"), { recursive: true });
    await writeFile(join(active, "plugins/fixture-v3-exit.js"), `
      import { appendFile } from "node:fs/promises";
      export default class extends plugin {
        init() { Bot.once("exit", reason => appendFile("data/fixture-v3-exit.txt", reason + "\\n")); }
      }
    `);
    let candidatePlugin: string | undefined;
    if (updateTarget !== "host") {
      const writer = join(temporary, "plugin-writer");
      git(temporary, "clone", "--quiet", "--no-local", pluginRemote, writer);
      const entry = join(writer, "index.ts");
      const guard = fail ? `\nif (Bun.env.FIXTURE_MANAGED_FAILURE === "1") throw new Error(${JSON.stringify(liveFailure)});\n` : "";
      await appendFile(entry, `${guard}\n// fixture plugin candidate\n`);
      git(writer, "add", "index.ts");
      git(writer, "commit", "--quiet", "-m", "Fixture candidate plugin");
      git(writer, "push", "--quiet", "origin", "main");
      candidatePlugin = git(writer, "rev-parse", "HEAD");
    }
    if (force) {
      const app = join(active, "app.ts");
      const cleanSource = await readFile(app, "utf8");
      git(active, "fetch", "--quiet", "origin", "main");
      if (fail) {
        // Put the healthy local commit ahead of the failing upstream commit.
        git(active, "merge", "--quiet", "--ff-only", "origin/main");
        await writeFile(app, cleanSource);
      }
    }
    const localHost = force ? await addLocalChanges(active, "app.ts") : undefined;
    const localPluginState = force && updateTarget === "all" ? await addLocalChanges(localPlugin, "index.ts") : undefined;
    const initialHead = localHost?.head ?? old;
    const previousPlugin = git(localPlugin, "rev-parse", "HEAD");
    if (force) expect(git(active, "merge-base", initialHead, candidate)).toBe(fail ? candidate : old);

    const supervisor = bootSupervisor(active, { FIXTURE_WORKER_AUDIT: audit });
    const { nextEndpoint, open } = supervisor;

    try {
      const initialEndpoint = await deadline(nextEndpoint(), "托管更新测试宿主启动超时。");
      const initial = await open(initialEndpoint, 99);
      expect(git(active, "rev-parse", "HEAD")).toBe(initialHead);
      await expectVersion(initial, initialHead);

      initial.command(command, 42, 77, "owner");
      expectText(await initial.next(), { group_id: 77 }, /^暂无权限/u);
      const unbound = await open(initialEndpoint);
      unbound.command(command, 51);
      expectText(await unbound.next(), { user_id: 51 }, /^暂无权限/u);
      await expectVersion(unbound, initialHead);
      expect(git(active, "rev-parse", "HEAD")).toBe(initialHead);

      if (localHost) {
        initial.command("#更新", 51);
        expectText(await initial.next(), { user_id: 51 }, /^开始更新/u);
        expectText(await initial.next(), { user_id: 51 }, /工作区有未提交的修改/u);
        expect(await captureLocalChanges(active, "app.ts")).toEqual(localHost);
        await Bun.sleep(1_020);
        await expectVersion(initial, initialHead);
      }

      const groupId = fail ? 88 : undefined;
      const target: Target = groupId ? { group_id: groupId } : { user_id: 51 };
      initial.command(command, 51, groupId);
      expectText(await initial.next(10_000), target, force ? /^开始强制更新/u : /^开始更新/u);
      const [replacementEndpoint] = await Promise.all([
        deadline(nextEndpoint(), "更新后的托管宿主启动超时。", 16_000),
        deadline(initial.closed, "更新时旧连接没有关闭。", 16_000),
      ]);
      expect(await readFile(exitState, "utf8")).toBe("restart\n");
      const expected = fail || updateTarget === "plugin" ? initialHead : candidate;
      expect(git(active, "rev-parse", "HEAD")).toBe(expected);
      expect(git(localPlugin, "rev-parse", "HEAD")).toBe(fail ? previousPlugin : candidatePlugin ?? previousPlugin);
      expect(await readFile(join(active, "config/config/other.yaml"), "utf8")).toBe('master: ["99:51", "100:51"]\n');
      expect(await readFile(join(localPlugin, "config/default.json"), "utf8")).toBe('{"default":true}');
      expect(await readFile(join(localPlugin, "config/live.json"), "utf8")).toBe('{"active":true}');
      expect(await readFile(join(localPlugin, "data/state.txt"), "utf8")).toBe("active plugin state");
      expect(await readFile(join(localPlugin, ".env.local"), "utf8")).toBe("FIXTURE_LOCAL_CONFIG=active\n");
      if (localHost) {
        if (fail) {
          expect(await captureLocalChanges(active, "app.ts")).toEqual(localHost);
        } else {
          const backups = (await readdir(temporary)).filter((entry) => entry.startsWith(".active.lotus-previous-"));
          expect(backups).toHaveLength(1);
          const backup = join(temporary, backups[0]!);
          expect(await captureLocalChanges(backup, "app.ts")).toEqual(localHost);
          expect(git(active, "status", "--porcelain", "--untracked-files=no")).toBe("");
          if (localPluginState) {
            expect(await captureLocalChanges(join(backup, "plugins/local-fixture"), "index.ts")).toEqual(localPluginState);
            expect(git(localPlugin, "status", "--porcelain", "--untracked-files=no")).toBe("");
          }
        }
      }
      const otherBot = await open(replacementEndpoint, 100);
      await expectVersion(otherBot, expected);
      const originalBot = await open(replacementEndpoint, 99);
      const receipt = await originalBot.next();
      expectText(receipt, target, fail ? /^更新失败，已恢复旧版本/u : /^更新成功/u);
      if (!fail) {
        const reported = updateTarget === "plugin" ? candidatePlugin! : candidate;
        expect(receipt.params.message).toContain(reported.slice(0, 12));
        if (updateTarget === "all") expect(receipt.params.message).toContain("本次更新 2 个仓库");
        if (force) {
          expect(receipt.params.message).toContain("原工作区已保留");
          expect(receipt.params.message).not.toContain(temporary);
        }
      }
      await expectVersion(originalBot, expected);
      const reconnect = await open(replacementEndpoint, 99);
      await Bun.sleep(1_020);
      await expectVersion(reconnect, expected);
      expect(otherBot.frames).toEqual([]);
      expect(reconnect.frames).toEqual([]);
      if (audit) {
        const generations = (await readFile(audit, "utf8")).trim().split("\n").map((row) => row.split(" "));
        expect(generations.map(([, held]) => held)).toEqual(fail ? ["0", "1", "0"] : ["0", "1"]);
        expect(new Set(generations.map(([pid]) => pid)).size).toBe(generations.length);
        expect(await readFile(join(active, "data/fixture-state.txt"), "utf8")).toBe("active host state");
        expect(await readFile(join(active, "logs/fixture-marker.txt"), "utf8")).toBe("active host log");
      }

      await supervisor.stop();
      expect(await readFile(exitState, "utf8")).toBe("restart\nexit\n");
      const stderr = await supervisor.stderr;
      if (fail) {
        expect(stderr).toContain(liveFailure);
        expect(stderr).toContain("候选宿主未能完成交接");
      } else {
        expect(stderr).not.toContain(liveFailure);
      }
    } finally {
      await supervisor.close();
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

test.skipIf(!Bun.which("git"))("托管 #更新 应用宿主候选并只向原私聊发送一次成功回执", () => exerciseUpdate(false), 35_000);

async function exerciseRetainedPluginFailure(kind: "directory" | "standalone" | "sibling") {
  const temporary = await mkdtemp(join(tmpdir(), "lotus-managed-retained-plugin-"));
  try {
    const { active, old, localPlugin, writer } = await fixtureRepository(temporary, false);
    const guarded = 'if (Bun.env.FIXTURE_RETAINED_PLUGIN_FAILURE === "1") throw new Error("fixture retained plugin load failure");';
    const legacyScript = (command: string, reply: string) => `
      export default class extends plugin {
        constructor() { super({ event: "message.private", rule: [{ reg: "^${command}$", fnc: "run" }] }); }
        async run(event) { return event.reply(${JSON.stringify(reply)}); }
      }
    `;
    if (kind === "standalone") {
      await writeFile(join(active, "plugins", "retained-fixture.js"), guarded + legacyScript("#保留插件样本", "原插件可用"));
    } else {
      if (kind === "sibling") {
        await writeFile(join(localPlugin, "package.json"), '{"name":"local-fixture","type":"module"}');
        await writeFile(join(localPlugin, "retained-fixture.js"), guarded + legacyScript("#保留插件样本", "原插件可用"));
        await writeFile(join(localPlugin, "healthy-sibling.js"), legacyScript("#健康入口样本", "同目录入口可用"));
        git(localPlugin, "add", "package.json", "retained-fixture.js", "healthy-sibling.js");
      } else {
        await writeFile(join(localPlugin, "index.ts"), guarded + '\nexport default { commands: { "#保留插件样本": () => "原插件可用" } };');
        git(localPlugin, "add", "index.ts");
      }
      git(localPlugin, "commit", "--quiet", "-m", "Fixture retained plugin command");
    }
    const app = join(writer, "app.ts");
    const source = await readFile(app, "utf8");
    await writeFile(app, `
      if (Bun.env.LOTUS_MANAGED_HELD === "1") Bun.env.FIXTURE_RETAINED_PLUGIN_FAILURE = "1";
      ${source}
    `);
    git(writer, "add", "app.ts");
    git(writer, "commit", "--quiet", "-m", "Fixture retained plugin fails during handoff");
    git(writer, "push", "--quiet", "origin", "main");

    const supervisor = bootSupervisor(active);
    async function checkPlugin(client: Gateway) {
      client.command("#保留插件样本", 51);
      expectText(await client.next(), { user_id: 51 }, /^原插件可用$/u);
      if (kind === "sibling") {
        client.command("#健康入口样本", 51);
        expectText(await client.next(), { user_id: 51 }, /^同目录入口可用$/u);
      }
    }
    try {
      const first = await supervisor.open(await deadline(supervisor.nextEndpoint(), "插件测试宿主未启动。"), 99);
      await checkPlugin(first);
      first.command("#更新", 51);
      expectText(await first.next(), { user_id: 51 }, /^开始更新/u);
      const restored = await supervisor.open(await deadline(supervisor.nextEndpoint(), "插件更新后未恢复宿主。", 16_000), 99);
      expectText(await restored.next(), { user_id: 51 }, /已恢复旧版本/u);
      expect(git(active, "rev-parse", "HEAD")).toBe(old);
      await checkPlugin(restored);
    } finally {
      await supervisor.close();
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

test.skipIf(!Bun.which("git"))("只更新宿主时已保留的目录插件加载失败会回退", () => exerciseRetainedPluginFailure("directory"), 35_000);
test.skipIf(!Bun.which("git"))("只更新宿主时已保留的独立 V3 脚本加载失败会回退", () => exerciseRetainedPluginFailure("standalone"), 35_000);
test.skipIf(!Bun.which("git"))("只更新宿主时同目录的 V3 兄弟入口不能掩盖失败", () => exerciseRetainedPluginFailure("sibling"), 35_000);

test.skipIf(!Bun.which("git"))("托管更新保留本地 V3 插件的包内相对入口链接", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "lotus-managed-plugin-link-"));
  try {
    const { active, candidate, localPlugin } = await fixtureRepository(temporary, false);
    await rename(join(localPlugin, ".git"), join(temporary, "fixture-plugin-git"));
    await writeFile(join(localPlugin, "package.json"), '{"name":"local-fixture","type":"module"}');
    await writeFile(join(localPlugin, "linked.js"), `
      export default class extends plugin {
        constructor() { super({ event: "message.private", rule: [{ reg: "^#链接入口样本$", fnc: "run" }] }); }
        async run(event) { return event.reply("链接入口可用"); }
      }
    `);
    const entry = join(localPlugin, "index.js");
    await symlink("./linked.js", entry);
    const supervisor = bootSupervisor(active);
    async function probe(client: Gateway) {
      client.command("#链接入口样本", 51);
      expectText(await client.next(), { user_id: 51 }, /^链接入口可用$/u);
    }
    try {
      const running = await supervisor.open(await deadline(supervisor.nextEndpoint(), "入口链接测试宿主未启动。"), 99);
      await probe(running);
      running.command("#静更新", 51);
      const updated = await supervisor.open(await deadline(supervisor.nextEndpoint(), "候选未接回入口链接。", 15_000), 99);
      expectText(await updated.next(), { user_id: 51 }, /^更新成功/u);
      await probe(updated);
      expect(await readlink(entry)).toBe("./linked.js");
      expect(git(active, "rev-parse", "HEAD")).toBe(candidate);
    } finally {
      await supervisor.close();
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 35_000);

test.skipIf(!Bun.which("git"))("保留内存中仍可用的 V3 脚本，磁盘修复后才重新切换", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "lotus-managed-hot-plugin-"));
  try {
    const { active, old, candidate, localPlugin } = await fixtureRepository(temporary, false);
    await rename(join(localPlugin, ".git"), join(temporary, "fixture-plugin-git"));
    const entry = join(localPlugin, "entry.js");
    const legacyScript = (command: string, reply: string) => `
      export default class extends plugin {
        constructor() { super({ event: "message.private", rule: [{ reg: "^${command}$", fnc: "run" }] }); }
        async run(event) { return event.reply(${JSON.stringify(reply)}); }
      }
    `;
    const initial = legacyScript("#待热重载样本", "旧脚本可用");
    const reloaded = legacyScript("#待热重载样本", "新版脚本可用");
    const broken = 'throw new Error("fixture hot reload failure");\n' + reloaded;
    await Promise.all([
      appendFile(join(active, "config/config/bot.yaml"), "file_watch: true\n"),
      writeFile(join(localPlugin, "package.json"), '{"name":"local-fixture","type":"module"}'),
      writeFile(join(localPlugin, "healthy.js"), legacyScript("#同目录样本", "同目录入口可用")),
      writeFile(entry, initial),
    ]);
    const supervisor = bootSupervisor(active);
    try {
      const running = await supervisor.open(await deadline(supervisor.nextEndpoint(), "脚本测试宿主未启动。"), 99);
      async function probe(client: Gateway) {
        client.command("#待热重载样本", 51);
        const frame = await client.next();
        expect(frame.params.user_id).toBe(51);
        return frame.params.message;
      }
      expect(await probe(running)).toBe("旧脚本可用");
      await writeFile(entry, reloaded);
      const until = Date.now() + 10_000;
      let reply: string;
      do {
        await Bun.sleep(1_020);
        reply = await probe(running);
      } while (reply === "旧脚本可用" && Date.now() < until);
      expect(reply).toBe("新版脚本可用");

      running.command("#更新", 51);
      expectText(await running.next(), { user_id: 51 }, /^开始更新/u);
      expectText(await running.next(), { user_id: 51 }, /^正在准备候选版本/u);
      await writeFile(entry, broken);
      expectText(await running.next(15_000), { user_id: 51 }, /^更新失败，请检查宿主日志。$/u);
      await Bun.sleep(1_020);
      expect(await probe(running)).toBe("新版脚本可用");
      expect(git(active, "rev-parse", "HEAD")).toBe(old);
      expect(await readFile(entry, "utf8")).toBe(broken);

      await writeFile(entry, reloaded);
      const retryUntil = Date.now() + 5_000;
      let status: Frame;
      do {
        await Bun.sleep(1_020);
        running.command("#更新", 51);
        status = await running.next();
      } while (status.params.message.startsWith("已有更新") && Date.now() < retryUntil);
      expectText(status, { user_id: 51 }, /^开始更新/u);
      expectText(await running.next(), { user_id: 51 }, /^正在准备候选版本/u);
      expectText(await running.next(), { user_id: 51 }, /^正在切换到候选版本/u);
      const updated = await supervisor.open(await deadline(supervisor.nextEndpoint(), "修复脚本后的候选未启动。", 15_000), 99);
      expectText(await updated.next(), { user_id: 51 }, /^更新成功/u);
      expect(await probe(updated)).toBe("新版脚本可用");
      expect(git(active, "rev-parse", "HEAD")).toBe(candidate);
    } finally {
      await supervisor.close();
    }
    expect(await supervisor.stderr).toContain('V3 脚本 "local-fixture/entry.js" 与当前生效版本不同');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 35_000);

async function exercisePublicListenerUpdate(fault?: "http" | "onebot" | "port") {
  const temporary = await mkdtemp(join(tmpdir(), "lotus-managed-plain-listeners-"));
  try {
    const { active, old, candidate, writer } = await fixtureRepository(temporary, false);
    if (fault) {
      const app = join(writer, "app.ts");
      const source = await readFile(app, "utf8");
      const originalHttp = "const http = network.http ??";
      let changed = source;
      if (fault === "http") {
        expect(source.includes(originalHttp)).toBe(true);
        changed = source.replace(originalHttp, "const http = !handoff.accepting ? undefined : network.http ??");
      } else {
        const listenerSettings = /const \{ ([^{}\r\n]*\boneBot\b[^{}\r\n]*) \} = network;/u;
        expect(listenerSettings.test(source)).toBe(true);
        const broken = fault === "onebot" ? "undefined" : "{ ...network.oneBot, port: 0 }";
        changed = source.replace(listenerSettings, (_line, fields: string) => {
          const otherFields = fields.split(", ").filter(field => field !== "oneBot").join(", ");
          return `const { ${otherFields} } = network;
            const oneBot = handoff.accepting || !network.oneBot ? network.oneBot : ${broken};`;
        });
      }
      await writeFile(app, changed);
      git(writer, "add", "app.ts");
      git(writer, "commit", "--quiet", "-m", "Fixture loses plain listener only in candidate");
      git(writer, "push", "--quiet", "origin", "main");
    }
    const reserve = () => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const [http, ws] = [reserve(), reserve()];
    const [httpPort, wsPort] = [http.port, ws.port];
    http.stop(true);
    ws.stop(true);
    const publicEndpoint = `http://127.0.0.1:${httpPort}/status`;
    const wsEndpoint = `ws://127.0.0.1:${wsPort}/OneBotv11`;
    const httpToken = "managed-update-public-http-fixture";
    const supervisor = bootSupervisor(active, {
      LOTUS_ONEBOT_PORT: String(wsPort), LOTUS_HTTP_PORT: String(httpPort), LOTUS_HTTP_TOKEN: httpToken,
    });
    async function expectPublic(revision: string) {
      expect((await fetch(publicEndpoint, { signal: AbortSignal.timeout(2_000) })).status).toBe(401);
      const response = await fetch(publicEndpoint, {
        headers: { Authorization: `Bearer ${httpToken}` }, signal: AbortSignal.timeout(2_000),
      });
      expect(response.status).toBe(200);
      expect((await response.json()).revision).toBe(revision);
    }
    try {
      expect(await deadline(supervisor.nextEndpoint(), "原宿主未启动。")).toBe(wsEndpoint);
      const running = await supervisor.open(wsEndpoint, 99);
      await expectPublic(old);
      running.command("#静更新", 51);
      expect(await deadline(supervisor.nextEndpoint(), "交接后缺少 OneBot 启动记录。", 15_000)).toBe(wsEndpoint);
      const updated = await supervisor.open(wsEndpoint, 99);
      const expected = fault ? old : candidate;
      expectText(await updated.next(), { user_id: 51 }, fault ? /已恢复旧版本/u : /^更新成功/u);
      await expectPublic(expected);
      await expectVersion(updated, expected);
      expect(git(active, "rev-parse", "HEAD")).toBe(expected);
    } finally {
      await supervisor.close();
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

test.skipIf(!Bun.which("git"))("分开的公共 HTTP 和 OneBot 固定端口在托管更新后继续可用", () => exercisePublicListenerUpdate(), 35_000);
test.skipIf(!Bun.which("git"))("托管更新在候选丢失公共 HTTP 时回退", () => exercisePublicListenerUpdate("http"), 35_000);
test.skipIf(!Bun.which("git"))("托管更新在候选丢失 OneBot 监听时回退", () => exercisePublicListenerUpdate("onebot"), 35_000);
test.skipIf(!Bun.which("git"))("托管更新在候选改用其他 OneBot 端口时回退", () => exercisePublicListenerUpdate("port"), 35_000);

test.skipIf(!Bun.which("git"))("托管更新保留旧主人配置和 dotenv 链接指向的本机文件", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "lotus-managed-linked-config-"));
  try {
    const { active, old, candidate } = await fixtureRepository(temporary, false);
    const local = join(active, "local-settings");
    const config = join(active, "config/config/other.yaml");
    const dotenv = join(active, ".env");
    const httpToken = "managed-linked-dotenv-fixture";
    await mkdir(local);
    await rename(config, join(local, "owner.yaml"));
    await writeFile(join(local, "worker.env"), `LOTUS_HTTP_TOKEN=${httpToken}\n`);
    await symlink("../../local-settings/owner.yaml", config);
    await symlink("local-settings/worker.env", dotenv);
    const supervisor = bootSupervisor(active);
    async function checkStatus(endpoint: string, revision: string) {
      const status = endpoint.replace(/^ws:/u, "http:").replace(/OneBotv11$/u, "status");
      const response = await fetch(status, { headers: { Authorization: `Bearer ${httpToken}` } });
      expect(response.status).toBe(200);
      expect((await response.json()).revision).toBe(revision);
      expect((await fetch(status)).status).toBe(401);
    }
    try {
      const original = await deadline(supervisor.nextEndpoint(), "原宿主未启动。");
      await checkStatus(original, old);
      const first = await supervisor.open(original, 99);
      first.command("#静更新", 51);
      const replacement = await deadline(supervisor.nextEndpoint(), "候选未启动。", 15_000);
      await checkStatus(replacement, candidate);
      const updated = await supervisor.open(replacement, 99);
      expectText(await updated.next(), { user_id: 51 }, /^更新成功/u);
      updated.command("#更新", 51);
      expectText(await updated.next(), { user_id: 51 }, /^开始更新/u);
      expectText(await updated.next(), { user_id: 51 }, /^当前已是最新版本/u);
      expect(await readlink(config)).toBe("../../local-settings/owner.yaml");
      expect(await readlink(dotenv)).toBe("local-settings/worker.env");
      expect(await readFile(dotenv, "utf8")).toBe(`LOTUS_HTTP_TOKEN=${httpToken}\n`);
    } finally {
      await supervisor.close();
    }
    const restarted = bootSupervisor(active);
    try {
      const endpoint = await deadline(restarted.nextEndpoint(), "冷启动未恢复。");
      await checkStatus(endpoint, candidate);
    } finally {
      await restarted.close();
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 30_000);

test.skipIf(!Bun.which("git"))("托管更新在候选未确认激活时恢复原宿主", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "lotus-managed-activation-ack-"));
  try {
    const { active, old, writer } = await fixtureRepository(temporary, false);
    const marker = join(temporary, "activation-received");
    const module = join(writer, "lib", "managed-handoff.ts");
    const source = await readFile(module, "utf8");
    const site = "activation.resolve(true);";
    expect(source).toContain(site);
    await writeFile(module, source.replace(site, `{ void Bun.write(${JSON.stringify(marker)}, "received"); }`));
    git(writer, "add", "lib/managed-handoff.ts");
    git(writer, "commit", "--quiet", "-m", "Fixture receives activation but stays held");
    git(writer, "push", "--quiet", "origin", "main");

    const supervisor = bootSupervisor(active);
    try {
      const first = await supervisor.open(await deadline(supervisor.nextEndpoint(), "原宿主未启动。"), 99);
      await expectVersion(first, old);
      first.command("#静更新", 51);
      await deadline(first.closed, "原宿主未开始交接。");
      const until = Date.now() + 8_000;
      while (!await Bun.file(marker).exists() && Date.now() < until) await Bun.sleep(25);
      expect(await Bun.file(marker).text()).toBe("received");
      const restored = await supervisor.open(await deadline(supervisor.nextEndpoint(), "候选未确认激活，旧宿主也未恢复。", 9_000), 99);
      expectText(await restored.next(), { user_id: 51 }, /已恢复旧版本/u);
      await expectVersion(restored, old);
      expect(git(active, "rev-parse", "HEAD")).toBe(old);
    } finally {
      await supervisor.close();
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 25_000);

async function exerciseTlsUpdate(fault?: "bind" | "wss" | "port") {
  const temporary = await mkdtemp(join(tmpdir(), "lotus-managed-tls-ready-"));
  try {
    const { active, old, candidate, writer } = await fixtureRepository(temporary, false);
    if (fault) {
      const app = join(writer, "app.ts");
      const source = await readFile(app, "utf8");
      const site = "const oneBotAuth = https.oneBotAuth;";
      expect(source).toContain(site);
      const port = "const port = https.port;";
      expect(source).toContain(port);
      const changed = fault === "port"
        ? source.replace(port, "const port = handoff.accepting ? https.port : 0;")
        : source.replace(site, fault === "bind"
          ? "if (!handoff.accepting) throw new Error('fixture TLS listener failure');\n          " + site
          : "const oneBotAuth = handoff.accepting ? https.oneBotAuth : undefined;");
      await writeFile(app, changed);
      git(writer, "add", "app.ts");
      git(writer, "commit", "--quiet", "-m", "Fixture TLS listener failure during handoff");
      git(writer, "push", "--quiet", "origin", "main");
    }

    const config = join(active, "config");
    const cert = join(config, "fixture.crt");
    const key = join(config, "fixture.key");
    const generated = Bun.spawnSync([Bun.which("openssl")!, "req", "-x509", "-nodes", "-newkey", "rsa:2048",
      "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert]);
    expect(generated.exitCode).toBe(0);
    const ca = await readFile(cert, "utf8");
    const reservation = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = reservation.port;
    // Prepare the certificate first and keep this fixed port reserved until the supervisor can spawn.
    try {
      await writeFile(join(config, "server.yaml"), Bun.YAML.stringify({ https: { port, cert, key } }));
    } finally {
      reservation.stop(true);
    }
    const supervisor = bootSupervisor(active);
    async function checkTls(revision: string) {
      const endpoint = `https://127.0.0.1:${port}/status`;
      try {
        const response = await fetch(endpoint, {
          proxy: false, tls: { ca }, signal: AbortSignal.timeout(2_000),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ revision });
      } catch (error) {
        throw new Error(`托管宿主在 ${endpoint} 的 TLS 验证失败（${revision}）。\n${supervisor.startupDiagnostics()}`, { cause: error });
      }
    }
    try {
      const first = await supervisor.open(await deadline(supervisor.nextEndpoint(), "TLS 测试宿主未启动。"), 99);
      await checkTls(old);
      first.command("#更新", 51);
      expectText(await first.next(), { user_id: 51 }, /^开始更新/u);
      const replacement = await supervisor.open(await deadline(supervisor.nextEndpoint(), "TLS 更新后未启动宿主。", 16_000), 99);
      expectText(await replacement.next(), { user_id: 51 }, fault ? /已恢复旧版本/u : /^更新成功/u);
      const revision = fault ? old : candidate;
      expect(git(active, "rev-parse", "HEAD")).toBe(revision);
      await checkTls(revision);
    } finally {
      await supervisor.close();
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

const canTestTlsUpdate = Boolean(Bun.which("git") && Bun.which("openssl"));
test.skipIf(!canTestTlsUpdate)("托管 #更新 在候选无法接回 TLS 监听时恢复原版本", () => exerciseTlsUpdate("bind"), 35_000);
test.skipIf(!canTestTlsUpdate)("托管 #更新 在候选只接回 HTTPS 但丢失 WSS 时恢复原版本", () => exerciseTlsUpdate("wss"), 35_000);
test.skipIf(!canTestTlsUpdate)("托管 #更新 在候选改用其他 TLS 端口时恢复原版本", () => exerciseTlsUpdate("port"), 35_000);
test.skipIf(!canTestTlsUpdate)("托管 #更新 在候选接回 TLS 监听时继续切换", () => exerciseTlsUpdate(), 35_000);

const valkeyServer = Bun.which("valkey-server");

async function exerciseValkeyUpdate(
  scenario: "same-old" | "same-default" | "drop" | "edited" | "edited-dotenv" | "late-edit",
) {
  const temporary = await mkdtemp(join(tmpdir(), "lotus-managed-storage-ready-"));
  const reservation = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = reservation;
  reservation.stop(true);
  const password = "isolated-valkey-credential";
  const valkey = Bun.spawn([
    valkeyServer!, "--bind", "127.0.0.1", "--port", String(port), "--save", "", "--appendonly", "no", "--dir", temporary,
    "--requirepass", password,
  ], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  try {
    const { active, old, candidate, writer } = await fixtureRepository(temporary, false);
    const file = join(active, scenario === "same-default" ? "config/redis.yaml" : "config/config/redis.yaml");
    const newConfig = Bun.YAML.stringify({ host: "127.0.0.1", port, db: 4, password });
    const url = (db: number) => `LOTUS_VALKEY_URL=redis://:${password}@127.0.0.1:${port}/${db}\n`;
    const changedBefore = scenario === "edited" || scenario === "edited-dotenv";
    const expectRollback = scenario === "drop" || scenario === "late-edit";
    if (expectRollback) {
      const app = join(writer, "app.ts");
      const source = await readFile(app, "utf8");
      const readSettings = "probingUpdate ? undefined : await readStorageConnection(";
      expect(source).toContain(readSettings);
      await writeFile(app, scenario === "drop" ? source.replace(readSettings,
        "probingUpdate || !handoff.accepting ? undefined : await readStorageConnection(")
        : source.replace("    const restoredStorage = await handoff.restoreStorage(lifecycle.signal);",
          `    if (!probingUpdate && !handoff.accepting) await Bun.write(new URL("config/config/redis.yaml", root), ${JSON.stringify(newConfig)});
    const restoredStorage = await handoff.restoreStorage(lifecycle.signal);`));
      git(writer, "add", "app.ts");
      git(writer, "commit", "--quiet", "-m", "Fixture Valkey failure during handoff");
      git(writer, "push", "--quiet", "origin", "main");
    }
    await writeFile(file, Bun.YAML.stringify({ host: "127.0.0.1", port, password, ...(scenario !== "same-default" && { db: 3 }) }));
    if (scenario === "edited-dotenv") {
      await appendFile(join(active, ".git/info/exclude"), "\n.env\n");
      await writeFile(join(active, ".env"), url(3));
    }
    await appendFile(join(active, "config/config/bot.yaml"), "online_msg_exp: 0\n");
    await writeFile(join(active, "plugins/storage-fixture.js"), `
      export default class extends plugin {
        constructor() { super({ event: "message.private", rule: [
          { reg: "^#写存储样本$", fnc: "save" }, { reg: "^#读存储样本$", fnc: "read" },
        ] }); }
        async save(event) { await redis.set("storage-fixture:key", "原存储样本"); return this.read(event); }
        async read(event) {
          return event.reply((await redis?.get("storage-fixture:key") ?? "缺少存储") + " / " + process.pid);
        }
      }
    `);

    const supervisor = bootSupervisor(active);
    let changed = false;
    try {
      const first = await supervisor.open(await deadline(supervisor.nextEndpoint(), "存储测试宿主未启动。"), 99);
      first.command("#写存储样本", 51);
      const initial = await first.next();
      expectText(initial, { user_id: 51 }, /^原存储样本 \/ \d+$/u);
      if (changedBefore) {
        if (scenario === "edited-dotenv") await writeFile(join(active, ".env"), url(4));
        else await writeFile(file, newConfig);
      }
      first.command("#更新", 51);
      expectText(await first.next(), { user_id: 51 }, /^开始更新/u);
      if (changedBefore) {
        expectText(await first.next(), { user_id: 51 }, /Valkey 配置已变更.*当前宿主继续运行/u);
        expect(git(active, "rev-parse", "HEAD")).toBe(old);
        first.command("#读存储样本", 51);
        const stayed = await first.next();
        expectText(stayed, { user_id: 51 }, /^原存储样本 \/ \d+$/u);
        expect(stayed.params.message).toBe(initial.params.message);
        changed = true;
      } else {
        const replacement = await supervisor.open(await deadline(supervisor.nextEndpoint(), "存储更新后未启动宿主。", 16_000), 99);
        expectText(await replacement.next(), { user_id: 51 }, expectRollback ? /已恢复旧版本/u : /^更新成功/u);
        expect(git(active, "rev-parse", "HEAD")).toBe(expectRollback ? old : candidate);
        replacement.command("#读存储样本", 51);
        const reply = await replacement.next();
        expectText(reply, { user_id: 51 }, /^原存储样本 \/ \d+$/u);
        expect(reply.params.message).not.toBe(initial.params.message);
        changed = scenario === "late-edit";
      }
    } finally {
      await supervisor.close();
    }
    if (changed) {
      const config = scenario === "edited-dotenv" ? join(active, ".env") : file;
      expect(await readFile(config, "utf8")).toBe(scenario === "edited-dotenv" ? url(4) : newConfig);
      const cold = bootSupervisor(active);
      try {
        const restarted = await cold.open(await deadline(cold.nextEndpoint(), "Valkey 更改后冷启动失败。"), 99);
        restarted.command("#读存储样本", 51);
        expectText(await restarted.next(), { user_id: 51 }, /^缺少存储 \/ \d+$/u);
        const original = Bun.spawnSync([Bun.which("valkey-cli")!, "-h", "127.0.0.1", "-p", String(port), "-n", "3", "--raw",
          "GET", "storage-fixture:key"], { env: { ...process.env, REDISCLI_AUTH: password } });
        expect(original.exitCode).toBe(0);
        expect(original.stdout.toString().trim()).toBe("原存储样本");
      } finally { await cold.close(); }
    }
  } finally {
    valkey.kill("SIGKILL");
    await valkey.exited;
    await rm(temporary, { recursive: true, force: true });
  }
}

const canTestValkeyUpdate = Boolean(valkeyServer && Bun.which("valkey-cli") && Bun.which("git"));
test.skipIf(!canTestValkeyUpdate)("托管 #更新 在候选漏接已有 Valkey 时恢复原版本和原数据", () => exerciseValkeyUpdate("drop"), 35_000);
test.skipIf(!canTestValkeyUpdate)("托管 #更新 在候选接回 Valkey 后继续读取同库数据", () => exerciseValkeyUpdate("same-old"), 35_000);

test.skipIf(!canTestValkeyUpdate)("托管 #更新 保留当前主 YAML 缺省的 Valkey DB", () => exerciseValkeyUpdate("same-default"), 35_000);
test.skipIf(!canTestValkeyUpdate)("托管 #更新 拒绝在线改动旧 Valkey DB 且原会话继续运行", () => exerciseValkeyUpdate("edited"), 35_000);
test.skipIf(!canTestValkeyUpdate)("托管 #更新 拒绝在线改动 dotenv Valkey 且原会话继续运行", () => exerciseValkeyUpdate("edited-dotenv"), 35_000);
test.skipIf(!canTestValkeyUpdate)("托管 #更新 末刻变更 Valkey 时拒绝接管并用运行时原设置恢复", () => exerciseValkeyUpdate("late-edit"), 35_000);

test.skipIf(!Bun.which("git"))("托管 #更新 后 V3 插件仍可分享自定义目录中的原图", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "lotus-managed-public-images-"));
  try {
    const { active, candidate } = await fixtureRepository(temporary, false);
    const directory = "generated images";
    const picture = "原图.png";
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=", "base64");
    await mkdir(join(active, directory));
    await writeFile(join(active, directory, picture), png);
    const imageDirectory = process.platform === "win32" ? directory : join(temporary, "share-images");
    if (imageDirectory !== directory) {
      await symlink(join(active, directory), join(temporary, "image-storage"));
      await symlink("image-storage", imageDirectory);
    }
    await writeFile(join(active, "plugins", "public-image-fixture.js"), `
      export default class extends plugin {
        constructor() { super({ event: "message.private", rule: [{ reg: "^#分享原图$", fnc: "share" }] }); }
        async share(event) { return event.reply(String(await Bot.imageToUrl(${JSON.stringify(join(imageDirectory, picture))}))); }
      }
    `);
    const supervisor = bootSupervisor(active, { LOTUS_HTTP_PORT: "0", LOTUS_PUBLIC_IMAGE_DIR: imageDirectory });
    async function checkPicture(client: Gateway) {
      client.command("#分享原图", 51);
      const frame = await client.next();
      expectText(frame, { user_id: 51 }, /^http:\/\/127\.0\.0\.1:\d+\/File\//u);
      const response = await fetch(frame.params.message, { proxy: false, signal: AbortSignal.timeout(3_000) });
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
    }
    try {
      const first = await supervisor.open(await deadline(supervisor.nextEndpoint(), "图像测试宿主未启动。"), 99);
      await checkPicture(first);
      first.command("#更新", 51);
      expectText(await first.next(), { user_id: 51 }, /^开始更新/u);
      const endpoint = await deadline(supervisor.nextEndpoint(), "图像测试候选未接管。", 16_000)
        .catch(async error => { await supervisor.stop(); throw new Error(await supervisor.stderr, { cause: error }); });
      const replacement = await supervisor.open(endpoint, 99);
      expectText(await replacement.next(), { user_id: 51 }, /^更新成功/u);
      expect(git(active, "rev-parse", "HEAD")).toBe(candidate);
      await checkPicture(replacement);
    } finally {
      await supervisor.close();
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 35_000);
test.skipIf(!Bun.which("git"))("托管 #更新 在活动环境失败时恢复旧 HEAD 并回复原群", () => exerciseUpdate(true), 35_000);
test.skipIf(!Bun.which("git"))("指定外部插件更新保留宿主提交并回报插件提交", () => exerciseUpdate(false, "plugin"), 35_000);
test.skipIf(!Bun.which("git"))("目标插件在实际环境拒绝加载时回退，宿主就绪不能掩盖失败", () => exerciseUpdate(true, "plugin"), 35_000);
test.skipIf(!Bun.which("git"))("#全部更新一次切换宿主和外部插件，向原会话报告两个仓库", () => exerciseUpdate(false, "all"), 35_000);
test.skipIf(!Bun.which("git"))("#全部更新遇到仅在活动环境加载失败的插件时整批回滚", () => exerciseUpdate(true, "all"), 35_000);
test.skipIf(!Bun.which("git"))("#强制更新对齐分叉的宿主并归档私有分支和暂存区", () => exerciseUpdate(false, "host", true), 35_000);
test.skipIf(!Bun.which("git"))("#强制更新对齐领先的宿主失败后恢复原分支和暂存区", () => exerciseUpdate(true, "host", true), 35_000);
test.skipIf(!Bun.which("git"))("#全部强制更新同时对齐宿主和插件并归档两份本地修改", () => exerciseUpdate(false, "all", true), 35_000);

function milkyUpdateGateway(token: string, botId: number) {
  const sockets = [Promise.withResolvers<Bun.ServerWebSocket<number>>(), Promise.withResolvers<Bun.ServerWebSocket<number>>()];
  const firstClosed = Promise.withResolvers<void>();
  const releaseReplacement = Promise.withResolvers<void>();
  const frames: Frame[] = [];
  let available = Promise.withResolvers<void>();
  let generations = 0;
  let messageId = 0;
  let receiptId = 0;
  const time = 1_700_000_000;
  const server = Bun.serve<number>({
    hostname: "127.0.0.1", port: 0,
    async fetch(request, gateway) {
      if (request.headers.get("Authorization") !== `Bearer ${token}`) return new Response(null, { status: 401 });
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/event") {
        const generation = generations++;
        if (generation > 0) await releaseReplacement.promise;
        if (gateway.upgrade(request, { data: generation })) return;
        return new Response(null, { status: 426 });
      }
      if (request.method !== "POST") return new Response(null, { status: 405 });
      if (path === "/api/get_login_info") {
        return Response.json({ status: "ok", retcode: 0, data: { uin: botId, nickname: "托管更新夹具" } });
      }
      if (path !== "/api/send_private_message" && path !== "/api/send_group_message") {
        return new Response(null, { status: 404 });
      }
      const body = await request.json() as {
        user_id?: number; group_id?: number; message: { type: string; data: { text: string } }[];
      };
      expect(body.message).toEqual([{ type: "text", data: { text: expect.any(String) } }]);
      if (isDetailedProgress(body.message[0]!.data.text)) return Response.json({ status: "ok", retcode: 0, data: { message_seq: ++receiptId, time } });
      frames.push({
        action: path.slice("/api/".length),
        params: { user_id: body.user_id, group_id: body.group_id, message: body.message[0]!.data.text },
      });
      available.resolve();
      return Response.json({ status: "ok", retcode: 0, data: { message_seq: ++receiptId, time } });
    },
    websocket: {
      open(socket) { sockets[socket.data]?.resolve(socket); },
      message() {},
      close(socket) { if (socket.data === 0) firstClosed.resolve(); },
    },
  });
  async function nextFrame() {
    if (!frames.length) await deadline(available.promise, "未收到托管更新的 Milky 回复。", 10_000);
    const frame = frames.shift()!;
    if (!frames.length) available = Promise.withResolvers<void>();
    return frame;
  }
  return {
    server, firstClosed, releaseReplacement, frames, nextFrame,
    async open(generation: number) {
      const socket = await deadline(sockets[generation]!.promise, "未收到本代托管宿主的 Milky 连接。", 16_000);
      return (text: string, userId: number, groupId?: number) => socket.send(JSON.stringify({
        time, self_id: botId, event_type: "message_receive",
        data: {
          time, message_seq: ++messageId, sender_id: userId, peer_id: groupId ?? userId,
          message_scene: groupId === undefined ? "friend" : "group",
          segments: [{ type: "text", data: { text } }],
        },
      }));
    },
    async next(target: Target, pattern: RegExp) {
      const frame = await nextFrame();
      expect(frame.action).toBe("group_id" in target ? "send_group_message" : "send_private_message");
      expect(frame.params).toMatchObject(target);
      expect(frame.params.message).toMatch(pattern);
      return frame.params.message;
    },
  };
}

async function configureMilkyUpdate(active: string, port: string, accessToken: string) {
  await writeFile(join(active, "config/milky.yaml"), [
    "enable: true", "host: 127.0.0.1", `port: ${port}`,
    `access_token: ${accessToken}`, "ws:", "  reconnect_interval: 0.05",
  ].join("\n") + "\n");
}

async function exerciseMilkyUpdate(fault?: "startup" | "config") {
  const temporary = await mkdtemp(join(tmpdir(), "lotus-trss-milky-managed-update-"));
  const milkyToken = "managed-update-milky-fixture";
  const mock = milkyUpdateGateway(milkyToken, 99);
  try {
    const { active, old, candidate, writer } = await fixtureRepository(temporary, fault === "startup");
    if (fault === "config") {
      const app = join(writer, "app.ts");
      const source = await readFile(app, "utf8");
      const readSettings = "readMilkySettings(root).catch(";
      expect(source).toContain(readSettings);
      await writeFile(app, source.replace(readSettings,
        "(handoff.accepting ? readMilkySettings(root) : Promise.reject(new Error('fixture Milky config failure'))).catch("));
      git(writer, "add", "app.ts");
      git(writer, "commit", "--quiet", "-m", "Fixture Milky config failure during handoff");
      git(writer, "push", "--quiet", "origin", "main");
    }
    await writeFile(join(active, "config/config/other.yaml"), [
      'master: ["99:51", "100:52"]', "disablePrivate: true", "disableMsg: 私聊限制夹具",
      "disableAdopt: ['^#诊断$', '^#版本$']",
    ].join("\n") + "\n");
    await configureMilkyUpdate(active, mock.server.url.port, milkyToken);
    const supervisor = bootSupervisor(active);
    try {
      const initial = await deadline(supervisor.nextEndpoint(), "Milky 更新测试宿主启动超时。");
      const coexisting = await supervisor.open(initial, 99);
      await expectVersion(coexisting, old);
      const command = await mock.open(0);

      command("#诊断", 51);
      const diagnostics = await mock.next({ user_id: 51 }, /^Lotus-Yunzai 运行诊断/u);
      expect(diagnostics).toMatch(/账号在线时长\n99　Milky　/u);
      command("#更新", 42);
      await mock.next({ user_id: 42 }, /^私聊限制夹具$/u);
      command("#更新", 52, 77);
      await mock.next({ group_id: 77 }, /^暂无权限/u);
      expect(git(active, "rev-parse", "HEAD")).toBe(old);

      command("#更新", 51);
      await mock.next({ user_id: 51 }, /^开始更新/u);
      const [replacement] = await Promise.all([
        deadline(supervisor.nextEndpoint(), "Milky 更新后托管宿主未启动。", 16_000),
        deadline(mock.firstClosed.promise, "Milky 更新时未关闭原事件连接。", 16_000),
      ]);
      const expected = fault ? old : candidate;
      expect(git(active, "rev-parse", "HEAD")).toBe(expected);
      const sameOneBot = await supervisor.open(replacement, 99);
      await expectVersion(sameOneBot, expected);
      // The replacement's held upgrade leaves only earlier update progress in this queue.
      while (mock.frames.length) {
        await mock.next({ user_id: 51 }, /^正在(?:准备候选版本|切换到候选版本)。$/u);
      }

      mock.releaseReplacement.resolve();
      const updated = await mock.open(1);
      const receipt = await mock.next({ user_id: 51 }, fault ? /^更新失败，已恢复旧版本。$/u : /^更新成功/u);
      if (!fault) expect(receipt).toContain(candidate.slice(0, 12));
      updated("#版本", 51);
      const version = await mock.next({ user_id: 51 }, /^Lotus-Yunzai 版本/u);
      expect(version).toContain(expected.slice(0, 12));
      expect(sameOneBot.frames).toEqual([]);
      expect(mock.frames).toEqual([]);
      await supervisor.stop();
      const diagnosticsAfterStop = await supervisor.stderr;
      if (fault === "startup") expect(diagnosticsAfterStop).toContain(liveFailure);
      else if (fault === "config") expect(diagnosticsAfterStop).toContain("候选宿主未能接回原版本的 Milky 入口");
      else expect(diagnosticsAfterStop).not.toContain(liveFailure);
    } finally {
      mock.releaseReplacement.resolve();
      await supervisor.close();
    }
  } finally {
    mock.server.stop(true);
    await rm(temporary, { recursive: true, force: true });
  }
}

test.skipIf(!Bun.which("git"))("Milky 主人可在限制私聊时触发真实托管更新，回执仅返回原 Milky 私聊",
  () => exerciseMilkyUpdate(), 35_000);
test.skipIf(!Bun.which("git"))("Milky 托管更新在活动环境失败后回滚，回执仅返回原 Milky 私聊",
  () => exerciseMilkyUpdate("startup"), 35_000);
test.skipIf(!Bun.which("git"))("Milky 托管更新在候选仍运行但适配器配置读取失败时回滚",
  () => exerciseMilkyUpdate("config"), 35_000);

async function exerciseScheduledUpdate(schedule: Schedule, fail: boolean) {
  const temporary = await mkdtemp(join(tmpdir(), "lotus-trss-scheduled-update-"));
  try {
    const { active, old, candidate } = await fixtureRepository(temporary, fail, undefined, schedule);
    const supervisor = bootSupervisor(active, {
      TZ: "UTC", FIXTURE_UPDATE_EPOCH: schedule !== "interval" ? join(temporary, "fixture-epoch") : undefined,
      FIXTURE_DEFAULT_UPDATE_CLOCK: schedule === "legacy-default" ? "1" : undefined,
    });
    try {
      const initial = await deadline(supervisor.nextEndpoint(), "定时更新测试宿主启动超时。");
      const first = await supervisor.open(initial, 99);
      const second = await supervisor.open(initial, 100);
      await expectVersion(first, old);
      first.command("#关机", 51);
      expectText(await first.next(), { user_id: 51 }, /^关机成功/u);
      first.command("#状态", 42);
      second.command("#状态", 42);

      const [replacement] = await Promise.all([
        deadline(supervisor.nextEndpoint(), "定时更新没有启动新的工作进程。", 16_000),
        deadline(first.closed, "定时更新后原连接没有关闭。", 16_000),
        deadline(second.closed, "定时更新后第二个原连接没有关闭。", 16_000),
      ]);
      expect(first.frames).toEqual([]);
      expect(second.frames).toEqual([]);

      const expected = fail ? old : candidate;
      expect(git(active, "rev-parse", "HEAD")).toBe(expected);
      const receipt = fail ? /^更新失败，已恢复旧版本/u : /^更新成功/u;
      const secondAgain = await supervisor.open(replacement, 100);
      expectText(await secondAgain.next(), { user_id: 52 }, receipt);
      const firstAgain = await supervisor.open(replacement, 99);
      expectText(await firstAgain.next(), { user_id: 51 }, receipt);
      firstAgain.command("#状态", 51);
      secondAgain.command("#状态", 52);
      await Bun.sleep(100);
      expect(firstAgain.frames).toEqual([]);
      expect(secondAgain.frames).toEqual([]);

      firstAgain.command("#开机", 51);
      const elapsed = schedule === "cron" ? /1分/u : /[1-9]\d*秒/u;
      const resumed = await firstAgain.next();
      expectText(resumed, { user_id: 51 }, /^开机成功，距离上次关机/u);
      expect(resumed.params.message).toMatch(elapsed);
      await expectVersion(firstAgain, expected);
      await expectVersion(secondAgain, expected);

      await supervisor.stop();
      if (fail) expect(await supervisor.stderr).toContain(liveFailure);
    } finally {
      await supervisor.close();
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

test.skipIf(!Bun.which("git"))("update_time 在软关机期间静默更新并向各机器人主人回执", () => exerciseScheduledUpdate("interval", false), 35_000);
test.skipIf(!Bun.which("git"))("旧 bot.yaml 未指定更新计划时按默认时刻静默更新并回执", () => exerciseScheduledUpdate("legacy-default", false), 35_000);
test.skipIf(!Bun.which("git"))("update_cron 启动失败后恢复旧提交和原关机时间并向各机器人主人回执", () => exerciseScheduledUpdate("cron", true), 35_000);

async function exerciseMilkyScheduledUpdate(fail: boolean) {
  const temporary = await mkdtemp(join(tmpdir(), "lotus-trss-milky-scheduled-update-"));
  const milkyToken = "scheduled-update-milky-fixture";
  const mock = milkyUpdateGateway(milkyToken, 99);
  try {
    const { active, old, candidate } = await fixtureRepository(temporary, fail, undefined, "interval");
    await writeFile(join(active, "config/config/other.yaml"), 'master: ["99:51", "99:52"]\n');
    await configureMilkyUpdate(active, mock.server.url.port, milkyToken);
    const supervisor = bootSupervisor(active);
    try {
      await deadline(supervisor.nextEndpoint(), "Milky 定时更新测试宿主启动超时。");
      const command = await mock.open(0);
      command("#版本", 42);
      expect(await mock.next({ user_id: 42 }, /^Lotus-Yunzai 版本/u)).toContain(old.slice(0, 12));

      const [replacement] = await Promise.all([
        deadline(supervisor.nextEndpoint(), "Milky 定时更新没有启动新的工作进程。", 16_000),
        deadline(mock.firstClosed.promise, "Milky 定时更新时未关闭原事件连接。", 16_000),
      ]);
      const expected = fail ? old : candidate;
      expect(git(active, "rev-parse", "HEAD")).toBe(expected);
      expect(mock.frames).toEqual([]);

      const sameOneBot = await supervisor.open(replacement, 99);
      await expectVersion(sameOneBot, expected);
      const receiptDirectory = join(active, "data/process-receipts");
      const persisted = join(receiptDirectory, "milky-99.update.json");
      expect(JSON.parse(await readFile(persisted, "utf8"))).toMatchObject({
        kind: "update",
        target: { type: "masters", botId: 99, adapter: "milky" },
        ...(fail ? { result: "rolled-back" } : { result: "updated", revision: candidate }),
      });
      await expect(lstat(join(receiptDirectory, "99.update.json"))).rejects.toMatchObject({ code: "ENOENT" });

      mock.releaseReplacement.resolve();
      const updated = await mock.open(1);
      const replies = [await mock.nextFrame(), await mock.nextFrame()];
      expect(replies.map(({ params }) => params.user_id).sort()).toEqual([51, 52]);
      for (const frame of replies) {
        expect(frame.action).toBe("send_private_message");
        expect(frame.params.message).toMatch(fail ? /^更新失败，已恢复旧版本。$/u : /^更新成功/u);
        if (!fail) expect(frame.params.message).toContain(candidate.slice(0, 12));
      }
      await expect(lstat(persisted)).rejects.toMatchObject({ code: "ENOENT" });
      updated("#版本", 43);
      expect(await mock.next({ user_id: 43 }, /^Lotus-Yunzai 版本/u)).toContain(expected.slice(0, 12));
      expect(sameOneBot.frames).toEqual([]);
      expect(mock.frames).toEqual([]);
      await supervisor.stop();
      if (fail) expect(await supervisor.stderr).toContain(liveFailure);
    } finally {
      mock.releaseReplacement.resolve();
      await supervisor.close();
    }
  } finally {
    mock.server.stop(true);
    await rm(temporary, { recursive: true, force: true });
  }
}

test.skipIf(!Bun.which("git"))("Milky 定时更新只向原协议的主人持久化和投递成功回执",
  () => exerciseMilkyScheduledUpdate(false), 35_000);
test.skipIf(!Bun.which("git"))("Milky 定时更新回滚只向原协议的主人持久化和投递失败回执",
  () => exerciseMilkyScheduledUpdate(true), 35_000);

test.skipIf(!Bun.which("git"))("Milky 定时更新遇到未提交的修改时直接通知当前主人", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "lotus-trss-milky-scheduled-preflight-"));
  const milkyToken = "scheduled-preflight-milky-fixture";
  const mock = milkyUpdateGateway(milkyToken, 99);
  try {
    const { active, old } = await fixtureRepository(temporary, false, undefined, "interval");
    const source = join(active, "app.ts");
    await appendFile(source, "\n// 保留定时预检夹具的未提交改动。\n");
    const dirtySource = await readFile(source, "utf8");
    await configureMilkyUpdate(active, mock.server.url.port, milkyToken);
    const supervisor = bootSupervisor(active);
    try {
      await deadline(supervisor.nextEndpoint(), "Milky 定时预检测试宿主启动超时。");
      const command = await mock.open(0);
      await mock.next({ user_id: 51 }, /^定时更新未完成。工作区有未提交的修改，更新未执行。$/u);
      command("#版本", 42);
      expect(await mock.next({ user_id: 42 }, /^Lotus-Yunzai 版本/u)).toContain(old.slice(0, 12));
      expect(git(active, "rev-parse", "HEAD")).toBe(old);
      expect(await readFile(source, "utf8")).toBe(dirtySource);
      await expect(lstat(join(active, "data/process-receipts/milky-99.update.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
      expect(mock.frames).toEqual([]);
      await supervisor.stop();
    } finally {
      mock.releaseReplacement.resolve();
      await supervisor.close();
    }
  } finally {
    mock.server.stop(true);
    await rm(temporary, { recursive: true, force: true });
  }
}, 35_000);

async function exerciseInstall(fail: boolean) {
  const temporary = await mkdtemp(join(tmpdir(), "lotus-trss-managed-install-"));
  try {
    const { active, old } = await fixtureRepository(temporary, false);
    const writer = join(temporary, "package-writer");
    const remote = join(temporary, "package.git");
    const wrapper = join(temporary, "path");
    const source = "https://example.invalid/fixtures/install.git";
    const name = "隔离插件";
    const directory = "installed-fixture";
    const installed = join(active, "plugins", directory);
    const occupied = join(active, "plugins/occupied");
    await Promise.all([mkdir(writer), mkdir(wrapper), mkdir(join(active, "plugins/rejected"))]);
    await Promise.all([
      writeFile(join(active, "plugins/rejected/notes.txt"), "kept directory"),
      writeFile(join(active, "plugins/loose.js"), "// kept loose script"),
      symlink("missing-target", occupied),
      writeFile(join(writer, "package.json"), JSON.stringify({
        name: "@fixture/installed", type: "module", lotusYunzai: { entry: "./index.js" },
      })),
      writeFile(join(writer, "index.js"), (fail
        ? 'if (Bun.env.FIXTURE_MANAGED_FAILURE === "1") throw new Error("fixture install refused live load");\n'
        : "") + 'export default { commands: { "#隔离安装验收": () => "隔离插件已加载" } };\n'),
    ]);
    git(temporary, "init", "--bare", "--quiet", "--initial-branch=main", remote);
    git(writer, "init", "--quiet", "--initial-branch=main");
    git(writer, "add", ".");
    git(writer, "commit", "--quiet", "-m", "Fixture approved plugin");
    const revision = git(writer, "rev-parse", "HEAD");
    git(writer, "remote", "add", "origin", remote);
    git(writer, "push", "--quiet", "origin", "main");

    // Route only the fixture fetch to a local Git transport. The installed origin remains HTTPS.
    const quote = (argument: string) => "'" + argument.replaceAll("'", "'\"'\"'") + "'";
    const binary = quote(Bun.which("git")!);
    await writeFile(join(wrapper, "git"), `#!/bin/sh
for argument do
  if [ "$argument" = fetch ]; then fetching=1; fi
  if [ "$fetching" = 1 ] && [ "$argument" = origin ]; then
    GIT_ALLOW_PROTOCOL=file exec ${binary} -c ${quote(`url.file://${remote}.insteadOf=${source}`)} "$@"
  fi
done
exec ${binary} "$@"
`, { mode: 0o700 });
    await writeFile(join(active, "config/install.yaml"), JSON.stringify({
      plugins: {
        [name]: { directory, url: source, branch: "main", revision },
        "已占用": { directory: "occupied", url: "https://example.invalid/fixtures/occupied.git", branch: "main", revision },
      },
    }));

    const supervisor = bootSupervisor(active, { PATH: wrapper + ":" + process.env.PATH });
    try {
      const initial = await supervisor.open(await deadline(supervisor.nextEndpoint(), "安装测试宿主启动超时。"), 99);
      initial.command("#安装插件-plugin", 42);
      expectText(await initial.next(), { user_id: 42 }, /^暂无权限/u);
      initial.command("#安装插件-plugin", 51);
      const listing = await initial.next();
      expectText(listing, { user_id: 51 }, /可安装插件列表：[\s\S]*隔离插件/u);
      expect(listing.params.message).not.toContain("已占用");
      initial.command("#安装yenai-Plugin", 51);
      expectText(await initial.next(), { user_id: 51 }, /已归并，请使用 group 和 system/u);
      initial.command("#安装已占用", 51);
      expectText(await initial.next(), { user_id: 51 }, /^开始安装/u);
      expectText(await initial.next(), { user_id: 51 }, /已安装/u);
      const target = { group_id: 88 };
      initial.command(`#安装${name}-Plugin`, 51, target.group_id);
      expectText(await initial.next(), target, /^开始安装/u);
      const [endpoint] = await Promise.all([
        deadline(supervisor.nextEndpoint(), "安装后托管宿主启动超时。", 16_000),
        deadline(initial.closed, "安装时旧连接没有关闭。", 16_000),
      ]);
      const other = await supervisor.open(endpoint, 100);
      await expectVersion(other, old);
      const original = await supervisor.open(endpoint, 99);
      const receipt = await original.next();
      expectText(receipt, target, fail ? /^安装 隔离插件 失败，已恢复旧版本/u : /^安装 隔离插件 成功/u);
      expect(await readFile(join(active, "plugins/rejected/notes.txt"), "utf8")).toBe("kept directory");
      expect(await readFile(join(active, "plugins/loose.js"), "utf8")).toBe("// kept loose script");
      expect((await lstat(occupied)).isSymbolicLink()).toBe(true);
      await expectVersion(original, old);
      if (fail) {
        await expect(lstat(installed)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(receipt.params.message).toContain(revision.slice(0, 12));
        expect(git(installed, "rev-parse", "HEAD")).toBe(revision);
        expect(git(installed, "config", "branch.main.merge")).toBe("refs/heads/main");
        expect(git(installed, "remote", "get-url", "origin")).toBe(source);
        original.command("#隔离安装验收", 42);
        expectText(await original.next(), { user_id: 42 }, /隔离插件已加载/u);
        await appendFile(join(writer, "index.js"), "// later upstream revision\n");
        git(writer, "add", "index.js");
        git(writer, "commit", "--quiet", "-m", "Fixture later update");
        git(writer, "push", "--quiet", "origin", "main");
        const updated = git(writer, "rev-parse", "HEAD");
        original.command(`#更新${directory}`, 51);
        expectText(await original.next(), { user_id: 51 }, /^开始更新/u);
        const online = await supervisor.open(await deadline(supervisor.nextEndpoint(), "插件更新后启动超时。", 16_000), 99);
        expectText(await online.next(), { user_id: 51 }, /^更新成功/u);
        expect(git(installed, "rev-parse", "HEAD")).toBe(updated);
        await expectVersion(online, old);
      }
      expect(other.frames).toEqual([]);
      await supervisor.stop();
    } finally {
      await supervisor.close();
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

test.skipIf(!Bun.which("git"))("托管安装检查目录占用，向原会话回执并保留后续插件更新", () => exerciseInstall(false), 35_000);
test.skipIf(!Bun.which("git"))("托管安装在实际环境未加载时回滚，保留旧插件和原会话回执", () => exerciseInstall(true), 35_000);
