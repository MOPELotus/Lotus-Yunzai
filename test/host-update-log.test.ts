import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

const token = "update-log-fixture";
const plugin = "history-fixture-plugin";
const rootSubject = "修复测试宿主的启动顺序";
const pluginSubject = "整理夹具插件的更新日志";
const rejectedSubject = "拒载插件提交主题不应公开";
const credential = "fixture-authorization-value";
const cookie = "fixture-cookie-value";

interface Frame {
  readonly action: string;
  readonly echo?: string;
  readonly params: {
    readonly group_id: number;
    readonly message?: string;
    readonly messages?: readonly { data: { readonly content: readonly { data: { readonly text: string } }[] } }[];
  };
}

function git(root: string, ...args: string[]) {
  const result = Bun.spawnSync([
    "git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", ...args,
  ], {
    cwd: root,
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  if (result.exitCode !== 0) throw new Error(`Git 夹具命令失败（${args[0]}）。\n${result.stderr.toString()}`);
}

function deadline<T>(promise: Promise<T>, description: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(description)), 2_500);
    void promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

async function endpointOf(stdout: ReadableStream<Uint8Array>) {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`更新日志测试宿主未启动。\n${output}`);
      output += decoder.decode(chunk.value, { stream: true });
      const match = /ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/u.exec(output);
      if (match) return match[0];
    }
  } finally {
    reader.releaseLock();
  }
}

function gateway(endpoint: string) {
  const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
  const socket = new BunWebSocket(endpoint, {
    headers: { Authorization: `Bearer ${token}`, "X-Client-Role": "Universal", "X-Self-ID": "99" },
  });
  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const frames: Frame[] = [];
  let ready = Promise.withResolvers<void>();
  socket.addEventListener("message", ({ data }) => {
    frames.push(JSON.parse(data));
    ready.resolve();
  });
  let messageId = 0;

  return {
    socket, opened, frames,
    async next() {
      if (!frames.length) await deadline(ready.promise, "未收到更新日志测试 OneBot 消息。");
      const frame = frames.shift()!;
      if (!frames.length) ready = Promise.withResolvers<void>();
      return frame;
    },
    command(message: string) {
      socket.send(JSON.stringify({
        post_type: "message", message_type: "group", sub_type: "normal", message_id: ++messageId,
        self_id: 99, user_id: 42, group_id: 77, sender: { role: "member" }, message,
      }));
    },
    receipt(frame: Frame, accepted: boolean) {
      expect(typeof frame.echo).toBe("string");
      socket.send(JSON.stringify({
        echo: frame.echo, status: accepted ? "ok" : "failed", retcode: accepted ? 0 : 1404,
        data: accepted ? { message_id: 7 } : undefined,
      }));
    },
  };
}

test("普通群用户可查询宿主和已加载插件的脱敏 Git 更新日志", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-trss-update-log-"));
  let host: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let client: ReturnType<typeof gateway> | undefined;
  try {
    await copyHost(root);
    git(root, "init", "--quiet");
    git(root, "add", "app.ts");
    git(root, "commit", "--quiet", "-m", rootSubject);
    git(root, "commit", "--quiet", "--allow-empty", "-m", `兼容历史配置 Authorization: Bearer ${credential}`,
      "-m", "fixture-commit-description-hidden");

    for (const [name, subject] of [[plugin, `${pluginSubject} Cookie: ${cookie}`], ["miao-plugin", rejectedSubject]] as const) {
      const directory = join(root, "plugins", name);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "package.json"), JSON.stringify({
        name: name === plugin ? `@fixture/${plugin}` : name, type: "module", lotusYunzai: { entry: "./index.ts" },
      }));
      await writeFile(join(directory, "index.ts"), 'export default { commands: {} };');
      git(directory, "init", "--quiet");
      git(directory, "add", "package.json", "index.ts");
      git(directory, "commit", "--quiet", "-m", subject);
    }

    disableMemberPrewarm(root);
    host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: token },
    });
    const stderr = new Response(host.stderr).text();
    const endpoint = await deadline(endpointOf(host.stdout), "更新日志测试宿主启动超时。");
    const bot = gateway(endpoint);
    client = bot;
    await deadline(bot.opened, "更新日志测试网关连接超时。");

    async function forwarded(command: string, accept = true) {
      bot.command(command);
      const frame = await bot.next();
      expect(frame).toMatchObject({ action: "send_group_forward_msg", params: { group_id: 77 } });
      bot.receipt(frame, accept);
      return frame.params.messages?.flatMap(({ data }) => data.content.map(({ data }) => data.text)).join("\n");
    }

    const rootHistory = await forwarded("#更新日志");
    expect(rootHistory).toContain("Lotus-Yunzai 更新日志，共2条");
    expect(rootHistory).toContain(rootSubject);
    expect(rootHistory).toContain("兼容历史配置 Authorization: [已隐藏]");
    expect(rootHistory).not.toContain(credential);
    expect(rootHistory).not.toContain("fixture-commit-description-hidden");

    const joinedHistory = await forwarded("#更新日志history-fixture");
    expect(joinedHistory).toContain(`${plugin} 更新日志，共1条`);
    expect(joinedHistory).toContain(`${pluginSubject} Cookie: [已隐藏]`);
    expect(joinedHistory).not.toContain(cookie);
    expect(joinedHistory).not.toContain(rootSubject);
    expect(await forwarded(`#更新日志 @fixture/${plugin}`)).toBe(joinedHistory);

    const spacedHistory = await forwarded("#更新日志 history-fixture-plugin", false);
    expect(spacedHistory).toBe(joinedHistory);
    const fallback = await bot.next();
    expect(fallback).toMatchObject({ action: "send_msg", params: { group_id: 77 } });
    expect(fallback.params.message).toContain(pluginSubject);
    expect(fallback.params.message).not.toContain(cookie);
    expect(fallback.params.message).not.toContain(rootSubject);

    bot.command("#更新日志 miao-plugin");
    const unavailable = await bot.next();
    expect(unavailable).toMatchObject({ action: "send_msg", params: { group_id: 77, message: "暂无可用的更新日志。" } });
    expect(unavailable.params.message).not.toContain(rejectedSubject);
    expect(unavailable.params.message).not.toContain("更新日志，共");

    host.kill();
    expect(await deadline(host.exited, "更新日志测试宿主退出超时。")).toBe(143);
    expect(await stderr).toContain("拒绝加载 miao-plugin");
    expect(bot.frames).toEqual([]);
  } finally {
    client?.socket.close();
    if (host && host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
    await host?.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 12_000);
