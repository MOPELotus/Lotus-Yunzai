import { expect, test } from "bun:test";
import { isInternalAddress, authorizedProtocolRequest, listenerOrigins } from "../lib/network-access.ts";
import { parseServerSettings } from "../lib/server.ts";
import { startOneBot } from "../lib/adapters/onebot.ts";
import { OneBotGroups } from "../lib/adapters/onebot-groups.ts";

test("默认和TRSS共用2536，监听所有网卡，内网免令牌且公网须认证", () => {
  const config = parseServerSettings({}, {});
  expect(config.hostname).toBe("0.0.0.0");
  expect(listenerOrigins(config.hostname, 2536, "ws")).toEqual(["ws://0.0.0.0:2536"]);
  expect(config.http?.port).toBe(2536);
  expect(config.oneBot?.port).toBe(2536);
  expect([...config.oneBot!.auth]).toEqual([]);
  const request = new Request("http://localhost/OneBotv11");
  for (const peer of ["127.0.0.1", "10.1.2.3", "172.16.2.3", "192.168.1.4", "::1", "fd00::2", "fe80::1", "::ffff:192.168.1.4"]) {
    expect(isInternalAddress(peer)).toBe(true);
    expect(authorizedProtocolRequest(request, new Headers(), peer)).toBe(true);
  }
  for (const peer of ["8.8.8.8", "172.32.0.1", "192.169.1.1", "2001:4860:4860::8888", "::ffff:808:808", "0.0.0.0", "::", undefined])
    expect(authorizedProtocolRequest(request, new Headers(), peer)).toBe(false);
  const token = new Headers({ Authorization: "Bearer fixture" });
  expect(authorizedProtocolRequest(request, token, "192.168.1.4")).toBe(true);
  expect(authorizedProtocolRequest(request, token, "8.8.8.8")).toBe(false);
  expect(authorizedProtocolRequest(new Request(request, { headers: token }), token, "8.8.8.8")).toBe(true);
  expect(authorizedProtocolRequest(new Request(request, { headers: { "x-forwarded-for": "192.168.1.4" } }), new Headers(), "127.0.0.1")).toBe(false);
});

test("实际反向WebSocket只填URL即可连接本机，身份仍来自OneBot标准头", async () => {
  const server = startOneBot(async () => {}, { hostname: "0.0.0.0", port: 0, auth: new Headers(),
    groups: new OneBotGroups(), isMaster: () => false, masterIds: () => [], prewarmGroupMembers: false });
  const socketType = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
  const socket = new socketType(`ws://127.0.0.1:${server.port}/OneBotv11`, { headers: { "X-Client-Role": "Universal", "X-Self-ID": "42" } });
  try {
    await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve(), { once: true }); socket.addEventListener("error", reject, { once: true }); });
    expect(socket.readyState).toBe(WebSocket.OPEN);
  } finally { socket.close(); await Bun.sleep(10); await server.stop(true); }
});
