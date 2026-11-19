import { expect, test } from "bun:test";
import { cp, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

const token = "milky-managed-install-fixture";
const botId = 99;
const owner = 51;
const otherOwner = 52;
const groupId = 77;
const pluginName = "离线夹具";
const pluginDirectory = "installed-milky-fixture";
const probe = "#Milky安装验收";

function git(root: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgSign=false", ...args], {
    cwd: root, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ALLOW_PROTOCOL: "file" },
  });
  if (result.exitCode !== 0) throw new Error(`Git 夹具命令失败（${args[0]}）。\n${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

async function fixture(root: string, port: number, fail: boolean) {
  const active = join(root, "active");
  const writer = join(root, "plugin");
  const binaries = join(root, "bin");
  const remote = join(root, "plugin.git");
  const source = "https://example.invalid/fixtures/milky-install.git";
  await Promise.all([mkdir(active), mkdir(writer), mkdir(binaries)]);
  await copyHost(active);
  await Promise.all([mkdir(join(active, "config/config"), { recursive: true }), mkdir(join(active, "scripts"))]);
  const dependencies = await realpath(join(active, "node_modules"));
  await Promise.all([
    cp(new URL("../scripts/run-managed.ts", import.meta.url), join(active, "scripts/run-managed.ts")),
    writeFile(join(active, ".gitignore"), "/node_modules\n/config/\n/data/\n/logs/\n"),
    writeFile(join(active, "package.json"), JSON.stringify({
      name: "lotus-yunzai", private: true, type: "module", scripts: { typecheck: "bun --version" },
    })),
    writeFile(join(active, "scripts/bootstrap.ts"), `
      import { symlink } from "node:fs/promises";
      await symlink(${JSON.stringify(dependencies)}, new URL("../node_modules", import.meta.url), "dir");
    `),
    writeFile(join(active, "config/config/other.yaml"), `master: ["${botId}:${owner}", "100:${otherOwner}"]\n`),
    writeFile(join(active, "config/milky.yaml"), [
      "enable: true", "host: 127.0.0.1", `port: ${port}`, `access_token: ${token}`,
      "ws:", "  reconnect_interval: 0.05", "",
    ].join("\n")),
    writeFile(join(writer, "package.json"), JSON.stringify({
      name: "@fixture/milky-install", type: "module", lotusYunzai: { entry: "./index.js" },
    })),
    writeFile(join(writer, "index.js"), (fail
      ? 'if (Bun.env.FIXTURE_MILKY_INSTALL_FAILURE === "1") throw new Error("Fixture plugin failed to load in active host.");\n'
      : "") + `export default { commands: { ${JSON.stringify(probe)}: () => "已加载审批插件" } };\n`),
  ]);
  disableMemberPrewarm(active);
  for (const repo of [active, writer]) {
    git(repo, "init", "--quiet", "--initial-branch=main");
    git(repo, "add", "--all");
    git(repo, "commit", "--quiet", "-m", "Fixture revision");
  }
  const revision = git(writer, "rev-parse", "HEAD");
  git(root, "clone", "--quiet", "--bare", writer, remote);

  // Only the fixture can be fetched. The installed remote records the catalog's HTTPS URL.
  const shellQuote = (argument: string) => "'" + argument.replaceAll("'", "'\"'\"'") + "'";
  const binary = shellQuote(Bun.which("git")!);
  await writeFile(join(binaries, "git"), `#!/bin/sh
export GIT_ALLOW_PROTOCOL=file
for argument do
  if [ "$argument" = fetch ]; then fetching=1; fi
  if [ "$fetching" = 1 ] && [ "$argument" = origin ]; then
    exec ${binary} -c ${shellQuote(`url.file://${remote}.insteadOf=${source}`)} "$@"
  fi
done
exec ${binary} "$@"
`, { mode: 0o700 });
  await writeFile(join(active, "config/install.yaml"), JSON.stringify({
    plugins: { [pluginName]: { directory: pluginDirectory, url: source, branch: "main", revision } },
  }));
  return { active, revision, source, binaries, head: git(active, "rev-parse", "HEAD") };
}

async function within<T>(promise: Promise<T>, failure: string, ms = 6_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(failure)), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

interface Send {
  action: string;
  body: { user_id?: number; group_id?: number; message: { type: string; data: { text: string } }[] };
}

function gateway() {
  const sessions = [Promise.withResolvers<Bun.ServerWebSocket<number>>(), Promise.withResolvers<Bun.ServerWebSocket<number>>()];
  const allowReconnect = Promise.withResolvers<void>();
  const initialClosed = Promise.withResolvers<void>();
  const sends: Send[] = [];
  let available = Promise.withResolvers<void>();
  let connections = 0;
  let sequence = 0;
  const server = Bun.serve<number>({
    hostname: "127.0.0.1", port: 0,
    async fetch(request, listener) {
      if (request.headers.get("Authorization") !== `Bearer ${token}`) return new Response(null, { status: 401 });
      const { pathname } = new URL(request.url);
      if (request.method === "GET" && pathname === "/event") {
        if (listener.upgrade(request, { data: connections++ })) return;
        return new Response(null, { status: 426 });
      }
      if (request.method !== "POST") return new Response(null, { status: 405 });
      if (pathname === "/api/get_login_info") {
        if (connections) await allowReconnect.promise;
        return Response.json({ status: "ok", retcode: 0, data: { uin: botId, nickname: "安装夹具" } });
      }
      if (pathname !== "/api/send_private_message" && pathname !== "/api/send_group_message") {
        return new Response(null, { status: 404 });
      }
      sends.push({ action: pathname.slice(5), body: await request.json() as Send["body"] });
      available.resolve();
      return Response.json({ status: "ok", retcode: 0, data: { message_seq: ++sequence } });
    },
    websocket: {
      open(socket) { sessions[socket.data]?.resolve(socket); },
      message() {},
      close(socket) { if (socket.data === 0) initialClosed.resolve(); },
    },
  });
  return {
    server, sessions, allowReconnect, initialClosed, sends,
    async expectReply(target: { user_id: number } | { group_id: number }, text: RegExp) {
      if (!sends.length) await within(available.promise, `Milky 未回复 ${text}。`);
      const reply = sends.shift()!;
      if (!sends.length) available = Promise.withResolvers<void>();
      expect(reply).toEqual({
        action: "group_id" in target ? "send_group_message" : "send_private_message",
        body: { ...target, message: [{ type: "text", data: { text: expect.stringMatching(text) } }] },
      });
      return reply.body.message[0]!.data.text;
    },
  };
}

function command(socket: Bun.ServerWebSocket<number>, text: string, senderId: number, id: number, group?: number) {
  socket.send(JSON.stringify({
    time: 1_700_000_000, self_id: botId, event_type: "message_receive",
    data: { sender_id: senderId, peer_id: group ?? senderId, message_seq: id,
      message_scene: group === undefined ? "friend" : "group", segments: [{ type: "text", data: { text } }] },
  }));
}

async function exerciseMilkyInstall(fail: boolean) {
  const root = await mkdtemp(join(tmpdir(), "lotus-milky-managed-install-"));
  const mock = gateway();
  try {
    const { active, revision, source, binaries, head } = await fixture(root, mock.server.port!, fail);
    const host = Bun.spawn([process.execPath, "scripts/run-managed.ts", active], {
      cwd: active, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: `${binaries}:${process.env.PATH}`, LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: token,
        FIXTURE_MILKY_INSTALL_FAILURE: "1" },
    });
    const stderr = new Response(host.stderr).text();
    const reader = host.stdout.getReader();
    const decoder = new TextDecoder();
    let output = "";
    async function nextOneBot() {
      const startup = "Lotus-Yunzai 已启动。";
      while (!output.includes(startup)) {
        const next = await reader.read();
        if (next.done) throw new Error(`安装测试宿主提前退出。\n${output}\n${await stderr}`);
        output += decoder.decode(next.value, { stream: true });
      }
      const start = output.indexOf(startup);
      const endpoint = [...output.slice(0, start).matchAll(/ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/gu)].at(-1)?.[0];
      output = output.slice(start + startup.length);
      if (!endpoint) throw new Error("安装测试宿主未公布 OneBot 地址。");
      return endpoint;
    }
    let oneBot: WebSocket | undefined;
    let failure: unknown;
    try {
      await within(nextOneBot(), "旧安装测试宿主未启动。");
      const initial = await within(mock.sessions[0]!.promise, "旧安装测试宿主未连接 Milky。");
      const install = `#安装${pluginName}-Plugin`;
      command(initial, install, otherOwner, 1);
      await mock.expectReply({ user_id: otherOwner }, /^暂无权限/u);
      command(initial, "#安装插件", owner, 2);
      await mock.expectReply({ user_id: owner }, /可安装插件列表：[\s\S]*离线夹具/u);
      command(initial, install, owner, 3, groupId);
      await mock.expectReply({ group_id: groupId }, /^开始安装/u);
      await mock.expectReply({ group_id: groupId }, /^正在准备插件和依赖/u);
      await mock.expectReply({ group_id: groupId }, /^正在切换到安装后的宿主/u);
      await within(mock.initialClosed.promise, "安装没有停止旧 Milky 会话。", 15_000);
      const endpoint = await within(nextOneBot(), "安装后宿主未启动。", 15_000);

      const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
      const competitor = new BunWebSocket(endpoint, {
        headers: { Authorization: `Bearer ${token}`, "X-Self-ID": String(botId), "X-Client-Role": "Universal" },
      });
      oneBot = competitor;
      const frames: { action: string; echo: string; params: { message: string } }[] = [];
      const competitorReply = Promise.withResolvers<void>();
      const expectedProbe = fail ? /^Lotus-Yunzai 版本/u : /^已加载审批插件$/u;
      const commandProbe = fail ? "#版本" : probe;
      competitor.addEventListener("message", ({ data }) => {
        const frame = JSON.parse(data) as typeof frames[number];
        if (frame.echo) competitor.send(JSON.stringify({ echo: frame.echo, status: "ok", retcode: 0, data: { message_id: 1 } }));
        frames.push(frame);
        if (expectedProbe.test(frame.params.message)) competitorReply.resolve();
      });
      competitor.addEventListener("open", () => competitor.send(JSON.stringify({
        post_type: "message", message_type: "private", sub_type: "friend", self_id: botId,
        user_id: owner, message_id: 1, message: commandProbe,
      })), { once: true });
      await within(competitorReply.promise, "同账号 OneBot 未确认启动后的宿主。");
      mock.allowReconnect.resolve();

      const resumed = await within(mock.sessions[1]!.promise, "安装后 Milky 未恢复连接。");
      const receipt = await mock.expectReply({ group_id: groupId }, fail
        ? /^安装 离线夹具 失败，已恢复旧版本/u : /^安装 离线夹具 成功/u);
      expect(frames.map(({ params }) => params.message)).toEqual([expect.stringMatching(expectedProbe)]);
      const installed = join(active, "plugins", pluginDirectory);
      if (fail) {
        await expect(lstat(installed)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(receipt).toContain(revision.slice(0, 12));
        expect(git(installed, "rev-parse", "HEAD")).toBe(revision);
        expect(git(installed, "config", "remote.origin.url")).toBe(source);
        expect(git(installed, "config", "branch.main.merge")).toBe("refs/heads/main");
      }
      expect(git(active, "rev-parse", "HEAD")).toBe(head);
      command(resumed, commandProbe, owner, 4);
      await mock.expectReply({ user_id: owner }, expectedProbe);
      expect(mock.sends).toEqual([]);
    } catch (error) {
      failure = error;
    } finally {
      mock.allowReconnect.resolve();
      oneBot?.close();
      if (host.exitCode === null && host.signalCode === null) {
        host.kill("SIGTERM");
        await within(host.exited, "未按时停止安装测试宿主。", 4_000).catch(() => host.kill("SIGKILL"));
      }
      await host.exited;
      await reader.cancel();
      reader.releaseLock();
    }
    if (failure) throw new Error(`${String(failure)}\n${output}\n${await stderr}`, { cause: failure });
    expect(await stderr).not.toMatch(/未确认进程操作回执|无法读取进程操作回执/u);
  } finally {
    mock.server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}

test.skipIf(!Bun.which("git"))("Milky 主人从审批目录安装插件，重启后只向原 Milky 群回执", () => exerciseMilkyInstall(false), 32_000);
test.skipIf(!Bun.which("git"))("Milky 安装加载失败后恢复旧宿主，只向原 Milky 群回执", () => exerciseMilkyInstall(true), 32_000);
