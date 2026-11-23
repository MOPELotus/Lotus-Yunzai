import { describe, expect, test } from "bun:test";
import { createPanelTransferReceiver, createPanelTransferSource, maxPanelTransferBytes, panelTransferLifetime,
  panelTransferOrigin, panelTransferPath } from "../lib/panel-transfer.ts";

const origin = "https://source.example.invalid:1443";
const owner = { game: "gs", qq: "730521", uid: "123450001" } as const;
const data = Buffer.from(JSON.stringify({ uid: owner.uid, avatars: { "10000046": { title: "合成测试", level: 90 } } }));

function fixture(options: { readonly now?: () => number } = {}) {
  const controller = new AbortController();
  const source = createPanelTransferSource({ publicOrigin: origin, signal: controller.signal, now: options.now });
  const requests: Request[] = [];
  const ciphertext: Buffer[] = [];
  const transport = async (url: URL, init: RequestInit) => {
    expect(url.href).toBe(origin + panelTransferPath);
    expect(init.credentials).toBe("omit");
    expect(init.redirect).toBe("error");
    const request = new Request(url, init);
    requests.push(request);
    const response = source.serve(request)!;
    expect(response.headers.get("cache-control")).toBe("no-store");
    if (response.status === 200) ciphertext.push(Buffer.from(await response.clone().arrayBuffer()));
    return response;
  };
  const receive = createPanelTransferReceiver({ peers: [origin], transport, now: options.now });
  return { controller, source, ciphertext, requests, receive, transport };
}

describe("跨 Bot 面板传输", () => {
  test("只领取密文，失去回执时可重试，提交后回执幂等且不再发出面板", async () => {
    const { controller, source, ciphertext, requests, receive } = fixture();
    const signal = controller.signal;
    const code = source.offer(owner, data)!;
    const first = await receive(code, owner, signal);
    const retry = await receive(code, owner, signal);
    expect(first.state).toBe("ready");
    if (first.state !== "ready" || retry.state !== "ready") throw new Error("面板无法领取。");
    expect(first.bytes).toEqual(data);
    expect(retry.bytes).toEqual(data);
    expect(ciphertext[0]).toEqual(ciphertext[1]);
    expect(ciphertext[0]!.includes(data)).toBe(false);
    expect(ciphertext[0]!.includes(owner.uid)).toBe(false);
    expect(await first.acknowledge(signal)).toBe(true);
    expect(await retry.acknowledge(signal)).toBe(true);
    expect(await receive(code, owner, signal)).toEqual({ state: "confirmed" });
    for (const request of requests) {
      const wire = request.url + JSON.stringify([...request.headers]);
      expect(request.body).toBeNull();
      expect(wire.includes(owner.qq)).toBe(false);
      expect(wire.includes(owner.uid)).toBe(false);
      expect(wire.includes(code.split(".")[3]!)).toBe(false);
    }
    controller.abort();
    expect(source.offer(owner, data)).toBeUndefined();
  });

  test("绑定游戏、QQ 和所选 UID，仅接受明确列出的 HTTPS 来源", async () => {
    const { controller, source, requests, receive } = fixture();
    const code = source.offer(owner, data)!;
    const wrong = [{ ...owner, game: "sr" as const }, { ...owner, qq: "730522" }, { ...owner, uid: "123450002" }];
    for (const user of wrong) expect(await receive(code, user, controller.signal)).toEqual({ state: "expired" });
    expect(requests).toHaveLength(3);
    for (const peer of ["http://source.example.invalid:1443", "https://source.example.invalid", "https://source.example.invalid.evil.test:1443"]) {
      const receive = createPanelTransferReceiver({ peers: [peer], transport: async () => { throw new Error("不得请求陌生网址"); } });
      expect(await receive(code, owner, controller.signal)).toEqual({ state: "invalid" });
    }
    expect(panelTransferOrigin("https://trusted.invalid:1443/")).toBe("https://trusted.invalid:1443");
    for (const address of ["http://trusted.invalid", "https://trusted.invalid/path", "https://trusted.invalid/?qid=1",
      "https://user:secret@trusted.invalid", "https://trusted.invalid/#id", "https://evil.invalid\\@trusted.invalid"]) {
      expect(panelTransferOrigin(address)).toBeUndefined();
    }
    expect((await receive(code, owner, controller.signal)).state).toBe("ready");
    controller.abort();
  });

  test("拒绝过期、篡改、重定向、错误方式和超过尺寸的传输", async () => {
    let now = 1_888_888_000_000;
    const { controller, source, receive, transport } = fixture({ now: () => now });
    const code = source.offer(owner, data)!;
    expect(source.offer(owner, new Uint8Array())).toBeUndefined();
    expect(source.offer(owner, new Uint8Array(maxPanelTransferBytes + 1))).toBeUndefined();
    expect(source.serve(new Request(origin + panelTransferPath))?.status).toBe(405);
    expect(source.serve(new Request(origin + panelTransferPath + "?code=secret", { method: "POST" }))?.status).toBe(400);
    expect(source.serve(new Request(origin + panelTransferPath, { method: "POST", body: "unexpected" }))?.status).toBe(400);
    expect(source.serve(new Request(origin + "/status"))).toBeUndefined();
    const corrupt = createPanelTransferReceiver({ peers: [origin], now: () => now, async transport(url, init) {
      const response = await transport(url, init);
      const bytes = Buffer.from(await response.arrayBuffer());
      bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
      return new Response(bytes, { headers: response.headers });
    } });
    expect(await corrupt(code, owner, controller.signal)).toEqual({ state: "invalid" });
    const oversized = createPanelTransferReceiver({ peers: [origin], now: () => now, async transport() {
      return new Response(new Uint8Array(maxPanelTransferBytes + 200), { headers: { "Content-Type": "application/octet-stream" } });
    } });
    expect(await oversized(code, owner, controller.signal)).toEqual({ state: "invalid" });
    const redirect = createPanelTransferReceiver({ peers: [origin], async transport() {
      return Response.redirect("https://example.test/panel", 302);
    } });
    expect(await redirect(code, owner, controller.signal)).toEqual({ state: "unavailable" });
    now += panelTransferLifetime;
    expect(await receive(code, owner, controller.signal)).toEqual({ state: "expired" });
    controller.abort();
  });

  test("确认丢失时保留可领取的原始密文，宿主退出立即清除", async () => {
    const { source, controller, transport } = fixture();
    const code = source.offer(owner, data)!;
    const receive = createPanelTransferReceiver({ peers: [origin], async transport(url, init) {
      if (new Headers(init.headers).get("X-Lotus-Panel-Operation") === "ack") throw new Error("接收端断线");
      return transport(url, init);
    } });
    const result = await receive(code, owner, controller.signal);
    if (result.state !== "ready") throw new Error("面板无法领取。");
    expect(await result.acknowledge(controller.signal)).toBe(false);
    expect((await receive(code, owner, controller.signal)).state).toBe("ready");
    controller.abort();
    expect(source.serve(new Request(origin + panelTransferPath, { method: "POST" }))?.status).toBe(404);
  });
});
