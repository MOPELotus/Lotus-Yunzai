import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountCommands } from "../lib/account-commands.ts";
import { deviceCommands, isDeviceBindingInput } from "../lib/device-commands.ts";
import { parseDeviceBinding } from "../packages/account/device-binding.ts";

const id = "01234567-0123-4567-89ab-0123456789ab";
const otherId = "12345678-0123-4567-89ab-0123456789ab";
const fp = "A1B2C3D4E5F67";
const otherFp = "0123456789abc";

test("绝区零设备帮助保留档号，不打开设备绑定窗口", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-zzz-device-help-"));
  try {
    const module = deviceCommands(root, new AbortController().signal, () => "测试失败");
    const context = {
      message_type: "private" as const, self_id: 99, user_id: 42, isMaster: false, isBotMaster: () => false,
      reply: () => { throw new Error("帮助不应请求设备信息或发送文件"); },
    };
    for (const command of ["%绑定设备帮助2", "#绝区零绑定设备帮助2", "％绑定设备帮助2", "/ZZZ绑定设备帮助2"]) {
      expect(isDeviceBindingInput(command)).toBe(true);
      const reply = await module.fallback!(command, { ...context, normalizedMessage: command });
      expect(reply).toContain("#绑定设备2");
      expect(reply).toContain("等待有效期为两分钟");
      expect(reply).toContain("#设备信息2");
    }
    const { commands, aliases } = accountCommands(root, () => false);
    expect(aliases?.["#设备信息2"]).toBeDefined();
    expect(commands[aliases!["#设备信息2"]!]).toBeFunction();
    const payload = JSON.stringify({ device_id: id, device_fp: fp });
    expect(await module.fallback!(payload, { ...context, normalizedMessage: payload })).toBe("请先私聊发送 #绑定设备。");
    expect(isDeviceBindingInput("%解绑设备")).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("手工绑定解析独立 JSON、旧 data 包装、带标签的文本和 HTTP 头字段", () => {
  expect(parseDeviceBinding(JSON.stringify({
    device_id: id, device_fp: fp, deviceName: "Pixel 7", deviceModel: "GVU6C", osVersion: "Android 14",
  }))).toEqual({ id, fp, name: "Pixel 7", model: "GVU6C", androidVersion: "14" });
  expect(parseDeviceBinding(JSON.stringify({
    retcode: 0, data: { code: "200", bbs_device_id: id, device_fp: fp },
    deviceName: "Pixel 7", android_version: 14,
  }))).toEqual({ id, fp, name: "Pixel 7", androidVersion: "14" });
  expect(parseDeviceBinding(`\x60\x60\x60json\n{"data":{"deviceId":"${id}","fp":"${fp}"}}\n\x60\x60\x60`)).toEqual({ id, fp });
  expect(parseDeviceBinding(`device_id=${id} device_fp=${fp}; deviceName="Pixel 7"; androidVersion=12L`))
    .toEqual({ id, fp, name: "Pixel 7", androidVersion: "12L" });
  expect(parseDeviceBinding(`X-RPC-Device_ID: ${id}\nX-RPC-Device_FP：${fp}`)).toEqual({ id, fp });
});

test("ID 与 FP 必须来自同一个对象，拒绝种子和签发失败回显", () => {
  for (const input of [
    { seed_id: id, device_fp: fp },
    { device_id: id },
    { device_fp: fp },
    { device_id: id, data: { device_fp: fp } },
    { device_fp: fp, data: { device_id: id } },
    { retcode: 0, data: { code: 200, seed_id: id, device_fp: fp } },
    { deviceName: "Pixel 7", deviceFingerprint: "fixture hardware details" },
  ]) {
    expect(() => parseDeviceBinding(JSON.stringify(input))).toThrow("同时提供");
  }
  for (const input of [
    { device_id: id, device_fp: fp, ext_fields: "{}" },
    { app_name: "bbs_cn", seed_id: otherId, device_id: id, device_fp: fp },
  ]) {
    expect(() => parseDeviceBinding(JSON.stringify(input))).toThrow("种子");
  }
  for (const input of [
    { retcode: -1, data: { code: "200", device_id: id, device_fp: fp } },
    { retcode: 0, data: { code: 400, device_id: id, device_fp: fp } },
    { retcode: 0, data: { device_id: id, device_fp: fp } },
  ]) {
    expect(() => parseDeviceBinding(JSON.stringify(input))).toThrow("未确认成功");
  }
});

test("重复字段、冲突别名和格式不安全的输入均拒绝，错误不附带输入", () => {
  expect(() => parseDeviceBinding(`{"device_id":"${id}","device\\u005fid":"${otherId}","device_fp":"${fp}"}`))
    .toThrow("重复字段");
  for (const input of [
    `device_id=${id} device_id=${otherId} device_fp=${fp}`,
    JSON.stringify({ device_id: id, bbs_device_id: otherId, device_fp: fp }),
    JSON.stringify({ device_id: id, data: { device_id: otherId, device_fp: fp } }),
    JSON.stringify({ device_id: id, fp, device_fp: otherFp }),
  ]) {
    expect(() => parseDeviceBinding(input)).toThrow("相互冲突");
  }
  for (const input of [
    `outside ${id} ${fp}`,
    JSON.stringify({ device_id: `${id}\n`, device_fp: fp }),
    JSON.stringify({ device_id: `${id} \u0000`, device_fp: fp }),
    JSON.stringify({ device_id: id, device_fp: "not-signed-format" }),
    JSON.stringify({ device_id: 1234567890, device_fp: fp }),
    "x".repeat(16 * 1024 + 1),
  ]) {
    const error = (() => {
      try { parseDeviceBinding(input); } catch (failure) { return failure; }
    })();
    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).not.toContain(id);
    expect(String(error)).not.toContain(fp);
  }
});

test("设备绑定只返回可用于展示和请求头的有限字段", () => {
  expect(parseDeviceBinding(JSON.stringify({
    device_id: id, device_fp: fp, deviceName: "Cookie=synthetic-key",
    deviceModel: "https://fixture.invalid/test", androidVersion: "unrelated arbitrary label",
    cookie: "synthetic-key", stoken: "synthetic-secret", oaid: otherId,
    deviceFingerprint: "fixture firmware identity", raw: { cookie: "ignored" },
  }))).toEqual({ id, fp });
});
