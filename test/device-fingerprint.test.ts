import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAndroidDeviceInfo, parseDeviceBinding, type AndroidDeviceInfo } from "../packages/account/device-binding.ts";
import { buildDeviceFingerprintPayload, requestDeviceFingerprint } from "../packages/hoyo-client/device-fingerprint.ts";
import { deviceCommands } from "../lib/device-commands.ts";
import { createProfileStore } from "../packages/account/index.ts";
import type { HoyoTransport } from "../packages/hoyo-client/credentials.ts";

const android = {
  deviceName: "Fixture Pixel", deviceModel: "Pixel 7", deviceFingerprint: "google/panther/panther:13/TQ1A.221205.011/9244662:user/release-keys",
  deviceProduct: "panther", deviceBoard: "panther", oaid: "0123456789abcdef0123456789abcdef", osVersion: "13",
  sdkVersion: "33", screenSize: "1080x2400", romCapacity: "128", ramCapacity: "8192",
};
const proof = "a1b2c3d4e5f67";
const issued = () => Response.json({ retcode: 0, data: { code: 200, device_fp: proof } });

test("APK 安卓参数只提取设备字段，生成 getFp 的稳定身份且种子不作为绑定指纹", () => {
  const parsed = parseAndroidDeviceInfo("设备资料：" + JSON.stringify({ ...android, cookie: "never-send", stoken: "never-send" }));
  expect(parsed).toEqual(android);
  const payload = buildDeviceFingerprintPayload(parsed!);
  expect(payload.device_id).toMatch(/^[0-9a-f]{16}$/u);
  expect(payload.bbs_device_id).toMatch(/^[0-9a-f-]{36}$/u);
  const ext = JSON.parse(payload.ext_fields);
  expect(ext).toMatchObject({ model: android.deviceModel, board: android.deviceBoard, deviceInfo: android.deviceFingerprint,
    osVersion: "13", sdkVersion: "33", oaid: android.oaid, screenSize: "1080x2400", romCapacity: "128", ramCapacity: "8192",
    aaid: payload.bbs_device_id });
  expect(JSON.stringify(payload)).not.toContain("never-send");
  expect(() => parseDeviceBinding(JSON.stringify(payload))).toThrow("种子");
  expect(parseAndroidDeviceInfo(JSON.stringify({ ...android, device_id: "existing-device", device_fp: proof }))).toBeUndefined();
  expect(parseAndroidDeviceInfo(JSON.stringify({ ...android, device_id: "existing-device" }))).toBeUndefined();
  expect(() => parseAndroidDeviceInfo(JSON.stringify({ ...android, oaid: "error_denied" }))).toThrow("OAID");
  expect(() => parseAndroidDeviceInfo(JSON.stringify({ ...android, oaid: undefined }))).toThrow("完整 JSON");
  expect(() => parseAndroidDeviceInfo(JSON.stringify(android).replace('"oaid":', '"oaid":"first","oaid":'))).toThrow("重复字段");
  const noVersion = { ...android, osVersion: undefined, sdkVersion: undefined };
  expect(parseAndroidDeviceInfo(JSON.stringify(noVersion))?.osVersion).toBe("13");
  const android12 = buildDeviceFingerprintPayload({ ...android, osVersion: "12", sdkVersion: undefined } as AndroidDeviceInfo);
  expect(JSON.parse(android12.ext_fields)).not.toHaveProperty("sdkVersion");
});

test("官方指纹申请只重试瞬时故障，同一申请保持设备身份且不发送账号凭据", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const transport: HoyoTransport = async (url, init) => {
    requests.push({ url: url.href, init });
    return requests.length === 1 ? new Response(null, { status: 503 }) : issued();
  };
  let guards = 0;
  const binding = await requestDeviceFingerprint(android, { transport, signal: new AbortController().signal, verify: async () => { guards++; } });
  expect(requests).toHaveLength(2);
  expect(requests[0]!.url).toBe("https://public-data-api.mihoyo.com/device-fp/api/getFp");
  expect(requests[0]!.init.body).toBe(requests[1]!.init.body);
  expect(new Headers(requests[0]!.init.headers).has("Cookie")).toBe(false);
  expect(requests[0]!.init).toMatchObject({ redirect: "error", credentials: "omit", method: "POST" });
  expect(binding).toEqual({ id: JSON.parse(String(requests[0]!.init.body)).device_id, fp: proof,
    name: "Fixture Pixel", model: "Pixel 7", androidVersion: "13" });
  expect(guards).toBeGreaterThan(2);
});

test("官方拒绝、格式错误、种子回显及错误设备身份均不绑定或反复申请", async () => {
  for (const response of [
    () => new Response(null, { status: 429 }),
    () => Response.json({ retcode: -1, data: { code: 200, device_fp: proof } }),
    () => Response.json({ retcode: 0, data: { code: 400, device_fp: proof } }),
    () => Response.json({ retcode: 0, data: { code: 200, device_fp: "38d80737ce6f3" } }),
    () => Response.json({ retcode: 0, data: { code: 200, device_fp: proof, device_id: "wrong-device" } }),
    () => new Response("unparseable"),
  ]) {
    let requests = 0;
    await expect(requestDeviceFingerprint(android, { signal: new AbortController().signal,
      transport: async () => { requests++; return response(); } })).rejects.toThrow("设备指纹申请未完成");
    expect(requests).toBe(1);
  }
  let requests = 0;
  await expect(requestDeviceFingerprint(android, { signal: new AbortController().signal,
    transport: async () => { requests++; throw new Error("private transport detail"); } })).rejects.toThrow("设备指纹申请未完成");
  expect(requests).toBe(3);
});

test("好友私聊 APK 导出自动申请后绑定指定档案，已有配对数据不触网", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-device-issuance-"));
  const lifecycle = new AbortController();
  try {
    const file = join(root, "42-2.yaml");
    const original = Bun.YAML.stringify({ account: { cookie: "fixture-cookie", stoken: "fixture-token" } });
    await writeFile(file, original);
    let requests = 0;
    const module = deviceCommands(root, lifecycle.signal, id => `档案 ${id} 已绑定`, undefined,
      { transport: async () => { requests++; return issued(); } });
    const context = { message_type: "private" as const, self_id: 99, user_id: 42, isMaster: false,
      isBotMaster: () => false, reply: () => true, privateCredentialSignal: lifecycle.signal };
    const send = (text: string, override = {}) => module.fallback!(text, { ...context, normalizedMessage: text, ...override });
    const payload = JSON.stringify(android);
    expect(await send(payload)).toBe("请先私聊发送 #绑定设备。");
    await send("#绑定设备2", { message_type: "group" });
    await send("#绑定设备2 " + payload, { privateCredentialSignal: undefined });
    await send("#绑定设备2 " + payload, { isDelegated: true });
    expect(requests).toBe(0);
    await send("#绑定设备2");
    expect(await send(payload)).toBe("档案 2 已绑定");
    expect(requests).toBe(1);
    const saved = Bun.YAML.parse(await readFile(file, "utf8")) as { device: { id: string } };
    expect(saved).toMatchObject({ account: { cookie: "fixture-cookie", stoken: "fixture-token" }, device: {
      bound: true, generated: false, fp: proof, model: "Pixel 7", android_version: "13",
    } });
    expect(saved.device.id).toMatch(/^[a-f0-9]{16}$/u);
    expect(saved.device).not.toHaveProperty("raw");
    expect(await send("#绑定设备2 " + JSON.stringify({ device_id: "existing-device", device_fp: proof }))).toBe("档案 2 已绑定");
    expect(requests).toBe(1);
  } finally { lifecycle.abort(); await rm(root, { recursive: true, force: true }); }
});

test("申请期间取消、断线、重新绑定、换号和退出登录不会提交旧设备", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-device-cancel-"));
  try {
    const file = join(root, "42-2.yaml");
    const profiles = createProfileStore(root);
    const original = Bun.YAML.stringify({ account: { stuid: "77", cookie: "ltuid=77;cookie_token=fixture", stoken: "fixture-token" } });
    for (const action of ["cancel", "disconnect", "replaced", "account", "logout", "cookie-refresh"] as const) {
      const connection = new AbortController();
      const lifecycle = new AbortController();
      await writeFile(file, original);
      const entered = Promise.withResolvers<void>();
      const resumed = Promise.withResolvers<void>();
      const module = deviceCommands(root, lifecycle.signal, () => "设备已绑定", undefined, {
        transport: async () => { entered.resolve(); await resumed.promise; return issued(); },
      });
      const context = { message_type: "private" as const, self_id: 99, user_id: 42, isMaster: false,
        isBotMaster: () => false, reply: () => true, privateCredentialSignal: connection.signal };
      const send = (text: string) => module.fallback!(text, { ...context, normalizedMessage: text });
      const running = send("#绑定设备2 " + JSON.stringify(android));
      await entered.promise;
      if (action === "cancel") expect(await send("#取消绑定设备2")).toBe("已取消绑定设备。");
      else if (action === "disconnect") connection.abort();
      else if (action === "replaced") await send("#绑定设备2");
      else if (action === "account") await writeFile(file, Bun.YAML.stringify({ account: { stuid: "88", cookie: "ltuid=88;cookie_token=other", stoken: "other" } }));
      else if (action === "logout") await profiles.clearLogin("42", 2);
      else {
        const current = await profiles.accountContext("42", 2);
        await profiles.saveRefreshedCredentials("42", 2, current.revision, { ltoken: "renewed", cookie: "ltoken=renewed;ltuid=77;cookie_token=renewed" });
      }
      const before = await readFile(file, "utf8");
      resumed.resolve();
      const outcome = await running;
      if (action === "cookie-refresh") {
        expect(outcome).toBe("设备已绑定");
        expect((await profiles.accountContext("42", 2)).account.cookie).toContain("renewed");
      } else {
        expect(await readFile(file, "utf8")).toBe(before);
        if (action === "account" || action === "logout") expect(outcome).toBe("档案已变化，请重新发起设备绑定。");
        else expect(outcome).toEqual([]);
      }
      lifecycle.abort();
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
