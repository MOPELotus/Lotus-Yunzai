import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountCommands } from "../lib/account-commands.ts";
import { deviceCommands, isDeviceBindingInput, normalizeDeviceInfoCommand } from "../lib/device-commands.ts";
import { createProfileStore } from "../packages/account/index.ts";
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
      privateCredentialSignal: new AbortController().signal,
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
    expect(await module.fallback!(payload, { ...context, normalizedMessage: payload })).toBe("请先在本会话发送 #绑定设备。");
    expect(isDeviceBindingInput("%解绑设备")).toBe(true);
    for (const prefix of ["/绝区零", "#绝区零zzz", "#ZzzZZZ", "％绝区零"]) {
      expect(isDeviceBindingInput(prefix + "绑定设备信息2")).toBe(true);
      expect(normalizeDeviceInfoCommand(prefix + "设备信息2")).toBe("#设备信息2");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("绝区零解绑只修改本人私聊指定档案，保留登录与其它档案", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-device-unbind-"));
  try {
    const slot = join(root, "42-2.yaml");
    const other = join(root, "42.yaml");
    const account = { cookie: "fixture-cookie", stoken: "fixture-token" };
    const bound = { bound: true, id, fp };
    const original = Bun.YAML.stringify({ account, device: bound });
    await Promise.all([writeFile(slot, original), writeFile(other, original)]);
    const module = deviceCommands(root, new AbortController().signal, () => "unexpected");
    const command = "%解绑设备2";
    const context = {
      normalizedMessage: command, message_type: "private" as const, self_id: 99, user_id: 42,
      isMaster: false, isBotMaster: () => false, reply: () => true,
      privateCredentialSignal: new AbortController().signal,
    };
    const dispatch = module.fallback!;
    expect(await dispatch(command, { ...context, message_type: "group" })).toContain("私聊");
    expect(await dispatch(command, { ...context, isDelegated: true })).toBeUndefined();
    expect(await dispatch(command, { ...context, privateCredentialSignal: undefined })).toBeUndefined();
    expect(await dispatch(command, { ...context, privateCredentialSignal: AbortSignal.abort() })).toBeUndefined();
    expect(await readFile(slot, "utf8")).toBe(original);
    const profiles = createProfileStore(root);
    const previous = await profiles.accountContext("42", 2);
    expect(await dispatch(command, context)).toBe("已解绑该档案的设备。");
    expect(Bun.YAML.parse(await readFile(slot, "utf8"))).toEqual({ account, device: { bound: false } });
    expect(await readFile(other, "utf8")).toBe(original);
    expect(await dispatch(command, context)).toBe("该档案没有已绑定的设备。");
    await expect(profiles.removeBoundDevice("42", 2, previous.revision)).rejects.toMatchObject({ code: "changed" });
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

test("设备 APK 缺失、不支持或发送未确认时保持同档 JSON 绑定", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-device-apk-boundary-"));
  const lifecycle = new AbortController();
  const path = join(root, "fixture.apk");
  const command = "#绑定设备2", cancel = "#取消绑定设备2";
  try {
    await writeFile(join(root, "42-2.yaml"), Bun.YAML.stringify({
      account: { cookie: "fixture-cookie", stoken: "fixture-token" },
    }));
    const module = deviceCommands(root, lifecycle.signal, id => `档案 ${id} 已绑定`, path);
    const dispatch = module.fallback!;
    const connection = new AbortController();
    const context = {
      message_type: "private" as const, self_id: 99, user_id: 42,
      isMaster: false, isBotMaster: () => false, reply: () => true,
      privateCredentialSignal: connection.signal,
    };
    const device = (text: string, extra = {}) => dispatch(text, { ...context, normalizedMessage: text, ...extra });
    const payload = JSON.stringify({ device_id: id, device_fp: fp });
    expect(await device(`${command} ${payload}`, { privateCredentialSignal: undefined })).toBeUndefined();
    expect(await device(`${command} ${payload}`, { isDelegated: true })).toBeUndefined();

    const unsupported = await device(command);
    expect(unsupported).toContain("当前连接无法发送附件");
    expect(unsupported).toContain("可继续发送设备 JSON");
    const unavailable = await device(command, { uploadFile: () => { throw Error("不存在的文件不得上传"); } });
    expect(unavailable).toContain("设备信息工具文件暂不可用");
    expect(unavailable).not.toContain(path);

    await writeFile(path, "synthetic file, never installed");
    let attempts = 0;
    expect(await device(command, { uploadFile: async () => { attempts++; return "unknown"; } })).toEqual([]);
    expect(attempts).toBe(1);

    const entered = Promise.withResolvers<void>();
    const result = Promise.withResolvers<"rejected">();
    const inFlight = device(command, { uploadFile: async () => { entered.resolve(); return result.promise; } });
    await entered.promise;
    expect(await device(cancel)).toBe("已取消绑定设备。");
    result.resolve("rejected");
    expect(await inFlight).toEqual([]);

    expect(await device(command, { uploadFile: async () => "rejected" })).toContain("设备信息工具未能发送");
    const reconnected = { privateCredentialSignal: new AbortController().signal };
    connection.abort();
    expect(await device(payload)).toBeUndefined();
    expect(await device(payload, reconnected)).toBe("请先在本会话发送 #绑定设备。");
    expect(Bun.YAML.parse(await readFile(join(root, "42-2.yaml"), "utf8"))).not.toHaveProperty("device");
    expect(await device(`${command} ${payload}`, reconnected)).toBe("档案 2 已绑定");
    expect(Bun.YAML.parse(await readFile(join(root, "42-2.yaml"), "utf8"))).toMatchObject({
      account: { cookie: "fixture-cookie", stoken: "fixture-token" }, device: { bound: true, id, fp },
    });
  } finally {
    lifecycle.abort();
    await rm(root, { recursive: true, force: true });
  }
});


test("旧设备 JSON 可携带复制说明，仍拒绝拼接的设备对象", () => {
  const json = JSON.stringify({ device_id: id, device_fp: fp });
  expect(parseDeviceBinding("设备信息：" + json + "，已复制")).toEqual({ id, fp });
  expect(() => parseDeviceBinding("设备信息：" + json + json)).toThrow();
});

test("同设备只换 FP 时保留已有名称及 Android，冲突登录档不会写入", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-device-metadata-"));
  try {
    const profiles = createProfileStore(root);
    const file = join(root, "42.yaml");
    const account = { stuid: "77", stoken: "fixture-stoken", cookie: "ltuid=77;cookie_token=fixture" };
    const oldDevice = { bound: true, id, fp, name: "Fixture Pixel", model: "Fixture Model", raw: { osVersion: 13 } };
    await writeFile(file, Bun.YAML.stringify({ account, device: oldDevice }));
    const first = await profiles.accountContext("42");
    await profiles.saveBoundDevice("42", 1, first.revision, { id, fp: otherFp });
    expect((await profiles.accountContext("42")).device).toMatchObject({
      id, fp: otherFp, name: oldDevice.name, model: oldDevice.model, androidVersion: "13",
    });
    const second = await profiles.accountContext("42");
    await profiles.saveBoundDevice("42", 1, second.revision, { id: otherId, fp });
    expect((await profiles.accountContext("42")).device).toMatchObject({
      id: otherId, fp, name: "", model: "", androidVersion: "",
    });

    const conflicting = Bun.YAML.stringify({ account: { ...account, cookie: "ltuid=78;cookie_token=fixture" }, device: oldDevice });
    await writeFile(file, conflicting);
    const third = await profiles.accountContext("42");
    await expect(profiles.saveBoundDevice("42", 1, third.revision, { id, fp: otherFp })).rejects.toMatchObject({ code: "invalid" });
    expect(await readFile(file, "utf8")).toBe(conflicting);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("扫码只使用临时设备，不覆盖未完整的旧设备档案", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-device-half-profile-"));
  try {
    const profiles = createProfileStore(root);
    const file = join(root, "42.yaml");
    for (const device of [{ bound: false, fp, model: "Fixture" }, { bound: true, model: "Fixture Model" }]) {
      await writeFile(file, Bun.YAML.stringify({ device }));
      const slot = await profiles.openLoginSlot("42");
      expect(slot.device.id).toMatch(/^[a-f0-9]{32}$/u);
      expect(slot.device.fp).toBe("");
      await profiles.saveLogin(slot, { stuid: "77", stoken: "fixture-stoken", credentials: {
        ltoken: "fixture-ltoken", cookie: "ltoken=fixture-ltoken;ltuid=77;cookie_token=fixture;account_id=77;",
        stokenCookie: "stuid=77;stoken=fixture-stoken;",
      } });
      expect(Bun.YAML.parse(await readFile(file, "utf8"))).toMatchObject({ device });
      expect((await profiles.accountContext("42")).device.fp).toBe("");
    }
    for (const savedId of ["abcdef0123456789abcdef0123456789", "ABCDEF0123456789ABCDEF0123456789",
      "AbCdEf0123456789aBcDeF0123456789"]) {
      const device = { bound: true, id: savedId, fp: otherFp, model: "Existing Pixel" };
      await writeFile(file, Bun.YAML.stringify({ device }));
      const slot = await profiles.openLoginSlot("42");
      expect(slot.device.id).toBe(savedId);
      expect(slot.device.fp).toBe(otherFp);
      await profiles.saveLogin(slot, { stuid: "77", stoken: "fixture-stoken", credentials: {
        ltoken: "fixture-ltoken", cookie: "ltoken=fixture-ltoken;ltuid=77;cookie_token=fixture;account_id=77;",
        stokenCookie: "stuid=77;stoken=fixture-stoken;",
      } });
      expect(Bun.YAML.parse(await readFile(file, "utf8"))).toMatchObject({ device });
      expect((await profiles.accountContext("42")).device.id).toBe(savedId);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("设备等待只可跨同一登录的 Cookie 更新和无关配置改动", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-device-refresh-while-binding-"));
  const lifetime = new AbortController();
  try {
    const file = join(root, "42-2.yaml");
    const profiles = createProfileStore(root);
    const account = { stuid: "77", ltuid: "77", stoken: "fixture-stoken",
      cookie: "ltoken=before;ltuid=77;cookie_token=fixture;account_id=77;" };
    const stored = { account, device: { bound: true, id, fp }, profile: { id: 2 } };
    const module = deviceCommands(root, lifetime.signal, () => "设备已绑定");
    const context = { message_type: "private" as const, self_id: 99, user_id: 42,
      isMaster: false, isBotMaster: () => false, reply: () => true, privateCredentialSignal: lifetime.signal };
    const send = (text: string) => module.fallback!(text, { ...context, normalizedMessage: text });
    const input = JSON.stringify({ device_id: otherId, device_fp: otherFp });
    const renewed = "ltoken=renewed;ltuid=77;cookie_token=fixture-renewed;account_id=77;";
    for (const change of ["renewed", "settings", "login-replaced", "device-replaced", "logout"] as const) {
      await writeFile(file, Bun.YAML.stringify(stored));
      await send("#绑定设备2");
      const source = await profiles.accountContext("42", 2);
      if (change === "renewed") {
        await profiles.saveRefreshedCredentials("42", 2, source.revision, { ltoken: "renewed", cookie: renewed });
      } else if (change === "settings") {
        await writeFile(file, Bun.YAML.stringify({ ...stored, schedule: { fixed_time: "08:45" } }));
      } else if (change === "login-replaced") {
        await writeFile(file, Bun.YAML.stringify({ ...stored, account: { ...account, stoken: "another-login" } }));
      } else if (change === "device-replaced") {
        await profiles.saveBoundDevice("42", 2, source.revision, { id: otherId, fp });
      } else {
        await profiles.clearLogin("42", 2);
      }
      const before = await readFile(file, "utf8");
      const result = await send(input);
      if (change === "renewed" || change === "settings") {
        expect(result).toBe("设备已绑定");
        expect((await profiles.accountContext("42", 2)).device).toMatchObject({ id: otherId, fp: otherFp });
        if (change === "renewed") expect((await profiles.accountContext("42", 2)).account.cookie).toBe(renewed);
        else expect(await readFile(file, "utf8")).toContain("08:45");
      } else {
        expect(result).toBe("档案已变化，请重新发起设备绑定。");
        expect(await readFile(file, "utf8")).toBe(before);
      }
    }
  } finally {
    lifetime.abort();
    await rm(root, { recursive: true, force: true });
  }
});

test("群设备配对只绑定原群发令者，其他群消息不会消费窗口", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-group-device-"));
  try {
    await writeFile(join(root, "42-2.yaml"), Bun.YAML.stringify({ account: { cookie: "fixture-cookie", stoken: "fixture-token" } }));
    const signal = new AbortController().signal;
    const module = deviceCommands(root, signal, () => "unexpected");
    const ctx = { message_type: "group" as const, self_id: 99, user_id: 42, group_id: 61, message_id: 3,
      isMaster: false, isBotMaster: () => false, reply: () => true, groupActivitySignal: signal };
    await module.fallback!("", { ...ctx, normalizedMessage: "#绑定设备2" });
    const payload = JSON.stringify({ device_id: id, device_fp: fp });
    await module.fallback!("", { ...ctx, group_id: 62, normalizedMessage: payload });
    expect(Bun.YAML.parse(await readFile(join(root, "42-2.yaml"), "utf8"))).not.toHaveProperty("device.bound", true);
    await module.fallback!("", { ...ctx, normalizedMessage: payload });
    expect(Bun.YAML.parse(await readFile(join(root, "42-2.yaml"), "utf8"))).toHaveProperty("device.bound", true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
