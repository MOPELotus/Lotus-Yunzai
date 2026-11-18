import { expect, test } from "bun:test";
import { appendFile, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost } from "./host-fixture.ts";

const token = "managed-update-onebot-fixture";
const liveFailure = "fixture candidate exited only under the supervisor environment";
const startupLine = "Lotus-Yunzai 已启动。";

type Target = { readonly user_id: number } | { readonly group_id: number };
type UpdateTarget = "host" | "plugin" | "all";
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
  let ready = Promise.withResolvers<void>();
  socket.addEventListener("message", ({ data }) => {
    const frame: Frame = JSON.parse(data);
    if (frame.echo) socket.send(JSON.stringify({ echo: frame.echo, status: "ok", retcode: 0, data: { message_id: 77 } }));
    frames.push(frame);
    ready.resolve();
  });
  let messageId = 0;
  return {
    socket, opened, closed, frames,
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

async function fixtureRepository(temporary: string, fail: boolean, audit?: string) {
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
  await writeFile(join(active, "config/config/other.yaml"), 'master: ["99:51", "100:51"]\n');
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
  return { active, old, candidate, localPlugin, pluginRemote };
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
  const clients: Gateway[] = [];
  const prefix = updateTarget === "all" ? "全部" : "";
  const argument = updateTarget === "plugin" ? "local-fixture" : "";
  const command = `#${prefix}${force ? "强制" : ""}更新${argument}`;
  try {
    const audit = updateTarget === "all" ? join(temporary, "fixture-workers.txt") : undefined;
    const { active, old, candidate, localPlugin, pluginRemote } = await fixtureRepository(temporary, fail && updateTarget === "host", audit);
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

    const supervisor = Bun.spawn([process.execPath, "scripts/run-managed.ts", active], {
      cwd: active, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: {
        PATH: process.env.PATH, LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: token,
        FIXTURE_MANAGED_FAILURE: "1", FIXTURE_WORKER_AUDIT: audit,
      },
    });
    const stderr = new Response(supervisor.stderr).text();
    const reader = supervisor.stdout.getReader();
    const decoder = new TextDecoder();
    let output = "";
    async function nextEndpoint() {
      while (true) {
        const started = output.indexOf(startupLine);
        if (started !== -1) {
          const endpoints = [...output.slice(0, started).matchAll(/ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/gu)];
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
    const open = async (endpoint: string, id?: number) => {
      const client = gateway(endpoint, id);
      clients.push(client);
      await deadline(client.opened, "托管更新测试网关连接超时。");
      return client;
    };

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

      supervisor.kill("SIGTERM");
      expect(await deadline(supervisor.exited, "托管更新测试宿主退出超时。", 12_000)).toBe(143);
      if (fail) expect(await stderr).toContain(liveFailure);
      else expect(await stderr).not.toContain(liveFailure);
    } finally {
      for (const { socket } of clients) socket.close();
      if (supervisor.exitCode === null && supervisor.signalCode === null) {
        supervisor.kill("SIGTERM");
        await deadline(supervisor.exited, "托管更新测试清理失败。", 3_000).catch(() => supervisor.kill("SIGKILL"));
      }
      await supervisor.exited;
      await reader.cancel();
      reader.releaseLock();
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

test.skipIf(!Bun.which("git"))("托管 #更新 应用宿主候选并只向原私聊发送一次成功回执", () => exerciseUpdate(false), 35_000);
test.skipIf(!Bun.which("git"))("托管 #更新 在活动环境失败时恢复旧 HEAD 并回复原群", () => exerciseUpdate(true), 35_000);
test.skipIf(!Bun.which("git"))("指定外部插件更新保留宿主提交并回报插件提交", () => exerciseUpdate(false, "plugin"), 35_000);
test.skipIf(!Bun.which("git"))("目标插件在实际环境拒绝加载时回退，宿主就绪不能掩盖失败", () => exerciseUpdate(true, "plugin"), 35_000);
test.skipIf(!Bun.which("git"))("#全部更新一次切换宿主和外部插件，向原会话报告两个仓库", () => exerciseUpdate(false, "all"), 35_000);
test.skipIf(!Bun.which("git"))("#全部更新遇到仅在活动环境加载失败的插件时整批回滚", () => exerciseUpdate(true, "all"), 35_000);
test.skipIf(!Bun.which("git"))("#强制更新对齐分叉的宿主并归档私有分支和暂存区", () => exerciseUpdate(false, "host", true), 35_000);
test.skipIf(!Bun.which("git"))("#强制更新对齐领先的宿主失败后恢复原分支和暂存区", () => exerciseUpdate(true, "host", true), 35_000);
test.skipIf(!Bun.which("git"))("#全部强制更新同时对齐宿主和插件并归档两份本地修改", () => exerciseUpdate(false, "all", true), 35_000);
