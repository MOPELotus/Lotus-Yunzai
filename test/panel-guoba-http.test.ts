import { expect, test } from "bun:test";
import { dispatchGuobaApi, validGuobaApiRoute, type GuobaApiDefinition } from "../lib/panel-guoba-http.ts";

test("锅巴接口处理路径参数、重复查询、JSON 和异步中间件", async () => {
  const order: string[] = [];
  const routes: GuobaApiDefinition[] = [{
    method: "post",
    route: "/rules/:file/",
    handlers: [
      async (_request, response, next) => {
        await Promise.resolve();
        order.push("middleware");
        expect(response.headersSent).toBe(false);
        next();
        next();
      },
      async ({ method, params, query, body }, response) => {
        await Promise.resolve();
        order.push("handler");
        expect(Object.getPrototypeOf(params)).toBeNull();
        expect(Object.getPrototypeOf(query)).toBeNull();
        response.status(201).json({ method, params, query, body });
        expect(response.headersSent).toBe(true);
      },
    ],
  }];
  const request = new Request("https://lotus.test/sandbox?tag=one&tag=two&mode=read", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ enabled: true }),
  });
  const response = await dispatchGuobaApi(request, "/rules/%E5%8F%A3%E5%BE%84", routes);
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({
    method: "POST", params: { file: "口径" }, query: { tag: ["one", "two"], mode: "read" },
    body: { enabled: true },
  });
  expect(order).toEqual(["middleware", "handler"]);
});

test("锅巴接口按注册顺序与请求方法派发并保持安全响应类型", async () => {
  const routes: GuobaApiDefinition[] = [
    { method: "GET", route: "/rules/:id", handlers: [(_request, _response, next) => next("route")] },
    { method: "get", route: "/rules/list", handlers: [(_request, response) => response.send("<b>list</b>")] },
    { method: "put", route: "/rules/list", handlers: [(_request, response) => response.status(204).end()] },
    { method: "all", route: "/rules/all", handlers: [(request, response) => response.json(request.method)] },
  ];
  const origin = "https://lotus.test/sandbox";
  const response = await dispatchGuobaApi(new Request(origin), "/rules/list", routes);
  expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
  expect(await response.text()).toBe("<b>list</b>");

  const head = await dispatchGuobaApi(new Request(origin, { method: "HEAD" }), "/rules/list", routes);
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
  const mismatch = await dispatchGuobaApi(new Request(origin, { method: "PATCH" }), "/rules/list", routes);
  expect(mismatch.status).toBe(405);
  expect(mismatch.headers.get("Allow")).toBe("GET, HEAD, PUT");
  const put = await dispatchGuobaApi(new Request(origin, { method: "PUT" }), "/rules/list", routes);
  expect(put.status).toBe(204);
  const all = await dispatchGuobaApi(new Request(origin, { method: "DELETE" }), "/rules/all", routes);
  expect(await all.json()).toBe("DELETE");
  expect((await dispatchGuobaApi(new Request(origin), "/missing", routes)).status).toBe(404);
});

test("锅巴接口拒绝歧义路径、超限请求与内部错误详情", async () => {
  let invoked = 0;
  const routes: GuobaApiDefinition[] = [
    { method: "GET", route: "/:id/:id", handlers: [() => { invoked++; }] },
    { method: "POST", route: "/parse", handlers: [() => { invoked++; }] },
    { method: "GET", route: "/private/:id", handlers: [() => { throw new Error("fixture-private"); }] },
    { method: "GET", route: "/next", handlers: [(_req, _res, next) => next(new Error("fixture-private"))] },
    { method: "GET", route: "/down", handlers: [(_req, res) => res.status(503).json({ error: "fixture-private" })] },
  ];
  expect(["/:id/:id", "/foo/*rest", "/foo/:id?", "/foo/../bar", "/foo//bar", "/foo%22"]
    .every((route) => !validGuobaApiRoute(route))).toBe(true);
  expect(validGuobaApiRoute("/")).toBe(true);
  const origin = "https://lotus.test/sandbox";
  const head = await dispatchGuobaApi(new Request(origin, { method: "HEAD" }), "/private/key", routes);
  expect(head.status).toBe(500);
  expect(await head.text()).toBe("");
  expect((await dispatchGuobaApi(new Request(origin), "/private/key%2Fother", routes)).status).toBe(400);
  expect((await dispatchGuobaApi(new Request(origin), "/private/%zz", routes)).status).toBe(400);
  expect((await dispatchGuobaApi(new Request(origin), "/foo/bar", routes)).status).toBe(404);

  for (const body of ["{", JSON.stringify("a".repeat(65_535))]) {
    const request = new Request(origin, { method: "POST", body, headers: { "Content-Type": "application/json" } });
    expect((await dispatchGuobaApi(request, "/parse", routes)).status).toBe(400);
  }
  expect(invoked).toBe(0);
  for (const path of ["/private/key", "/next", "/down"]) {
    const response = await dispatchGuobaApi(new Request(origin), path, routes);
    expect(response.status).toBe(path === "/down" ? 503 : 500);
    expect(await response.json()).toEqual({ ok: false, error: "扩展接口处理失败。" });
  }
});

test("锅巴接口可读有限请求头，保留 opaque 来源及宿主响应策略", async () => {
  const routes: GuobaApiDefinition[] = [{
    method: "post",
    route: "/headers",
    handlers: [(req, res) => {
      expect(Object.isFrozen(req.headers)).toBe(true);
      expect(Object.getPrototypeOf(req.headers)).toBeNull();
      expect(req.headers).toEqual({
        "content-type": "application/json", host: "lotus.test", origin: "null", "sec-fetch-site": "cross-site",
      });
      expect(req.get("OrIgIn")).toBe("null");
      expect(req.get("Content-Type")).toBe("application/json");
      for (const name of ["Authorization", "Cookie", "X-Lotus-Panel-Session", "Guoba-Access-Token",
        "X-Forwarded-Host", "X-Unrelated", "constructor"]) expect(req.get(name)).toBeUndefined();
      expect(res.setHeader("CACHE-CONTROL", "no-store")).toBe(res);
      for (const [name, value] of Object.entries({
        "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Credentials": "true", "Cache-Control": "public",
        "Content-Type": "text/html", "Content-Security-Policy": "default-src *", "X-Content-Type-Options": "detect",
        "Set-Cookie": "owned=yes", "WWW-Authenticate": "Basic", "Location": "https://other.test",
      })) res.setHeader(name, value);
      res.send("<script>fixture</script>");
    }],
  }];
  const request = new Request("https://lotus.test/example", {
    method: "POST", body: "{}",
    headers: {
      "Content-Type": "application/json", Host: "lotus.test", Origin: "null", "Sec-Fetch-Site": "cross-site",
      Authorization: "Bearer host-fixture", Cookie: "lotus_panel=private", "X-Lotus-Panel-Session": "1",
      "Guoba-Access-Token": "page-fixture", "X-Forwarded-Host": "proxy.test", "X-Unrelated": "other",
    },
  });
  const response = await dispatchGuobaApi(request, "/headers", routes);
  expect([...response.headers]).toEqual([["cache-control", "no-store"], ["content-type", "text/plain; charset=utf-8"]]);
  expect(await response.text()).toBe("<script>fixture</script>");
});
