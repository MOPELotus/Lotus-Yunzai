import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

interface Frame {
  action: string;
  echo?: string;
  params: Record<string, unknown>;
}

async function gateway(endpoint: string, botId?: number) {
  const Socket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
  const headers: Record<string, string> = { Authorization: "Bearer enrollment-fixture", "X-Client-Role": "Universal" };
  if (botId !== undefined) headers["X-Self-ID"] = String(botId);
  const socket = new Socket(endpoint, { headers });
  const frames: Frame[] = [];
  socket.addEventListener("message", ({ data }) => frames.push(JSON.parse(data)));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const send = (value: object) => socket.send(JSON.stringify({ self_id: botId ?? 99, ...value }));
  return {
    close: () => socket.close(),
    command(message: string, user_id: number, fields: object = {}) {
      send({ post_type: "message", message_type: "private", sub_type: "friend", user_id, message, ...fields });
    },
    async take(): Promise<Frame> {
      const deadline = performance.now() + 1_500;
      while (!frames.length && performance.now() < deadline) await Bun.sleep(5);
      const frame = frames.shift();
      if (!frame) throw new Error("未收到模拟网关动作。");
      return frame;
    },
    confirm(echo: string) {
      send({ echo, status: "ok", retcode: 0 });
    },
  };
}

test("主人授权只在同一已绑定机器人私聊生效，立即更新现有连接并保留原配置", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-yunzai-master-"));
  try {
    await copyHost(root);
    const directory = join(root, "config", "config");
    await mkdir(directory, { recursive: true });
    const other = join(directory, "other.yaml");
    await writeFile(other, [
      "# 保留运维注释", 'master: ["99:51", "100:61"]', "masterQQ: [51, 61]", "disablePrivate: true",
      "disableMsg: 请使用账户入口", "foreign: { enabled: false }", "",
    ].join("\n"));
    disableMemberPrewarm(root);
    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: "enrollment-fixture" },
    });
    const stop = setTimeout(() => host.kill("SIGKILL"), 10_000);
    const clients: Awaited<ReturnType<typeof gateway>>[] = [];
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
      const a = await gateway(endpoint, 99);
      clients.push(a);
      const b = await gateway(endpoint, 100);
      clients.push(b);
      const unbound = await gateway(endpoint);
      clients.push(unbound);
      async function reply(client: typeof a, recipient: number): Promise<string> {
        const frame = await client.take();
        expect(frame).toMatchObject({ action: "send_msg", params: { message_type: "private", user_id: recipient } });
        return String(frame.params.message);
      }

      unbound.command("#设置主人", 42);
      expect(await reply(unbound, 42)).toContain("已绑定");
      a.command("#状态", 42);
      expect(await reply(a, 42)).toBe("请使用账户入口");
      a.command("#设置主人", 42);
      const application = /申请编号[：:]\s*([a-f\d]{8})/iu.exec(await reply(a, 42))?.[1];
      expect(application).toBeDefined();

      b.command(`#设置主人验证码 ${application}`, 61);
      expect(await reply(b, 61)).not.toMatch(/验证码[：:]\s*[a-f\d]{16}/iu);
      a.command(`#设置主人验证码 ${application}`, 51);
      const code = /验证码[：:]\s*([a-f\d]{16})/iu.exec(await reply(a, 51))?.[1];
      expect(code).toBeDefined();
      a.command(`#设置主人 ${code}`, 43, { isMaster: true });
      expect(await reply(a, 43)).not.toContain("已设置为");
      b.command(`#设置主人 ${code}`, 42);
      expect(await reply(b, 42)).not.toContain("已设置为");
      expect(await readFile(other, "utf8")).not.toContain("99:42");

      a.command(`#设置主人 ${code}`, 42);
      expect(await reply(a, 42)).toContain("已设置为");
      a.command("#撤回", 42, { message_id: 122 });
      const recall = await a.take();
      expect(recall).toMatchObject({ action: "delete_msg", params: { message_id: 122 } });
      a.confirm(recall.echo!);
      const content = await readFile(other, "utf8");
      expect(content).toContain("# 保留运维注释");
      expect(content).not.toContain(code!);
      expect(Bun.YAML.parse(content)).toMatchObject({
        master: expect.arrayContaining(["99:51", "100:61", "99:42"]),
        masterQQ: expect.arrayContaining([51, 61, 42]), foreign: { enabled: false },
      });

      const remainingLog = (async () => {
        const rest = host.stdout.getReader();
        const decoder = new TextDecoder();
        let output = "";
        try {
          for (;;) {
            const chunk = await rest.read();
            if (chunk.done) return output + decoder.decode();
            output += decoder.decode(chunk.value, { stream: true });
          }
        } finally {
          rest.releaseLock();
        }
      })();
      const stderr = new Response(host.stderr).text();
      host.kill();
      expect(await host.exited).toBe(143);
      expect(startup + await remainingLog + await stderr).not.toContain(code!);
    } finally {
      clearTimeout(stop);
      for (const client of clients) client.close();
      if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
      await host.exited;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 12_000);
