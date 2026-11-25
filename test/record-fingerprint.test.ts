import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { addRecordFingerprint } from "../packages/hoyo-client/record-fingerprint.ts";
import { readStarRailPanel } from "../packages/hoyo-client/starrail-panel.ts";
import type { ProfileRequestContext } from "../packages/account/index.ts";

test("查询自动申请并复用同一设备的官方 FP，不向指纹接口发送账号 Cookie", async () => {
  const id = randomUUID().replaceAll("-", "");
  const signal = new AbortController().signal;
  let calls = 0;
  const transport = async (url: URL, init: RequestInit) => {
    calls++;
    expect(url.href).toBe("https://public-data-api.mihoyo.com/device-fp/api/getFp");
    expect(new Headers(init.headers).has("Cookie")).toBe(false);
    expect(new Headers(init.headers).get("User-Agent")).toBe("okhttp/4.9.3");
    const body = JSON.parse(String(init.body));
    expect(body.device_id).toBe(id);
    expect(body.platform).toBe("1");
    expect(JSON.parse(body.ext_fields).IDFV).toBe(id);
    return Response.json({ retcode: 0, data: { code: 200, device_fp: "123456789abcd" } });
  };
  const first = new Headers({ "x-rpc-device_id": id, Cookie: "fixture=secret" });
  await addRecordFingerprint(first, transport, signal, async () => {});
  expect(first.get("x-rpc-device_fp")).toBe("123456789abcd");
  const second = new Headers({ "x-rpc-device_id": id });
  await addRecordFingerprint(second, async () => { throw Error("must use cache"); }, signal, async () => {});
  expect(second.get("x-rpc-device_fp")).toBe("123456789abcd");
  expect(calls).toBe(1);
});

test("已有配对 FP 不覆盖；种子值、错设备或错误回执不能作为官方 FP", async () => {
  const signal = new AbortController().signal;
  const bound = new Headers({ "x-rpc-device_id": randomUUID(), "x-rpc-device_fp": "bound-fp" });
  await addRecordFingerprint(bound, async () => { throw Error("bound device must not request FP"); }, signal, async () => {});
  expect(bound.get("x-rpc-device_fp")).toBe("bound-fp");
  for (const payload of [
    { retcode: 0, data: { code: 200, device_fp: "38d7ee834d1e9" } },
    { retcode: 0, data: { code: 200, device_fp: "123456789abcd", device_id: "OTHER" } },
    { retcode: -100, data: { code: 200, device_fp: "123456789abcd" } },
  ]) {
    const headers = new Headers({ "x-rpc-device_id": randomUUID().toUpperCase() });
    await expect(addRecordFingerprint(headers, async () => Response.json(payload), signal, async () => {})).rejects.toThrow("设备指纹申请失败");
    expect(headers.has("x-rpc-device_fp")).toBe(false);
  }
});

test("指纹响应期间换档或取消，不能继续发送原角色查询", async () => {
  const cancellation = new AbortController();
  const headers = new Headers({ "x-rpc-device_id": randomUUID().toUpperCase() });
  let changed = false;
  await expect(addRecordFingerprint(headers, async () => {
    changed = true;
    return Response.json({ retcode: 0, data: { code: 200, device_fp: "123456789abcd" } });
  }, cancellation.signal, async () => { if (changed) throw Error("profile changed"); })).rejects.toThrow("profile changed");
  expect(headers.has("x-rpc-device_fp")).toBe(false);
});

test("战绩连接重置后有限重读，换档立即停止重试", async () => {
  const source = { game: "sr", role: { uid: "123456789", region: "prod_gf_cn", gameBiz: "hkrpg_cn" },
    account: { cookie: "ltuid=fixture; ltoken=fixture" }, device: { id: "retry-device", fp: "issued-fp" } } as ProfileRequestContext;
  let calls = 0;
  const result = await readStarRailPanel(source, async () => {
    if (++calls < 3) throw Object.assign(Error("connection reset"), { code: "ECONNRESET" });
    return Response.json({ retcode: 0, data: { avatar_list: [{ id: 1001 }] } });
  }, {});
  expect(result.avatars).toEqual([{ id: 1001 }]);
  expect(calls).toBe(3);
  let changed = false;
  calls = 0;
  await expect(readStarRailPanel(source, async () => {
    calls++; changed = true; throw Error("connection reset");
  }, {}, async () => { if (changed) throw Error("profile changed"); })).rejects.toThrow("profile changed");
  expect(calls).toBe(1);
});

test("指纹和只读战绩遇到 HTML 网关错误可重试，同一次指纹申请保持原请求体", async () => {
  const headers = new Headers({ "x-rpc-device_id": randomUUID() });
  const bodies: unknown[] = [];
  await addRecordFingerprint(headers, async (_url, init) => {
    bodies.push(init.body);
    return bodies.length === 1 ? new Response("<html>410 Gone - Tengine</html>", { status: 410, headers: { "Content-Type": "text/html" } })
      : Response.json({ retcode: 0, data: { code: 200, device_fp: "123456789abcd" } });
  }, AbortSignal.timeout(3000), async () => {});
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toBe(bodies[1]);
  const source = { game: "sr", role: { uid: "123456789", region: "prod_gf_cn", gameBiz: "hkrpg_cn" },
    account: { cookie: "ltuid=fixture; ltoken=fixture" }, device: { id: "gateway-device", fp: "issued-fp" } } as ProfileRequestContext;
  let calls = 0;
  const result = await readStarRailPanel(source, async () => ++calls === 1
    ? new Response("<html>410 Gone - Tengine</html>", { status: 410, headers: { "Content-Type": "text/html" } })
    : Response.json({ retcode: 0, data: { avatar_list: [{ id: 1001 }] } }), {});
  expect(calls).toBe(2);
  expect(result.avatars).toEqual([{ id: 1001 }]);
  calls = 0;
  await expect(readStarRailPanel(source, async () => {
    calls++; return Response.json({ retcode: -100 }, { status: 410 });
  }, {})).rejects.toMatchObject({ code: "http", status: 410 });
  expect(calls).toBe(1);
});
