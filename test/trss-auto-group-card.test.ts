import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

const token = "auto-group-card-fixture";
const botId = 99;
const owner = 42;
const command = "#更新群名片";
const suffix = "夹具文案";

type Rpc = { action: string; params: Record<string, unknown>; echo?: string };
type GatewayResult = { status: string; retcode: number; data?: unknown };
type Receive = (rpc: Rpc) => GatewayResult | Promise<GatewayResult>;

function confirmed(data: unknown = {}): GatewayResult {
  return { status: "ok", retcode: 0, data };
}
const rejected = { status: "failed", retcode: 100 };
const unknown = { status: "fixture-unknown", retcode: 100 };

function cardGateway(adapter: "onebot" | "milky", groups: readonly number[]) {
  const nickname = adapter === "onebot" ? "OneBot 昵称" : "Milky 昵称";
  const desired = `${nickname}｜${suffix}`;
  const setCard = adapter === "onebot" ? "set_group_card" : "set_group_member_card";
  const cards = new Map<number, string>();
  const frames: Rpc[] = [];
  let override: ((rpc: Rpc) => GatewayResult | Promise<GatewayResult> | undefined) | undefined;
  const receive: Receive = (rpc) => {
    frames.push(rpc);
    const intercepted = override?.(rpc);
    if (intercepted) return intercepted;
    const { action, params } = rpc;
    const group = Number(params.group_id);
    if (action === "get_login_info") {
      return confirmed(adapter === "onebot" ? { user_id: botId, nickname } : { uin: botId, nickname });
    }
    if (action === "get_group_list") {
      const rows = groups.map((group_id) => ({ group_id }));
      return confirmed(adapter === "onebot" ? rows : { groups: rows });
    }
    if (action === "get_group_member_info") {
      const member = { group_id: group, user_id: botId, card: cards.get(group) ?? "", role: "member" };
      return confirmed(adapter === "onebot" ? member : { member });
    }
    if (action === setCard) {
      cards.set(group, String(params.card));
      return confirmed();
    }
    if (action.startsWith("send_")) {
      return confirmed(adapter === "onebot" ? { message_id: 100 + frames.length } : { message_seq: 100 + frames.length });
    }
    return rejected;
  };
  return {
    desired, frames, cards, setCard, receive,
    setOverride(handler: typeof override) { override = handler; },
    writes() { return frames.filter(({ action }) => action === setCard).map(({ params }) => params); },
  };
}

function milkyServer(receive: Receive) {
  return Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (request.method !== "POST" || request.headers.get("Authorization") !== `Bearer ${token}`) {
        return new Response(null, { status: 401 });
      }
      const action = new URL(request.url).pathname.slice("/api/".length);
      const params = await request.json() as Rpc["params"];
      return Response.json(await receive({ action, params }));
    },
  });
}

async function until<T>(get: () => T | undefined, error: string, timeout = 3_000): Promise<T> {
  const stop = performance.now() + timeout;
  for (;;) {
    const result = get();
    if (result !== undefined) return result;
    if (performance.now() >= stop) throw new Error(error);
    await Bun.sleep(15);
  }
}

async function startup(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    while (!output.includes("Lotus-Yunzai 已启动")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("群名片夹具宿主未启动。\n" + output);
      output += decoder.decode(chunk.value, { stream: true });
    }
    const http = /HTTP 正在监听 (http:\/\/127\.0\.0\.1:\d+)\/status/u.exec(output)?.[1];
    const ws = /OneBot 11 正在监听 (ws:\/\/127\.0\.0\.1:\d+\/OneBotv11)/u.exec(output)?.[1];
    if (!http || !ws) throw new Error("群名片夹具宿主未输出监听地址。");
    return { endpoint: new URL("/milky", http), ws };
  } finally {
    reader.releaseLock();
  }
}

async function withHost({ receive, cron, run }: {
  receive: Receive;
  cron: string;
  run(fixture: Awaited<ReturnType<typeof setupEvents>> & { config: string }): Promise<void>;
}) {
  const root = await mkdtemp(join(tmpdir(), "lotus-auto-group-card-"));
  const sockets: WebSocket[] = [];
  const milky = milkyServer(receive);
  try {
    await copyHost(root);
    await cp(new URL("../plugins/group/", import.meta.url), join(root, "plugins/group"), {
      recursive: true, filter: (path) => !path.endsWith("/.git"),
    });
    await mkdir(join(root, "config/config"), { recursive: true });
    const config = join(root, "config/config/auto-group-card.yaml");
    await writeFile(config, `cron: "${cron}"\nnotGroup: ["77"]\nsuffixes: ["${suffix}"]\n`);
    await writeFile(join(root, "config/config/other.yaml"), `master: ["${botId}:${owner}"]\n`);
    await writeFile(join(root, "config/milky.yaml"), [
      "enable: true", "host: 127.0.0.1", `port: ${milky.port}`, "connection: webhook", `access_token: ${token}`, "",
    ].join("\n"));
    disableMemberPrewarm(root);
    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_HTTP_PORT: "0", LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: token },
    });
    const stderr = new Response(host.stderr).text();
    try {
      const endpoints = await startup(host.stdout);
      await run({ ...await setupEvents(endpoints, sockets), config });
    } finally {
      host.kill();
      for (const socket of sockets) socket.close();
      await host.exited;
    }
    expect(await stderr).not.toMatch(/处理.*失败|初始化.*失败/u);
  } finally {
    await milky.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}

async function setupEvents({ endpoint, ws }: Awaited<ReturnType<typeof startup>>, sockets: WebSocket[]) {
  let sequence = 0;
  async function webhook(event_type: string, data: object) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ self_id: botId, time: Math.floor(Date.now() / 1_000), event_type, data }),
      signal: AbortSignal.timeout(1_000),
    });
    return response.status;
  }
  function milkyCommand(userId = owner) {
    return webhook("message_receive", {
      message_scene: "friend", peer_id: userId, sender_id: userId, message_seq: ++sequence,
      segments: [{ type: "text", data: { text: command } }],
    });
  }
  async function waitMilky() {
    for (let attempts = 0; attempts < 60; attempts++) {
      const status = await webhook("fixture_unsupported", {});
      if (status !== 503) {
        expect(status).toBe(200);
        return;
      }
      await Bun.sleep(25);
    }
    throw new Error("Milky 群名片测试账号未绑定。");
  }
  async function connectOneBot(receive: Receive) {
    const BunWs = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
    const socket = new BunWs(ws, { headers: {
      Authorization: `Bearer ${token}`, "X-Client-Role": "Universal", "X-Self-ID": String(botId),
    } });
    sockets.push(socket);
    socket.addEventListener("message", async ({ data }) => {
      const rpc = JSON.parse(data) as Rpc;
      const response = await receive(rpc);
      if (rpc.echo && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ ...response, echo: rpc.echo }));
    });
    await until(() => socket.readyState === WebSocket.OPEN ? true : undefined, "OneBot 群名片夹具连接超时。");
    return {
      command(userId = owner) {
        socket.send(JSON.stringify({
          post_type: "message", message_type: "private", sub_type: "friend", self_id: botId, user_id: userId,
          message_id: ++sequence, message: command,
        }));
      },
    };
  }
  return { milkyCommand, waitMilky, connectOneBot };
}

function privateReply(frames: Rpc[], first: number, userId = owner) {
  return until(() => frames.slice(first).find(({ action, params }) =>
    (action === "send_msg" || action === "send_private_message") && params.user_id === userId), "未收到原会话群名片回执。");
}

test("真实宿主仅让主人手动更新当前协议的机器人，严格核对群身份并区分回执", async () => {
  const milky = cardGateway("milky", [77, 78, 79, 80, 81]);
  milky.cards.set(78, milky.desired);
  milky.setOverride(({ action, params }) => {
    if (action === "get_group_member_info" && params.group_id === 79) {
      return confirmed({ member: { group_id: 80, user_id: botId, card: "" } });
    }
    if (action === milky.setCard && params.group_id === 80) return unknown;
  });
  const onebot = cardGateway("onebot", [77, 83, 84, 85]);
  onebot.cards.set(83, onebot.desired);
  onebot.setOverride(({ action, params }) => {
    if (action === "get_group_member_info" && params.group_id === 84) {
      return confirmed({ group_id: 84, user_id: botId + 1, card: "" });
    }
  });
  await withHost({ receive: milky.receive, cron: "0 0 0 1 1 *", async run({ waitMilky, milkyCommand, connectOneBot, config }) {
    const one = await connectOneBot(onebot.receive);
    await waitMilky();
    expect(await milkyCommand(owner + 1)).toBe(200);
    expect((await privateReply(milky.frames, 0, owner + 1)).params.message).toEqual([{ type: "text", data: {
      text: "❎ 该命令仅限主人可用",
    } }]);
    expect(milky.frames.map(({ action }) => action)).toEqual(["get_login_info", "send_private_message"]);
    const initialMilky = milky.frames.length;
    expect(await milkyCommand()).toBe(200);
    expect((await privateReply(milky.frames, initialMilky)).params.message).toEqual([{ type: "text", data: {
      text: "群名片更新完成：成功 1 个，未变 1 个，失败 1 个，未确认 1 个。",
    } }]);
    expect(milky.writes()).toEqual([80, 81].map((group_id) => ({ group_id, user_id: botId, card: milky.desired })));
    expect(milky.frames.filter(({ action }) => action === "get_group_member_info").map(({ params }) => params))
      .toEqual([78, 79, 80, 81].map((group_id) => ({ group_id, user_id: botId, no_cache: true })));
    expect(onebot.frames).toEqual([]);

    one.command(owner + 1);
    expect((await privateReply(onebot.frames, 0, owner + 1)).params.message).toBe("❎ 该命令仅限主人可用");
    expect(onebot.frames.every(({ action }) => action === "send_msg")).toBe(true);
    const start = onebot.frames.length;
    one.command();
    expect((await privateReply(onebot.frames, start)).params.message).toBe("群名片更新完成：成功 1 个，未变 1 个，失败 1 个，未确认 0 个。");
    expect(onebot.frames.map(({ action }) => action)).toEqual([
      "send_msg", "get_group_list", "get_login_info", "get_group_member_info", "get_group_member_info", "get_group_member_info",
      onebot.setCard, "send_msg",
    ]);
    expect(onebot.writes()).toEqual([{ group_id: 85, user_id: botId, card: onebot.desired }]);

    await writeFile(config, "enable: false\n");
    const disabled = onebot.frames.length;
    one.command();
    expect((await privateReply(onebot.frames, disabled)).params.message).toBe("自动群名片功能未启用。");
    expect(onebot.frames.slice(disabled).map(({ action }) => action)).toEqual(["send_msg"]);
  } });
}, 10_000);

test("真实宿主定时同号优先 OneBot，换连接时旧的群名片批次停写", async () => {
  const milky = cardGateway("milky", [78]);
  const onebot = cardGateway("onebot", [77, 78, 79, 80]);
  const replacement = cardGateway("onebot", [78]);
  const finishRead = Promise.withResolvers<GatewayResult>();
  onebot.setOverride(({ action, params }) => {
    if (action === "get_group_member_info" && params.group_id === 79) return finishRead.promise;
  });
  const second = new Date(Date.now() + 4_000).getSeconds();
  await withHost({ receive: milky.receive, cron: `${second} * * * * *`, async run({ waitMilky, connectOneBot, config }) {
    await connectOneBot(onebot.receive);
    await waitMilky();
    expect(onebot.frames).toEqual([]);
    expect(milky.frames.map(({ action }) => action)).toEqual(["get_login_info"]);
    await until(() => onebot.frames.find(({ action, params }) => action === "get_group_member_info" && params.group_id === 79),
      "定时群名片未查询 OneBot。", 5_000);
    await writeFile(config, "enable: false\n");
    try {
      const next = await connectOneBot(replacement.receive);
      next.command(owner + 1);
      await privateReply(replacement.frames, 0, owner + 1);
    } finally {
      finishRead.resolve(confirmed({ group_id: 79, user_id: botId, card: "" }));
    }
    await Bun.sleep(160);
    expect(onebot.frames.map(({ action }) => action)).toEqual([
      "get_group_list", "get_login_info", "get_group_member_info", onebot.setCard, "get_group_member_info",
    ]);
    expect(onebot.writes()).toEqual([{ group_id: 78, user_id: botId, card: onebot.desired }]);
    expect(replacement.writes()).toEqual([]);
    expect(milky.frames.map(({ action }) => action)).toEqual(["get_login_info"]);
  } });
}, 10_000);
