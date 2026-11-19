import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

const token = "scheduled-restart-fixture";

interface Frame {
  readonly action: string;
  readonly echo?: string;
  readonly params: { readonly message: string; readonly message_type: string; readonly user_id: number };
}

function deadline<T>(promise: Promise<T>, description: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(description)), 6_000);
    void promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function gateway(endpoint: string, botId: number, acknowledge: boolean) {
  const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
  const socket = new BunWebSocket(endpoint, {
    headers: { Authorization: `Bearer ${token}`, "X-Client-Role": "Universal", "X-Self-ID": String(botId) },
  });
  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const closed = new Promise<void>((resolve) => socket.addEventListener("close", () => resolve(), { once: true }));
  const frames: Frame[] = [];
  let ready = Promise.withResolvers<void>();
  function confirm(frame: Frame) {
    if (frame.echo) socket.send(JSON.stringify({ echo: frame.echo, status: "ok", retcode: 0, data: { message_id: 7 } }));
  }
  socket.addEventListener("message", ({ data }) => {
    const frame: Frame = JSON.parse(data);
    frames.push(frame);
    ready.resolve();
    if (acknowledge) confirm(frame);
  });
  let messageId = 0;
  return {
    socket, opened, closed, frames, confirm,
    async next() {
      if (!frames.length) await deadline(ready.promise, `机器人 ${botId} 未收到定时重启测试消息。`);
      const frame = frames.shift()!;
      if (!frames.length) ready = Promise.withResolvers<void>();
      return frame;
    },
    command(message: string, userId: number) {
      socket.send(JSON.stringify({
        post_type: "message", message_type: "private", sub_type: "friend", self_id: botId,
        user_id: userId, message_id: ++messageId, message,
      }));
    },
  };
}

type Gateway = ReturnType<typeof gateway>;

async function withHost(botConfig: string, preload: string | undefined, run: (fixture: {
  pid: number;
  nextBoot(): Promise<string>;
  waitForMilkyReceipts(count: number): Promise<void>;
  open(endpoint: string, botId: number, acknowledge?: boolean): Promise<Gateway>;
  disposals(): Promise<string>;
}) => Promise<void>, milkyPort?: number) {
  const root = await mkdtemp(join(tmpdir(), "lotus-trss-scheduled-restart-"));
  const clients: Gateway[] = [];
  try {
    await copyHost(root);
    const plugin = join(root, "plugins/restart-fixture");
    await Promise.all([mkdir(plugin), mkdir(join(root, "config/config"), { recursive: true })]);
    await Promise.all([
      writeFile(join(root, "config/config/bot.yaml"), botConfig),
      writeFile(join(root, "config/config/other.yaml"), 'master: ["99:51", "99:54", "100:52", "101:53"]\n'),
      writeFile(join(plugin, "package.json"), JSON.stringify({
        name: "restart-fixture", type: "module", lotusYunzai: { entry: "./index.ts" },
      })),
      writeFile(join(plugin, "index.ts"), `
        import { appendFile } from "node:fs/promises";
        console.log("fixture-restart-pid " + process.pid);
        export default {
          commands: {},
          dispose() { return appendFile(new URL("../../fixture-disposals.txt", import.meta.url), process.pid + "\\n"); },
        };
      `),
      ...(preload === undefined ? [] : [writeFile(join(root, "fixture-clock.js"), preload)]),
      ...(milkyPort === undefined ? [] : [writeFile(join(root, "config/milky.yaml"), [
        "enable: true", "host: 127.0.0.1", `port: ${milkyPort}`, `access_token: ${token}`,
        "ws:", "  reconnect_interval: 0.05", "",
      ].join("\n"))]),
    ]);
    disableMemberPrewarm(root);
    const args = preload === undefined ? ["app.ts"] : ["--preload", "./fixture-clock.js", "app.ts"];
    const host = Bun.spawn([process.execPath, ...args], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, TZ: "UTC", LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: token },
    });
    const stderr = new Response(host.stderr).text();
    const reader = host.stdout.getReader();
    const decoder = new TextDecoder();
    let output = "";
    async function readOutput(pattern: RegExp) {
      while (true) {
        const match = pattern.exec(output);
        if (match) {
          output = output.slice(match.index + match[0].length);
          return match;
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`宿主未输出 ${pattern}。\n${output}\n${await stderr}`);
        output += decoder.decode(chunk.value, { stream: true });
      }
    }
    try {
      await run({
        pid: host.pid,
        async nextBoot() {
          const pattern = /fixture-restart-pid (\d+)\n[\s\S]*?(ws:\/\/127\.0\.0\.1:\d+\/OneBotv11)/u;
          const match = await deadline(readOutput(pattern), "定时重启宿主启动超时。");
          expect(Number(match[1])).toBe(host.pid);
          return match[2]!;
        },
        async waitForMilkyReceipts(count) {
          for (let received = 0; received < count; received++) {
            await deadline(readOutput(/fixture-milky-send-confirmed\n/u), "宿主未处理 Milky 发送回执。");
          }
        },
        async open(endpoint, botId, acknowledge = true) {
          const client = gateway(endpoint, botId, acknowledge);
          clients.push(client);
          await deadline(client.opened, "定时重启测试网关连接超时。");
          return client;
        },
        disposals: () => readFile(join(root, "fixture-disposals.txt"), "utf8"),
      });
      host.kill();
      expect(await deadline(host.exited, "定时重启测试宿主退出超时。")).toBe(143);
      expect(await stderr).not.toMatch(/无效的 restart_cron|处理 OneBot 事件失败|未确认进程操作/u);
    } finally {
      for (const { socket } of clients) socket.close();
      if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
      await host.exited;
      await reader.cancel();
      reader.releaseLock();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function expectNotifications(client: Gateway, userIds: readonly number[], prefix: RegExp) {
  const notified = [];
  for (const _user of userIds) {
    const frame = await client.next();
    expect(frame.action).toBe("send_msg");
    expect(frame.params.message_type).toBe("private");
    expect(frame.params.message).toMatch(prefix);
    expect(typeof frame.echo).toBe("string");
    notified.push(frame.params.user_id);
  }
  expect(notified.sort()).toEqual([...userIds].sort());
}

test.skipIf(process.platform !== "linux")("分钟小数间隔重启保留 PID，主人在各自机器人上线后收到回执", async () => {
  await withHost("restart_time: 0.05\n", undefined, async ({ pid, nextBoot, open, disposals }) => {
    const initial = await nextBoot();
    const first = await open(initial, 99);
    const second = await open(initial, 100);
    await Promise.all([
      expectNotifications(first, [51, 54], /^开始重启/u), expectNotifications(second, [52], /^开始重启/u),
    ]);
    const [restarted] = await Promise.all([nextBoot(), deadline(first.closed, "旧 OneBot 连接没有关闭。")]);
    expect(await disposals()).toBe(`${pid}\n`);
    const previouslyOffline = await open(restarted, 101);
    await expectNotifications(previouslyOffline, [53], /^重启成功，用时/u);
    const secondAgain = await open(restarted, 100);
    await expectNotifications(secondAgain, [52], /^重启成功，用时/u);
    const firstAgain = await open(restarted, 99);
    await expectNotifications(firstAgain, [51, 54], /^重启成功，用时/u);
    expect(firstAgain.frames).toEqual([]);
    expect(secondAgain.frames).toEqual([]);
  });
}, 15_000);

test.skipIf(process.platform !== "linux")("等待定时重启通知回执时收到的关机命令在重启后仍生效", async () => {
  await withHost("restart_time: 0.04\n", undefined, async ({ nextBoot, open }) => {
    const first = await open(await nextBoot(), 99, false);
    const notices = [await first.next(), await first.next()];
    for (const notice of notices) expect(notice.params.message).toMatch(/^开始重启/u);
    first.command("#关机", 51);
    expect((await first.next()).params.message).toMatch(/^关机成功/u);
    for (const notice of notices) first.confirm(notice);

    const resumed = await open(await nextBoot(), 99);
    resumed.command("#状态", 51);
    await Bun.sleep(100);
    expect(resumed.frames).toEqual([]);
    resumed.command("#开机", 51);
    expect((await resumed.next()).params.message).toMatch(/^开机成功/u);
  });
}, 15_000);

// Keep real cron timers. The second image advances beyond the first firing minute.
const cronClock = `
  import { existsSync, readFileSync, writeFileSync } from "node:fs";
  const DateConstructor = Date;
  const epoch = new URL("./fixture-epoch", import.meta.url);
  const restarted = existsSync(epoch);
  if (!restarted) writeFileSync(epoch, String(DateConstructor.now()));
  const offset = DateConstructor.parse("2032-04-14T12:59:56.000Z") - Number(readFileSync(epoch, "utf8"));
  const now = () => DateConstructor.now() + offset + (restarted ? 60_000 : 0);
  globalThis.Date = new Proxy(DateConstructor, {
    get: (target, key, receiver) => key === "now" ? now : Reflect.get(target, key, receiver),
    construct: (target, args, constructor) => Reflect.construct(target, args.length ? args : [now()], constructor),
    apply: () => new DateConstructor(now()).toString(),
  });
`;

test.skipIf(process.platform !== "linux")("定时重启保留软关机的时间与暂停状态并静默重连", async () => {
  await withHost('restart_cron: ["0 0 13 * * *", "15 13 * * *"]\n', cronClock, async ({ pid, nextBoot, open, disposals }) => {
    const initial = await nextBoot();
    const first = await open(initial, 99);
    const second = await open(initial, 100);
    first.command("#关机", 51);
    expect((await first.next()).params.message).toMatch(/^关机成功/u);
    const [restarted] = await Promise.all([nextBoot(), deadline(first.closed, "旧 OneBot 连接没有关闭。")]);
    expect(await disposals()).toBe(`${pid}\n`);
    expect(first.frames).toEqual([]);
    expect(second.frames).toEqual([]);

    const firstAgain = await open(restarted, 99);
    const secondAgain = await open(restarted, 100);
    firstAgain.command("#状态", 51);
    secondAgain.command("#状态", 42);
    await Bun.sleep(100);
    expect(firstAgain.frames).toEqual([]);
    expect(secondAgain.frames).toEqual([]);
    firstAgain.command("#开机", 51);
    expect((await firstAgain.next()).params.message).toMatch(/^开机成功，距离上次关机1分/u);
    secondAgain.command("#状态", 42);
    expect((await secondAgain.next()).params.message).toMatch(/^Lotus-Yunzai 正在运行/u);
  });
}, 15_000);

function milkyGateway(botId: number) {
  const initial = Promise.withResolvers<void>();
  const resumed = Promise.withResolvers<void>();
  const oldClosed = Promise.withResolvers<void>();
  const allowReconnect = Promise.withResolvers<void>();
  const replies: { user_id: number; message: { type: string; data: { text: string } }[] }[] = [];
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
        return Response.json({ status: "ok", retcode: 0, data: { uin: botId, nickname: "定时重启夹具" } });
      }
      if (pathname !== "/api/send_private_message") return new Response(null, { status: 404 });
      replies.push(await request.json() as typeof replies[number]);
      available.resolve();
      return Response.json({ status: "ok", retcode: 0, data: { message_seq: ++sequence } });
    },
    websocket: {
      open(socket) { (socket.data === 0 ? initial : resumed).resolve(); },
      message() {},
      close(socket) { if (socket.data === 0) oldClosed.resolve(); },
    },
  });
  return {
    server, initial, resumed, oldClosed, allowReconnect, replies,
    async expectNotifications(userIds: readonly number[], prefix: RegExp) {
      const notified: number[] = [];
      for (const _user of userIds) {
        if (!replies.length) await deadline(available.promise, `Milky 未发送 ${prefix}。`);
        const reply = replies.shift()!;
        if (!replies.length) available = Promise.withResolvers<void>();
        expect(reply.message).toEqual([{ type: "text", data: { text: expect.stringMatching(prefix) } }]);
        notified.push(reply.user_id);
      }
      expect(notified.sort()).toEqual([...userIds].sort());
    },
  };
}

// The gateway sees the request before the host reads its HTTP confirmation.
// Wait past the host's response handlers before terminating it in the test.
const milkyReceiptObserver = `
  const responseJson = Response.prototype.json;
  Response.prototype.json = async function () {
    const body = await responseJson.call(this);
    if (this.url.endsWith("/api/send_private_message") && body.status === "ok") {
      setImmediate(() => console.log("fixture-milky-send-confirmed"));
    }
    return body;
  };
`;

test.skipIf(process.platform !== "linux")("定时重启向触发时仅 Milky 在线的账号回执，同号 OneBot 先上线也不丢失", async () => {
  const milky = milkyGateway(99);
  try {
    await withHost('restart_cron: "0 0 13 * * *"\n', cronClock + milkyReceiptObserver, async ({
      pid, nextBoot, open, disposals, waitForMilkyReceipts,
    }) => {
      const original = await nextBoot();
      const another = await open(original, 100);
      await deadline(milky.initial.promise, "触发前 Milky 未上线。");
      await Promise.all([
        milky.expectNotifications([51, 54], /^开始重启/u), expectNotifications(another, [52], /^开始重启/u),
      ]);
      const [replacement] = await Promise.all([nextBoot(), deadline(milky.oldClosed.promise, "旧 Milky 连接没有关闭。")]);
      expect(await disposals()).toBe(`${pid}\n`);

      const sameAccount = await open(replacement, 99);
      sameAccount.command("#状态", 51);
      expect((await sameAccount.next()).params.message).toMatch(/^Lotus-Yunzai 正在运行/u);
      const oneBotAgain = await open(replacement, 100);
      await expectNotifications(oneBotAgain, [52], /^重启成功，用时/u);
      milky.allowReconnect.resolve();

      await deadline(milky.resumed.promise, "重启后的 Milky 未上线。");
      await milky.expectNotifications([51, 54], /^重启成功，用时/u);
      await waitForMilkyReceipts(2);
      expect(sameAccount.frames).toEqual([]);
      expect(milky.replies).toEqual([]);
    }, milky.server.port);
  } finally {
    milky.allowReconnect.resolve();
    milky.server.stop(true);
  }
}, 18_000);
