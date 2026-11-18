import { expect, test } from "bun:test";
import { HandlerScope } from "../lib/plugins/handler.ts";
import { LegacyHttpRoutes } from "../lib/plugins/legacy-http.ts";

const auth = new Headers({ Authorization: "Bearer legacy-webhook-fixture" });
const jsonHeaders = { Authorization: "Bearer legacy-webhook-fixture", "Content-Type": "application/json; charset=utf-8" };

function post(path: string, body: BodyInit | null = '{"event":"test"}', headers: HeadersInit = jsonHeaders, signal?: AbortSignal) {
  return new Request(`http://127.0.0.1${path}`, { method: "POST", body, headers, signal });
}

test("旧插件 POST 暂存作用域，发布后兼容大小写和尾斜杠", async () => {
  const registry = new LegacyHttpRoutes();
  const owner = new HandlerScope();
  let received: unknown;
  let callbackOwner: HandlerScope | undefined;
  expect(() => registry.express.post("/Milky/v1", () => {})).toThrow("初始化");
  registry.open(owner);
  owner.run(() => registry.express.post("/Milky/v1", (request, response) => {
    received = request.body;
    callbackOwner = HandlerScope.current();
    response.sendStatus(201);
    response.sendStatus(500);
  }));
  registry.seal(owner);
  expect(() => owner.run(() => registry.express.post("/late", () => {}))).toThrow("初始化");
  const prepared = registry.prepare([owner], new Set());
  expect(await registry.handle(post("/milky/v1"), auth)).toBeUndefined();
  prepared.publish();
  const response = await registry.handle(post("/MILKY/v1/?fallback=value"), auth);
  expect(response?.status).toBe(201);
  expect(await response?.text()).toBe("Created");
  expect(response?.headers.get("Cache-Control")).toBe("no-store");
  expect(received).toEqual({ event: "test" });
  expect(callbackOwner).toBe(owner);
  expect(await registry.handle(new Request("http://127.0.0.1/milky/v1"), auth)).toBeUndefined();
  expect(await registry.handle(post("/milky/v1", "{}", { ...jsonHeaders, Upgrade: "websocket" }), auth)).toBeUndefined();
  expect(await registry.handle(post("/milky/v1//"), auth)).toBeUndefined();
  expect(() => owner.run(() => registry.express.post("/after-start", () => {}))).toThrow("初始化");
  registry.discard(owner);
  prepared.publish();
  expect(await registry.handle(post("/milky/v1"), auth)).toBeUndefined();
});

test("固定路径拒绝保留段、歧义及跨作用域冲突", async () => {
  const registry = new LegacyHttpRoutes();
  const active = new HandlerScope();
  const first = new HandlerScope();
  const second = new HandlerScope();
  [active, first, second].forEach((owner) => registry.open(owner));

  first.run(() => {
    for (const path of ["/status", "/PaNeL/x", "/File/abc", "/OneBotv11/", "/exit", "/st%61tus", "/../route", "/*", "/:arg", "/a?b", "/a//b", "//host/route", "/a\\b"]) {
      expect(() => registry.express.post(path, () => {})).toThrow("固定路径");
    }
    registry.express.post("/webhook", (_req, res) => res.sendStatus(202));
    expect(() => registry.express.post("/Webhook/", () => {})).toThrow("重复注册");
  });
  active.run(() => registry.express.post("/webhook", (_req, res) => res.sendStatus(201)));
  second.run(() => registry.express.post("/webhook", (_req, res) => res.sendStatus(203)));
  registry.prepare([active], new Set()).publish();
  expect(() => registry.prepare([first], new Set())).toThrow("重复注册");
  expect(() => registry.prepare([first, second], new Set([active]))).toThrow("重复注册");
  expect((await registry.handle(post("/webhook"), auth))?.status).toBe(201);
  registry.prepare([first], new Set([active])).publish();
  registry.discard(active);
  expect((await registry.handle(post("/webhook"), auth))?.status).toBe(202);
});

test("先鉴权，再按类型和实际流字节限制读取 JSON", async () => {
  const registry = new LegacyHttpRoutes();
  const owner = new HandlerScope();
  let handled = 0;
  registry.open(owner);
  owner.run(() => registry.express.post("/webhook", (_req, res) => { handled++; res.sendStatus(204); }));
  registry.prepare([owner], new Set()).publish();

  const anonymous = post("/webhook?Authorization=Bearer+legacy-webhook-fixture", "{", { "Content-Type": "application/json" });
  expect((await registry.handle(anonymous, auth))?.status).toBe(401);
  expect(anonymous.bodyUsed).toBe(false);
  expect((await registry.handle(post("/webhook", "{}", auth), auth))?.status).toBe(415);
  expect((await registry.handle(post("/webhook", null), auth))?.status).toBe(400);
  expect((await registry.handle(post("/webhook", "{"), auth))?.status).toBe(400);
  expect((await registry.handle(post("/webhook", new Uint8Array([0x22, 0xff, 0x22])), auth))?.status).toBe(400);
  const declaredOversize = post("/webhook", "{}", { ...jsonHeaders, "Content-Length": "102401" });
  expect((await registry.handle(declaredOversize, auth))?.status).toBe(413);
  expect(declaredOversize.bodyUsed).toBe(false);
  const oversize = new ReadableStream<Uint8Array>({ start(stream) { stream.enqueue(new Uint8Array(102_401)); stream.close(); } });
  expect((await registry.handle(post("/webhook", oversize), auth))?.status).toBe(413);
  expect(handled).toBe(0);
  const largestJson = `{"data":"${"x".repeat(102_389)}"}`;
  expect(largestJson.length).toBe(102_400);
  const noContent = await registry.handle(post("/webhook", largestJson), auth);
  expect(noContent?.status).toBe(204);
  expect(await noContent?.text()).toBe("");
  expect(handled).toBe(1);
});

test("取消上传和停止接收均阻止派发，插件错误只返回通用状态", async () => {
  const registry = new LegacyHttpRoutes();
  const owner = new HandlerScope();
  let handled = 0;
  registry.open(owner);
  owner.run(() => registry.express.post("/webhook", () => { handled++; throw new Error("fixture-secret"); }));
  registry.prepare([owner], new Set()).publish();

  const cancelledSource = Promise.withResolvers<void>();
  const controller = new AbortController();
  const cancelled = new ReadableStream<Uint8Array>({ cancel() { cancelledSource.resolve(); } });
  const interrupted = registry.handle(post("/webhook", cancelled, jsonHeaders, controller.signal), auth);
  controller.abort();
  expect((await interrupted)?.status).toBe(400);
  await cancelledSource.promise;

  let accepting = true;
  let upload!: ReadableStreamDefaultController<Uint8Array>;
  const uploadBody = new ReadableStream<Uint8Array>({ start(stream) { upload = stream; } });
  const pending = registry.handle(post("/webhook", uploadBody), auth, () => accepting);
  accepting = false;
  upload.enqueue(new TextEncoder().encode("{}"));
  upload.close();
  expect((await pending)?.status).toBe(503);
  expect(handled).toBe(0);

  const failure = await registry.handle(post("/webhook"), auth);
  expect(failure?.status).toBe(500);
  expect(await failure?.text()).toBe("");
  expect(handled).toBe(1);
});

test("上传期间发生替换时，旧请求不会交给任一代处理函数", async () => {
  const registry = new LegacyHttpRoutes();
  const old = new HandlerScope();
  const candidate = new HandlerScope();
  const called: string[] = [];
  registry.open(old);
  old.run(() => registry.express.post("/webhook", (_req, res) => { called.push("old"); res.sendStatus(201); }));
  registry.prepare([old], new Set()).publish();

  let upload!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(stream) { upload = stream; } });
  const request = registry.handle(post("/webhook", body), auth);
  registry.open(candidate);
  candidate.run(() => registry.express.post("/webhook", (_req, res) => { called.push("new"); res.sendStatus(202); }));
  registry.prepare([candidate], new Set([old])).publish();
  registry.discard(old);
  upload.enqueue(new TextEncoder().encode("{}"));
  upload.close();

  expect((await request)?.status).toBe(503);
  expect(called).toEqual([]);
  expect((await registry.handle(post("/webhook"), auth))?.status).toBe(202);
  expect(called).toEqual(["new"]);
});
