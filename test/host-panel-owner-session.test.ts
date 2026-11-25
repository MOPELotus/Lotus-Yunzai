import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

test("private owner command issues a browser session through the actual host", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-panel-session-host-"));
  const token = "onebot-panel-fixture";
  const origin = "https://panel.example.invalid";
  const HostSocket = WebSocket as unknown as new (url: URL, options: Bun.WebSocketOptions) => WebSocket;
  let host: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let socket: WebSocket | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await copyHost(root);
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "config/other.yaml"), 'master: ["99:42", "100:43"]\n');
    disableMemberPrewarm(root);
    host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: {
        PATH: process.env.PATH, LOTUS_HTTP_PORT: "0", LOTUS_ONEBOT_TOKEN: token, LOTUS_PANEL_PUBLIC_URL: origin,
      },
    });
    deadline = setTimeout(() => host?.kill("SIGKILL"), 6000);
    const errors = new Response(host.stderr).text();
    const stdout = host.stdout.pipeThrough(new TextDecoderStream()).getReader();
    let output = "";
    let base: URL;
    try {
      for (;;) {
        const listening = /http:\/\/127\.0\.0\.1:\d+\/status/u.exec(output);
        if (listening) {
          base = new URL(listening[0]);
          break;
        }
        const next = await stdout.read();
        if (next.done) throw new Error(`宿主未开始监听。\n${output}\n${await errors}`);
        output += next.value;
      }
    } finally { stdout.releaseLock(); }
    const gateway = new URL("/OneBotv11", base);
    gateway.protocol = "ws:";
    const connected = new HostSocket(gateway, {
      headers: { Authorization: `Bearer ${token}`, "X-Client-Role": "Universal", "X-Self-ID": "99" },
    });
    socket = connected;
    await new Promise<void>((resolve, reject) => {
      connected.addEventListener("open", () => resolve(), { once: true });
      connected.addEventListener("error", () => reject(new Error("OneBot 未连接。")), { once: true });
    });
    async function command(user: number, group = false) {
      const reply = await new Promise<{ params: { message: string; user_id?: number; group_id?: number } }>((resolve, reject) => {
        const timer = setTimeout(() => {
          connected.removeEventListener("message", receive);
          reject(new Error("管理面板命令没有回复。"));
        }, 2500);
        function receive({ data }: MessageEvent) {
          clearTimeout(timer);
          resolve(JSON.parse(String(data)));
        }
        connected.addEventListener("message", receive, { once: true });
        connected.send(JSON.stringify({
          post_type: "message", self_id: 99, user_id: user, message: "#管理面板",
          ...(group ? { message_type: "group", sub_type: "normal", group_id: 66 } : { message_type: "private", sub_type: "friend" }),
        }));
      });
      expect(group ? reply.params.group_id : reply.params.user_id).toBe(group ? 66 : user);
      return reply.params.message;
    }
    expect(await command(43)).toContain("只有当前机器人主人");
    expect(await command(42, true)).not.toContain("#ticket=");
    const link = /https:\/\/panel\.example\.invalid\/panel\/#ticket=([\w-]{43})/u.exec(await command(42));
    expect(link).not.toBeNull();
    const claim = new URL("/panel/api/session/claim", base);
    const status = new URL("/panel/api/status", base);
    const request = () => fetch(claim, {
      method: "POST", headers: { Origin: origin, "X-Lotus-Panel-Session": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ ticket: link![1] }), signal: AbortSignal.timeout(2500),
    });
    expect((await fetch(status)).status).toBe(401);
    const response = await request();
    expect(response.status).toBe(204);
    const cookie = response.headers.get("Set-Cookie")!.split(";", 1)[0]!;
    expect((await fetch(status, { headers: { Cookie: cookie } })).status).toBe(200);
    expect((await request()).status).toBe(401);
  } finally {
    clearTimeout(deadline);
    socket?.close();
    host?.kill();
    await host?.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 9000);

test("未启用管理网页时，两协议的管理命令仍有明确回执", async () => {
  const { withDualGatewayFixture } = await import("./host-dual-gateway-fixture.ts");
  await withDualGatewayFixture("disabled-panel-route", 'master: ["99:42", "100:43"]\n', async gateways => {
    for (const command of ["#管理面板", "#配置面板", "#面板管理"]) {
      gateways.sendOneBot(command);
      const onebot = await gateways.onebot.next("send_msg");
      expect(onebot.params.message).toBe("管理面板尚未配置可用于登录的访问地址。");
      onebot.respond({ message_id: 1 });
      expect((await gateways.sendMilky(command)).status).toBe(200);
      const milky = await gateways.milky.next("send_private_message");
      expect(JSON.stringify(milky.params)).toContain("管理面板尚未配置可用于登录的访问地址。");
      milky.respond({ message_seq: 1 });
    }
  });
}, 15_000);
