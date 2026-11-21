import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

const token = "onebot-attachment-fixture";
const name = "旧抽卡记录.json";
const fileId = "/a964668d-13c2-49d0-9ae4-aa8355658559";
const groupFileId = "/618691d8-ed5c-43a8-909a-6b432e5071d8";
const bytes = "e30K";
const offlineUrl = "https://grouptalk.c2c.qq.com/fixture/download";

interface Frame {
  readonly action: string;
  readonly params: Record<string, unknown>;
  readonly echo?: string;
}

function deadline<T>(pending: Promise<T>, label: string): Promise<T> {
  const { promise, reject } = Promise.withResolvers<T>();
  const timer = setTimeout(() => reject(new Error(`等待 ${label} 超时`)), 3_000);
  return Promise.race([pending, promise]).finally(() => clearTimeout(timer));
}

async function endpoint(stdout: ReadableStream<Uint8Array>) {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) throw new Error(`附件测试宿主未输出监听地址。\n${output}`);
      output += decoder.decode(part.value, { stream: true });
      const found = /ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/u.exec(output)?.[0];
      if (found) return found;
    }
  } finally {
    reader.releaseLock();
  }
}

function openGateway(url: string, botId?: number) {
  const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "X-Client-Role": "Universal" };
  if (botId !== undefined) headers["X-Self-ID"] = String(botId);
  const socket = new BunWebSocket(url, { headers });
  const { promise: opened, resolve, reject } = Promise.withResolvers<void>();
  socket.addEventListener("open", () => resolve(), { once: true });
  socket.addEventListener("error", () => reject(new Error("OneBot 附件测试网关连接失败")), { once: true });
  const frames: Frame[] = [];
  let ready = Promise.withResolvers<void>();
  socket.addEventListener("message", ({ data }) => {
    frames.push(JSON.parse(data));
    ready.resolve();
  });
  let sequence = 0;
  function send(event: object) {
    socket.send(JSON.stringify({ self_id: 99, user_id: 42, ...event }));
  }
  return {
    socket, opened, frames, send,
    message(message: string | unknown[], fields: Record<string, unknown> = {}) {
      send({ post_type: "message", message_type: "private", sub_type: "friend", message_id: ++sequence, message, ...fields });
    },
    async expectFrame(action: string, params: object) {
      if (!frames.length) await deadline(ready.promise, action);
      const frame = frames.shift()!;
      if (!frames.length) ready = Promise.withResolvers<void>();
      expect(frame).toMatchObject({ action, params });
      return frame;
    },
    receipt(frame: Frame, data: object) {
      expect(frame.echo).toBeString();
      socket.send(JSON.stringify({ echo: frame.echo, status: "ok", retcode: 0, data }));
    },
  };
}

test("宿主仅从已认证 OneBot 原始附件读取文件，延迟下载绑定原会话", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-onebot-attachment-"));
  const sockets: WebSocket[] = [];
  let host: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  try {
    await copyHost(root);
    disableMemberPrewarm(root);
    const plugin = join(root, "plugins", "attachment-fixture");
    await mkdir(plugin, { recursive: true });
    await Promise.all([
      writeFile(join(plugin, "package.json"), JSON.stringify({
        name: "@fixture/attachment", type: "module", lotusYunzai: { entry: "./index.ts" },
      })),
      writeFile(join(plugin, "index.ts"), `
        export default {
          commands: { "#附件同步": () => "同步" },
          async fallback(message, {attachment}) {
            if (!attachment) return message.includes("#附件检查") ? "无可信附件" : undefined;
            const {name, size, read} = attachment;
            if (name === "稍后读取.json") return "延迟：" + size;
            const bytes = await read();
            return name + ":" + size + ":" + (bytes ? Buffer.from(bytes).toString("base64") : "读取失败");
          },
        };
      `),
      writeFile(join(root, "offline.ts"), `
        globalThis.fetch = async (input) => {
          const url = input instanceof Request ? input.url : String(input);
          if (url !== ${JSON.stringify(offlineUrl)}) {
            console.error("检测到未经允许的下载");
            throw new Error("unexpected fixture request");
          }
          return new Response("{}\\n", {headers:{"Content-Length":"3"}});
        };
      `),
    ]);
    host = Bun.spawn([process.execPath, "--preload", "./offline.ts", "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: token },
    });
    const stderr = new Response(host.stderr).text();
    const url = await deadline(endpoint(host.stdout), "附件测试宿主启动");
    async function connect(botId?: number) {
      const gateway = openGateway(url, botId);
      sockets.push(gateway.socket);
      await deadline(gateway.opened, "OneBot 网关连接");
      return gateway;
    }
    const old = await connect(99);
    const text = { type: "text", data: { text: "#附件检查" } };
    const file = (data: object = {}) => ({ type: "file", data: { file: name, file_id: fileId, file_size: "3", ...data } });
    old.message(`#附件检查 [CQ:file,file=${name},file_id=${fileId},file_size=3]`);
    await old.expectFrame("send_msg", { user_id: 42, message: "无可信附件" });
    old.message("#附件检查 https://localhost/malicious.json");
    await old.expectFrame("send_msg", { user_id: 42, message: "无可信附件" });
    for (const fake of [file({ file_id: name }), file({ file_id: "file:///etc/passwd" }), file({ file_size: "99999999" })]) {
      old.message([text, fake]);
      await old.expectFrame("send_msg", { user_id: 42, message: "无可信附件" });
    }
    const unbound = await connect();
    unbound.message([text, file()]);
    await unbound.expectFrame("send_msg", { user_id: 42, message: "无可信附件" });

    old.message([file({ file: "稍后读取.json" })]);
    await old.expectFrame("send_msg", { user_id: 42, message: "延迟：3" });
    old.message([file({ url: "https://localhost/ignored-direct-link" })]);
    const link = await old.expectFrame("get_private_file_url", { file_id: fileId });
    expect(link.params).toEqual({ file_id: fileId });
    old.receipt(link, { url: "file:///etc/passwd" });
    old.receipt(await old.expectFrame("get_file", { file: fileId }), { file: "/etc/passwd", file_name: name, base64: bytes });
    await old.expectFrame("send_msg", { user_id: 42, message: `${name}:3:${bytes}` });

    old.send({ post_type: "notice", notice_type: "group_upload", group_id: 77,
      file: { id: groupFileId, name, size: 3, busid: 102 } });
    old.receipt(await old.expectFrame("get_group_file_url", { group_id: 77, file_id: groupFileId, busid: 102 }), { url: offlineUrl });
    await old.expectFrame("send_msg", { group_id: 77, message: `${name}:3:${bytes}` });

    old.send({ post_type: "notice", notice_type: "offline_file", file: { name, size: 3, url: offlineUrl } });
    await old.expectFrame("send_msg", { user_id: 42, message: `${name}:3:${bytes}` });
    old.send({ post_type: "notice", notice_type: "offline_file", file: { name, size: 4, url: offlineUrl } });
    await old.expectFrame("send_msg", { user_id: 42, message: `${name}:4:读取失败` });

    for (const invalid of [{ file_name: "同大小但不同的文件.json", base64: bytes }, { file: "/etc/passwd" }]) {
      old.message([file()]);
      old.receipt(await old.expectFrame("get_private_file_url", { file_id: fileId }), {});
      old.receipt(await old.expectFrame("get_file", { file: fileId }), invalid);
      await old.expectFrame("send_msg", { user_id: 42, message: `${name}:3:读取失败` });
    }

    old.message([file()], { self_id: 100 });
    old.message("#附件同步");
    await old.expectFrame("send_msg", { user_id: 42, message: "同步" });
    old.message([file()]);
    await old.expectFrame("get_private_file_url", { file_id: fileId });
    const latest = await connect(99);
    await old.expectFrame("send_msg", { user_id: 42, message: `${name}:3:读取失败` });
    old.message([text, file()]);
    await old.expectFrame("send_msg", { user_id: 42, message: "无可信附件" });
    await Bun.sleep(1_020);
    latest.message("#附件同步");
    await latest.expectFrame("send_msg", { user_id: 42, message: "同步" });
    expect(old.frames).toEqual([]);
    expect(latest.frames).toEqual([]);
    host.kill();
    await deadline(host.exited, "附件测试宿主退出");
    expect(await stderr).not.toMatch(/检测到未经允许的下载|处理 OneBot 事件失败/u);
  } finally {
    for (const socket of sockets) socket.close();
    if (host && host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
    await host?.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
