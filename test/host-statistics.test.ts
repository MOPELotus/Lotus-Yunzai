import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

interface Frame {
  readonly action: string;
  readonly params: { group_id?: number; message?: unknown };
}

const valkeyServer = Bun.which("valkey-server");
const valkeyCli = Bun.which("valkey-cli");
const oldDate = "2025:03:04";
const displayDate = "2025-03-04";
const auth = "statistics-fixture";

function timeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), 2_500); }),
  ]).finally(() => clearTimeout(timer));
}

async function endpoint(host: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<string> {
  const reader = host.stdout.getReader();
  const decoder = new TextDecoder();
  let startup = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("统计测试宿主未启动。");
      startup += decoder.decode(chunk.value, { stream: true });
      const match = /ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/u.exec(startup);
      if (match) return match[0];
    }
  } finally {
    reader.releaseLock();
  }
}

function gateway(url: string, botId: number) {
  const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
  const socket = new BunWebSocket(url, {
    headers: { Authorization: `Bearer ${auth}`, "X-Client-Role": "Universal", "X-Self-ID": String(botId) },
  });
  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let ready = Promise.withResolvers<void>();
  const frames: Frame[] = [];
  socket.addEventListener("message", ({ data }) => {
    frames.push(JSON.parse(data));
    ready.resolve();
  });

  let messageId = 0;
  function send(message: string | object[], userId: number, groupId: number, extra: object = {}) {
    socket.send(JSON.stringify({
      post_type: "message", message_type: "group", sub_type: "normal",
      self_id: botId, user_id: userId, group_id: groupId, message_id: ++messageId,
      sender: { role: "member" }, message, ...extra,
    }));
  }
  return {
    opened,
    close: () => socket.close(),
    send,
    async reply(message: string | object[], userId: number, groupId: number, extra?: object) {
      send(message, userId, groupId, extra);
      if (!frames.length) await timeout(ready.promise, "未收到统计测试回复。");
      const frame = frames.shift()!;
      if (!frames.length) ready = Promise.withResolvers<void>();
      expect(frame).toMatchObject({ action: "send_msg", params: { group_id: groupId } });
      return frame.params.message;
    },
  };
}

function seedKey(direction: string, kind: string, scope: string, date: string) {
  return `Yz:count:${direction}:${kind}:${scope}:${date}`;
}

test.skipIf(!valkeyServer || !valkeyCli)("TRSS 旧统计键可查询，新消息按身份与旧配置累计", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-trss-statistics-"));
  const listen = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listen.port;
  listen.stop(true);
  const password = crypto.randomUUID();
  const server = Bun.spawn([
    valkeyServer!, "--bind", "127.0.0.1", "--port", String(port), "--requirepass", password,
    "--save", "", "--appendonly", "no", "--dir", root,
  ], { stdout: "ignore", stderr: "ignore" });
  const redis = async (...args: string[]) => {
    const command = Bun.spawn([valkeyCli!, "-h", "127.0.0.1", "-p", String(port), "--json", ...args], {
      stdout: "pipe", stderr: "pipe", env: { ...process.env, REDISCLI_AUTH: password },
    });
    const [stdout, status] = await Promise.all([new Response(command.stdout).text(), command.exited]);
    if (status !== 0) throw new Error("统计测试 Valkey 命令失败。");
    return JSON.parse(stdout) as unknown;
  };

  async function runHost(segmentOption: string, run: (connect: (botId: number) => Promise<ReturnType<typeof gateway>>) => Promise<void>) {
    await writeFile(join(root, "config/config/bot.yaml"), `msg_type_count: ${segmentOption}\nonline_msg_exp: 0\n`);
    disableMemberPrewarm(root);
    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore",
      env: {
        PATH: process.env.PATH, TZ: "Asia/Shanghai", LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: auth,
        LOTUS_VALKEY_URL: `redis://:${password}@127.0.0.1:${port}`,
      },
    });
    const stderr = new Response(host.stderr).text();
    const clients: ReturnType<typeof gateway>[] = [];
    try {
      const url = await timeout(endpoint(host), "统计测试宿主启动超时。");
      await run(async (botId) => {
        const client = gateway(url, botId);
        clients.push(client);
        await timeout(client.opened, "统计测试网关连接超时。");
        return client;
      });
      host.kill();
      await timeout(host.exited, "统计测试宿主退出超时。");
      expect(await stderr).not.toContain("处理 OneBot 事件失败");
    } finally {
      for (const client of clients) client.close();
      if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
      await host.exited;
    }
  }

  try {
    for (let attempt = 0; ; attempt++) {
      if (await redis("PING").catch(() => null) === "PONG") break;
      if (attempt === 49) throw new Error("统计测试 Valkey 启动超时。");
      await Bun.sleep(40);
    }
    await copyHost(root);
    await mkdir(join(root, "config/config"), { recursive: true });
    await writeFile(join(root, "config/config/other.yaml"), 'master: ["99:51"]\n');
    const probe = join(root, "plugins", "statistics-fixture");
    await mkdir(probe, { recursive: true });
    await writeFile(join(probe, "package.json"), JSON.stringify({
      name: "statistics-fixture", type: "module", lotusYunzai: { entry: "./index.ts" },
    }));
    await writeFile(join(probe, "index.ts"), `
      export default { commands: { "#统计测试": () =>
        [{ type: "text", text: "计数样例" }, { type: "face", id: 14 }] } };
    `);

    await redis("MSET",
      seedKey("receive", "msg", "total", oldDate), "104",
      seedKey("receive", "msg", "bot:99", oldDate), "88",
      seedKey("send", "msg", "bot:99", oldDate), "19",
      seedKey("receive", "msg", "user:42", oldDate), "17",
      seedKey("send", "msg", "user:42", oldDate), "5",
      seedKey("receive", "msg", "group:77", oldDate), "33",
      seedKey("send", "msg", "group:77", oldDate), "11",
      seedKey("receive", "msg", "user:777", oldDate), "73",
      seedKey("send", "msg", "user:777", oldDate), "52",
      seedKey("receive", "msg", "group:999", oldDate), "13",
    );

    const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" })
      .format(new Date()).replaceAll("-", ":");
    await runHost("1", async (connect) => {
      const main = await connect(99);
      const face = [{ type: "text", data: { text: "#统计测试" } }, { type: "face", data: { id: "14" } }];
      const expected = [{ type: "text", data: { text: "计数样例" } }, { type: "face", data: { id: "14" } }];
      expect(await main.reply("#统计测试", 66, 88)).toEqual(expected);
      expect(await main.reply(face, 66, 88)).toEqual(expected);

      const selected = await main.reply(`#统计 机器人 99 用户 42 群 77 日期 ${displayDate}`, 51, 77);
      expect(selected).toBe([
        "消息统计", `机器人 99\n${displayDate} 收 88 发 19`,
        `用户 42\n${displayDate} 收 17 发 5`, `群 77\n${displayDate} 收 33 发 11`,
      ].join("\n\n"));
      const aggregate = await main.reply(`#统计 日期 ${displayDate}`, 51, 77);
      expect(aggregate).toContain(`总消息量\n${displayDate} 收 104 发 0`);
      expect(aggregate).toContain(`用户量\n${displayDate} 收 2 发 2`);
      expect(aggregate).toContain(`群量\n${displayDate} 收 2 发 1`);

      expect(await main.reply(`#统计 日期 ${displayDate}`, 42, 77)).toBe([
        "消息统计", `用户 42\n${displayDate} 收 17 发 5`, `群 77\n${displayDate} 收 33 发 11`,
      ].join("\n\n"));
      expect(await main.reply(`#统计 用户 777 群 999 日期 ${displayDate}`, 42, 77, {
        isMaster: true, sender: { role: "owner", user_id: 51 },
      })).toBe("仅当前机器人的主人可以指定统计对象。");
      const other = await connect(100);
      other.send(`#统计 用户 777 日期 ${displayDate}`, 51, 77, { self_id: 99 });
      expect(await other.reply(`#统计 用户 777 日期 ${displayDate}`, 51, 77))
        .toBe("仅当前机器人的主人可以指定统计对象。");
      expect(await main.reply("#状态", 42, 77)).toContain("Lotus-Yunzai 正在运行");
      expect(await main.reply(`#状态 用户 42 日期 ${displayDate}`, 51, 77))
        .toContain(`用户 42\n${displayDate} 收 17 发 5`);
    });

    const [year, month] = today.split(":");
    const periods = [today, `${year}:${month}`, year!, "total"];
    for (const bucket of periods) {
      expect(await redis("MGET",
        seedKey("receive", "msg", "group:88", bucket), seedKey("send", "msg", "group:88", bucket),
        seedKey("receive", "text", "user:66", bucket), seedKey("send", "text", "user:66", bucket),
        seedKey("receive", "face", "group:88", bucket), seedKey("send", "face", "group:88", bucket),
        seedKey("receive", "face", "bot:99", bucket), seedKey("send", "face", "bot:99", bucket),
        seedKey("receive", "face", "total", bucket), seedKey("send", "face", "total", bucket),
      )).toEqual(["2", "2", "2", "2", "1", "2", "1", "2", "1", "2"]);
    }
    expect(await redis("MGET",
      seedKey("receive", "msg", "total", "total"), seedKey("send", "msg", "total", "total"),
      seedKey("receive", "msg", "bot:99", "total"), seedKey("send", "msg", "bot:99", "total"),
      seedKey("receive", "msg", "bot:100", "total"), seedKey("send", "msg", "bot:100", "total"),
      seedKey("receive", "msg", "user:66", "total"), seedKey("send", "msg", "user:66", "total"),
    )).toEqual(["9", "9", "8", "8", "1", "1", "2", "2"]);

    await runHost('"unsupported"', async (connect) => {
      const main = await connect(99);
      await main.reply([{ type: "text", data: { text: "#统计测试" } }, { type: "face", data: { id: "14" } }], 67, 89);
    });
    expect(await redis("MGET",
      seedKey("receive", "msg", "group:89", "total"), seedKey("send", "msg", "group:89", "total"),
      seedKey("receive", "face", "group:89", "total"), seedKey("send", "face", "group:89", "total"),
    )).toEqual(["1", "1", null, null]);
  } finally {
    if (server.exitCode === null && server.signalCode === null) server.kill();
    await server.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
