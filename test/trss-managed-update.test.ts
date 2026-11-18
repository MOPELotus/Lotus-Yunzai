import { expect, test } from "bun:test";
import { appendFile, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost } from "./host-fixture.ts";

const token = "managed-update-onebot-fixture";
const liveFailure = "fixture candidate exited only under the supervisor environment";
const startupLine = "Lotus-Yunzai 已启动。";

type Target = { readonly user_id: number } | { readonly group_id: number };
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

async function fixtureRepository(temporary: string, fail: boolean) {
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

async function exerciseUpdate(fail: boolean, pluginOnly = false) {
  const temporary = await mkdtemp(join(tmpdir(), "lotus-trss-managed-update-"));
  const clients: Gateway[] = [];
  try {
    const { active, old, candidate, localPlugin, pluginRemote } = await fixtureRepository(temporary, fail && !pluginOnly);
    const previousPlugin = git(localPlugin, "rev-parse", "HEAD");
    let candidatePlugin: string | undefined;
    if (pluginOnly) {
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
    const supervisor = Bun.spawn([process.execPath, "scripts/run-managed.ts", active], {
      cwd: active, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: {
        PATH: process.env.PATH, LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: token,
        FIXTURE_MANAGED_FAILURE: "1",
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
      expect(git(active, "rev-parse", "HEAD")).toBe(old);
      await expectVersion(initial, old);

      initial.command("#更新", 42, 77, "owner");
      expectText(await initial.next(), { group_id: 77 }, /^暂无权限/u);
      const unbound = await open(initialEndpoint);
      unbound.command("#更新", 51);
      expectText(await unbound.next(), { user_id: 51 }, /^暂无权限/u);
      await expectVersion(unbound, old);
      expect(git(active, "rev-parse", "HEAD")).toBe(old);

      const groupId = fail ? 88 : undefined;
      const target: Target = groupId ? { group_id: groupId } : { user_id: 51 };
      initial.command(pluginOnly ? "#更新local-fixture" : "#更新", 51, groupId);
      expectText(await initial.next(10_000), target, /^开始更新/u);
      const [replacementEndpoint] = await Promise.all([
        deadline(nextEndpoint(), "更新后的托管宿主启动超时。", 16_000),
        deadline(initial.closed, "更新时旧连接没有关闭。", 16_000),
      ]);
      const expected = fail || pluginOnly ? old : candidate;
      expect(git(active, "rev-parse", "HEAD")).toBe(expected);
      expect(git(localPlugin, "rev-parse", "HEAD")).toBe(fail ? previousPlugin : candidatePlugin ?? previousPlugin);
      expect(await readFile(join(active, "config/config/other.yaml"), "utf8")).toBe('master: ["99:51", "100:51"]\n');
      expect(await readFile(join(localPlugin, "config/default.json"), "utf8")).toBe('{"default":true}');
      expect(await readFile(join(localPlugin, "config/live.json"), "utf8")).toBe('{"active":true}');
      expect(await readFile(join(localPlugin, "data/state.txt"), "utf8")).toBe("active plugin state");
      expect(await readFile(join(localPlugin, ".env.local"), "utf8")).toBe("FIXTURE_LOCAL_CONFIG=active\n");
      const otherBot = await open(replacementEndpoint, 100);
      await expectVersion(otherBot, expected);
      const originalBot = await open(replacementEndpoint, 99);
      const receipt = await originalBot.next();
      expectText(receipt, target, fail ? /^更新失败，已恢复旧版本/u : /^更新成功/u);
      if (!fail) expect(receipt.params.message).toContain((candidatePlugin ?? candidate).slice(0, 12));
      await expectVersion(originalBot, expected);
      const reconnect = await open(replacementEndpoint, 99);
      await expectVersion(reconnect, expected);
      expect(otherBot.frames).toEqual([]);
      expect(reconnect.frames).toEqual([]);

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
test.skipIf(!Bun.which("git"))("指定外部插件更新保留宿主提交并回报插件提交", () => exerciseUpdate(false, true), 35_000);
test.skipIf(!Bun.which("git"))("目标插件在实际环境拒绝加载时回退，宿主就绪不能掩盖失败", () => exerciseUpdate(true, true), 35_000);
