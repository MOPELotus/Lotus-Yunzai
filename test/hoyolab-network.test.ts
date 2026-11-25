import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { hoyoTransportForBot } from "../lib/hoyolab-network.ts";
import { withHoyoReadRetries } from "../packages/hoyo-client/read-retry.ts";

test("旧国际服代理只隧道转发 HoYoLAB 核验和签到域名，失败不直连", async () => {
  const connections: string[] = [];
  const { promise: listening, resolve, reject } = Promise.withResolvers<void>();
  const proxy = createServer(socket => {
    socket.once("data", data => {
      connections.push(data.toString());
      socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });
  }).once("error", reject).listen(0, "127.0.0.1", resolve);
  const local = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("direct") });
  try {
    await listening;
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("代理测试监听地址无效。");
    const transport = hoyoTransportForBot(`http://fixture:proxy-password@127.0.0.1:${address.port}`);
    const official = ["passport-api-sg.hoyolab.com", "passport-api-us.hoyolab.com", "passport-api-eu.hoyolab.com",
      "api-account-os.hoyolab.com", "sg-act-public-api.hoyolab.com", "sg-public-api.hoyolab.com",
      "sg-act-nap-api.hoyolab.com", "bbs-api-os.hoyolab.com", "sg-cg-api.hoyoverse.com"];
    await Promise.all(official.map(async host => {
      const response = transport(new URL(`https://${host}/`), {
        headers: { Cookie: "fixture-only=never-visible-in-connect" }, signal: AbortSignal.timeout(1_500),
      });
      await expect(response).rejects.toMatchObject({ code: "ERR_PROXY_TUNNEL" });
    }));
    const direct = await transport(local.url, { signal: AbortSignal.timeout(1_500) });
    expect(await direct.text()).toBe("direct");
    expect(connections).toHaveLength(official.length);
    for (const host of official) expect(connections.some(frame => frame.startsWith(`CONNECT ${host}:443 `))).toBe(true);
    for (const frame of connections) {
      expect(frame.toLowerCase()).toContain("proxy-authorization: basic ");
      expect(frame.toLowerCase()).not.toContain("cookie:");
    }
  } finally {
    local.stop(true);
    proxy.close();
  }
});

test("空的旧代理配置沿用原传输，无效地址只阻断国际服", async () => {
  for (const value of [undefined, null, false, ""]) expect(hoyoTransportForBot(value)).toBe(withHoyoReadRetries(fetch));
  const transport = hoyoTransportForBot("socks5://127.0.0.1:1080");
  await expect(transport(new URL("https://api-account-os.hoyolab.com/"), {})).rejects.toThrow("国际服代理地址无效");
});
