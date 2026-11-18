import { expect, test } from "bun:test";
import { createServerRedirect, readServerRedirect } from "../lib/server-redirect.ts";

const origin = "http://127.0.0.1:2536";

test("只在本机配置提供有效目标时启用 HTTP 跳转，支持静态查询参数和片段", () => {
  for (const value of [undefined, null, false, "", "  ", "\r\n\t"]) {
    expect(readServerRedirect(value)).toBeUndefined();
  }
  expect(readServerRedirect(" https://Example.invalid:443/docs?mode=fast#tips "))
    .toBe("https://example.invalid/docs?mode=fast#tips");
  expect(readServerRedirect("http://[::1]:8080/docs")).toBe("http://[::1]:8080/docs");
  expect(readServerRedirect("/文档/start?next=%2Fpanel%2F#begin")).toBe("/%E6%96%87%E6%A1%A3/start?next=%2Fpanel%2F#begin");
  expect(readServerRedirect("/panel/")).toBe("/panel/");
});

test("拒绝凭据、非 HTTP(S)、相对域、控制字符和浏览器归一化后的网络路径", () => {
  for (const value of [
    true, 0, {}, [],
    "docs", "../index", "//example.invalid/path", "//lotus.invalid/path", "///example.invalid",
    "/%2fexample.invalid", "/path/..//example.invalid", "/%2E//example.invalid", "/path/../%2Fexample.invalid",
    "http:example.invalid", "https:///example.invalid", "file:///etc/passwd", "javascript:alert(1)",
    "https://user:pass@example.invalid", "https://@example.invalid", "https://example.invalid:65536/docs",
    "/\\example.invalid", "https:\\\\example.invalid", "/x%5cfoo", "/%09example.invalid",
    "https://example.invalid\r\nLocation: https://other.invalid", "\nhttps://example.invalid",
    "/x?next=%0da", "https://example.invalid/path with spaces",
  ]) {
    expect(() => readServerRedirect(value)).toThrow("config/server.yaml 的 redirect");
  }
});

test("普通 GET 和 HEAD 返回固定的 302，不反射输入的 Host、查询参数或请求体", async () => {
  const fallback = createServerRedirect("https://example.invalid/docs?configured=yes#guide");
  for (const method of ["GET", "HEAD"]) {
    const request = new Request(origin + "/unknown?requestSecret=fixture", {
      method, headers: { Host: "wrong.invalid", "X-Forwarded-Host": "wrong.invalid" },
    });
    const response = fallback(request)!;
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://example.invalid/docs?configured=yes#guide");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe("");
  }
  expect(createServerRedirect("/panel/")(new Request(origin))?.headers.get("Location")).toBe("/panel/");
});

test("保留命名路由、升级和有副作用的方法，关闭配置时不接管请求", () => {
  const redirect = createServerRedirect("/panel/");
  for (const path of ["/status", "/status/", "/status/detail", "/panel", "/panel/api/missing", "/panel/extensions/missing",
    "/File", "/File/missing", "/OneBotv11", "/OneBotv11/future", "/exit", "/exit/other",
    "/%73tatus", "/%70anel%2fapi%2Fmissing", "/file/missing", "/ONEBOTv11/future", "/%ZZ", "/%E0%A4%A"]) {
    expect(redirect(new Request(origin + path))).toBeUndefined();
  }
  expect(redirect(new Request(origin + "/status-help"))?.status).toBe(302);
  for (const method of ["POST", "DELETE", "OPTIONS"]) {
    expect(redirect(new Request(origin + "/unknown", { method }))).toBeUndefined();
  }
  expect(redirect(new Request(origin + "/unknown", { headers: { Upgrade: "websocket" } }))).toBeUndefined();
  expect(redirect(new Request(origin + "/unknown", { headers: { Upgrade: "something" } }))).toBeUndefined();
  expect(createServerRedirect()(new Request(origin + "/unknown"))).toBeUndefined();
});
