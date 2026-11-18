import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost } from "./host-fixture.ts";

interface Frame {
  action: string;
  echo?: string;
  params: Record<string, unknown>;
}

test("旧词条多版本、私聊编辑权限和列表合并转发经过 OneBot 派发", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-yunzai-keywords-"));
  try {
    await copyHost(root);
    const config = join(root, "config", "config");
    const data = join(root, "data", "messageJson");
    await mkdir(config, { recursive: true });
    await mkdir(data, { recursive: true });
    await writeFile(join(config, "group.yaml"), "default: {groupCD: 0, singleCD: 0, addLimit: 1, addPrivate: 1, addReply: 1, addRecall: 0}\n");
    const groupFile = join(data, "77.json");
    const globalFile = join(data, "global.json");
    const text = (value: string) => ({ type: "text", text: value });
    const global = JSON.stringify({ 旧词: [[text("旧全局内容")]] });
    await writeFile(groupFile, JSON.stringify({ 旧词: [[text("旧群内容")]] }));
    await writeFile(globalFile, global);
    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: "keyword-fixture" },
    });
    const stop = setTimeout(() => host.kill("SIGKILL"), 10_000);
    let socket: WebSocket | undefined;
    try {
      const reader = host.stdout.getReader();
      let endpoint: string | undefined;
      let startup = "";
      try {
        const decoder = new TextDecoder();
        while (!endpoint) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error("测试宿主没有启动。");
          startup += decoder.decode(chunk.value, { stream: true });
          endpoint = /ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/u.exec(startup)?.[0];
        }
      } finally {
        reader.releaseLock();
      }
      const Socket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
      const client = new Socket(endpoint, {
        headers: { Authorization: "Bearer keyword-fixture", "X-Client-Role": "Universal", "X-Self-ID": "99" },
      });
      socket = client;
      const frames: Frame[] = [];
      client.addEventListener("message", ({ data }) => frames.push(JSON.parse(data)));
      await new Promise<void>((resolve, reject) => {
        client.addEventListener("open", () => resolve(), { once: true });
        client.addEventListener("error", reject, { once: true });
      });

      let id = 120;
      function command(message: string | object[], fields: object = {}) {
        const message_id = ++id;
        client.send(JSON.stringify({
          self_id: 99, post_type: "message", message_type: "group", group_id: 77,
          user_id: 42, sender: { role: "admin" }, message_id, message, ...fields,
        }));
        return message_id;
      }
      function confirm(frame: Frame, data?: unknown, status = "ok", retcode = 0) {
        client.send(JSON.stringify({ echo: frame.echo, status, retcode, data }));
      }
      async function take(): Promise<Frame> {
        const deadline = performance.now() + 1_500;
        while (!frames.length && performance.now() < deadline) await Bun.sleep(5);
        const frame = frames.shift();
        if (!frame) throw new Error("未收到模拟网关动作。");
        return frame;
      }
      async function checkRole(group_id: number, role: string) {
        const lookup = await take();
        expect(lookup).toMatchObject({ action: "get_group_member_info", params: { group_id: 77, user_id: 42, no_cache: true } });
        confirm(lookup, { group_id, user_id: 42, role });
      }
      const privateChat = { message_type: "private" };
      const wireText = (value: string) => ({ type: "text", data: { text: value } });
      const oldMessage = command("旧词2");
      expect(await take()).toMatchObject({ action: "send_msg", params: {
        group_id: 77, message: [{ type: "reply", data: { id: String(oldMessage) } }, wireText("旧全局内容")],
      } });

      command("#词条列表");
      const listing = await take();
      expect(listing).toMatchObject({ action: "send_group_forward_msg", params: {
        group_id: 77, messages: expect.arrayContaining([
          { type: "node", data: { name: "Lotus-Yunzai", uin: "99", content: [wireText("消息列表：第1页，共1条")] } },
        ]),
      } });
      confirm(listing, { message_id: 133 });

      command("#添加新词", privateChat);
      await checkRole(78, "owner");
      expect(JSON.stringify(await take())).toContain("权限");
      command("#添加新词", privateChat);
      await checkRole(77, "admin");
      expect(JSON.stringify(await take())).toContain("结束添加");
      command([wireText("新文本"), { type: "face", data: { id: "14" } }], privateChat);
      command("#结束添加", privateChat);
      await checkRole(77, "admin");
      expect(JSON.stringify(await take())).toContain("添加成功");
      expect(JSON.parse(await readFile(groupFile, "utf8")).新词).toEqual([
        [text("新文本"), { type: "face", id: "14" }],
      ]);

      command("#词条列表", privateChat);
      const privateList = await take();
      expect(privateList).toMatchObject({ action: "send_private_forward_msg", params: { user_id: 42 } });
      confirm(privateList, undefined, "failed", 1404);
      expect(JSON.stringify(await take())).toContain("新词");
      command("#删除旧词1");
      expect(JSON.stringify(await take())).toContain("删除成功");
      expect(JSON.parse(await readFile(groupFile, "utf8"))).not.toHaveProperty("旧词");
      expect(await readFile(globalFile, "utf8")).toBe(global);
    } finally {
      clearTimeout(stop);
      socket?.close();
      if (host.exitCode === null && host.signalCode === null) host.kill();
      await host.exited;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 12_000);
