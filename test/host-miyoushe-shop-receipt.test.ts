import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { copyHost } from "./host-fixture.ts";

test("商城终态只私发到原协议和机器人，即使另一协议也绑定相同 QQ 号", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-shop-receipt-host-"));
  const profiles = join(root, "profiles");
  const file = join(root, "data", "coinShop", "plans.json");
  const onebotToken = "shop-receipt-onebot-fixture";
  const milkyToken = "shop-receipt-milky-fixture";
  const onebot = Promise.withResolvers<unknown>();
  const milky = Promise.withResolvers<unknown>();
  const onebotSends: string[] = [];
  const milkySends: string[] = [];
  const gateway = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.headers.get("Authorization") !== `Bearer ${milkyToken}`) return new Response(null, { status: 401 });
    const payload: unknown = await request.json();
    const path = new URL(request.url).pathname;
    const ok = (data: object) => Response.json({ status: "ok", retcode: 0, data });
    if (path === "/api/get_login_info") return ok({ uin: 99, nickname: "Milky 夹具" });
    if (path === "/api/get_friend_list") return ok({ friends: [{ user_id: 42 }] });
    if (path === "/api/send_private_message") {
      milkySends.push(JSON.stringify(payload));
      milky.resolve(payload);
      return ok({ message_seq: 53, time: Math.floor(Date.now() / 1000) });
    }
    return new Response(null, { status: 404 });
  } });
  const spawn = () => Bun.spawn([process.execPath, "--no-env-file", "app.ts"], {
    cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: { PATH: process.env.PATH, LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: onebotToken,
      LOTUS_HTTP_PORT: "0", LOTUS_PROFILE_DIR: profiles },
  });
  let host: ReturnType<typeof spawn> | undefined;
  let socket: WebSocket | undefined;
  try {
    await copyHost(root);
    for (const path of [profiles, dirname(file), join(root, "config")]) await mkdir(path, { recursive: true });
    await writeFile(join(root, "config", "global.yaml"), "scheduler: {enable: false}\n");
    await writeFile(join(root, "config", "milky.yaml"), Bun.YAML.stringify({ enable: true, host: "127.0.0.1", port: gateway.port,
      connection: "webhook", access_token: milkyToken, webhook: { path: "/gateway" } }));
    await writeFile(join(profiles, "42.yaml"), Bun.YAML.stringify({
      user: { qq: "42" }, profile: { id: 1 }, account: { stuid: "27", ltuid: "27", stoken: "fixture", cookie: "account_id=27;cookie_token=fixture" },
    }));
    const now = Date.now();
    const plan = { qq: "42", profileId: 1, accountId: "27", goodsId: "44", gameBiz: "hk4e_cn", type: 2, price: 20,
      role: null, addressId: "", addressLabel: "", immediate: true, createdAt: now, opensAt: now, finishedAt: now,
      attempts: 1, status: "succeeded", message: "兑换成功，请查看米游社兑换记录或游戏内邮件。", receipt: "pending" };
    await writeFile(file, JSON.stringify({ version: 2, trackers: [], plans: [
      { ...plan, id: "abcdef000001", botId: "99", goodsName: "一号合成商品", receiptRoute: "onebot:99" },
      { ...plan, id: "abcdef000002", botId: "99", goodsName: "二号合成商品", receiptRoute: "milky:99" },
      { ...plan, id: "abcdef000003", botId: "88", goodsName: "三号合成商品", receiptRoute: "onebot:88" },
    ] }));
    host = spawn();
    const reader = host.stdout.getReader();
    const decoder = new TextDecoder();
    let endpoint: string | undefined, output = "";
    try {
      while (!endpoint) {
        const part = await reader.read();
        if (part.done) throw new Error(output + await new Response(host.stderr).text());
        output += decoder.decode(part.value, { stream: true });
        endpoint = /ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/u.exec(output)?.[0];
      }
    } finally { reader.releaseLock(); }
    const Socket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
    const liveSocket = socket = new Socket(endpoint, { headers: {
      Authorization: `Bearer ${onebotToken}`, "X-Client-Role": "Universal", "X-Self-ID": "99",
    } });
    liveSocket.addEventListener("message", ({ data }) => {
      const frame = JSON.parse(data);
      if (frame.action === "get_friend_list") {
        liveSocket.send(JSON.stringify({ echo: frame.echo, status: "ok", retcode: 0, data: [{ user_id: 42 }] }));
      }
      if (frame.action === "send_msg") {
        onebotSends.push(JSON.stringify(frame.params));
        onebot.resolve(frame.params);
        liveSocket.send(JSON.stringify({ echo: frame.echo, status: "ok", retcode: 0, data: {} }));
      }
    });
    const deadline = new Promise<never>((_, reject) => AbortSignal.timeout(18_000).addEventListener("abort", () =>
      reject(new Error(`隔离宿主未发齐回执，OneBot ${onebotSends.length} 条，Milky ${milkySends.length} 条。`)), { once: true }));
    const [onebotReply, milkyReply] = await Promise.race([Promise.all([onebot.promise, milky.promise]), deadline]);
    expect(onebotReply).toMatchObject({ user_id: 42, message_type: "private" });
    expect(milkyReply).toMatchObject({ user_id: 42 });
    expect(onebotSends).toHaveLength(1);
    expect(milkySends).toHaveLength(1);
    expect(onebotSends[0]).toContain("一号合成商品");
    expect(milkySends[0]).toContain("二号合成商品");
    const stored = JSON.parse(await readFile(file, "utf8"));
    expect(stored.plans.map((row: { receipt: string }) => row.receipt)).toEqual(["claimed", "claimed", "pending"]);
  } finally {
    socket?.close();
    host?.kill();
    await host?.exited;
    gateway.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 22_000);
