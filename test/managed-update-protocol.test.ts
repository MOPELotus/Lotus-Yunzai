import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { encodeManagedUpdateRequest, isManagedUpdateName, isManagedUpdateProgress, isManagedUpdateRequestId, isTerminalManagedUpdateProgress,
  parseManagedUpdateRequest } from "../lib/managed-update-protocol.ts";

const directory = { name: "群工具-Plugin", path: resolve("fixtures", "plugins", "群工具-Plugin"), packageName: "@fixture/group" };
const request = { requested: "群工具", quiet: false, target: { type: "group" as const, botId: 99, id: 77 }, directories: [directory] };

test("托管更新允许中文目录和作用域包名，清除未知字段", () => {
  expect(parseManagedUpdateRequest({ ...request,
    target: { ...request.target, fake: true }, directories: [{ ...directory, fake: true }], fake: true,
  })).toEqual(request);
  expect(isManagedUpdateName("@fixture/group")).toBe(true);
  const legacy = { name: "群 工具", path: resolve("fixtures", "plugins", "群 工具"), packageName: "群 工具:旧版" };
  expect(parseManagedUpdateRequest({ ...request, directories: [legacy] })?.directories).toEqual([legacy]);
  expect(parseManagedUpdateRequest({ quiet: true, target: { type: "terminal" }, directories: [] }))
    .toEqual({ quiet: true, target: { type: "terminal" }, directories: [] });
});

test("托管更新拒绝混淆名称、非规范路径、重复目录和畸形接收人", () => {
  for (const requested of ["", "..", "应用\n", "应用;id", "@fixture/group/extra", " 应用", "a".repeat(215)]) {
    expect(parseManagedUpdateRequest({ ...request, requested })).toBeUndefined();
  }
  for (const path of ["plugins/群工具-Plugin", directory.path + "/", directory.path + "\r", join("..", directory.path),
    resolve("fixtures", "other-plugins", directory.name), resolve("fixtures", "plugins", "different")]) {
    expect(parseManagedUpdateRequest({ ...request, directories: [{ ...directory, path }] })).toBeUndefined();
  }
  expect(parseManagedUpdateRequest({ ...request, directories: [directory, directory] })).toBeUndefined();
  expect(parseManagedUpdateRequest({ ...request, directories: Array(129).fill(directory) })).toBeUndefined();
  expect(parseManagedUpdateRequest({ ...request, quiet: 1 })).toBeUndefined();
  expect(parseManagedUpdateRequest({ ...request, target: { ...request.target, id: "77" } })).toBeUndefined();
  expect(parseManagedUpdateRequest({ ...request, target: { ...request.target, botId: 2 ** 53 } })).toBeUndefined();
  expect(parseManagedUpdateRequest({ ...request, target: { type: "master" } })).toBeUndefined();
});

test("全量托管更新要求布尔标记且不能同时指定单项", () => {
  const batch = { quiet: true, all: true, target: { type: "terminal" as const }, directories: [directory] };
  expect(parseManagedUpdateRequest(batch)).toEqual(batch);
  expect(parseManagedUpdateRequest({ ...batch, requested: "system" })).toBeUndefined();
  expect(parseManagedUpdateRequest({ ...batch, requested: "" })).toBeUndefined();
  expect(parseManagedUpdateRequest({ ...request, all: false })).toEqual({ ...request, all: false });
  for (const all of [null, 0, 1, "false", "true", {}]) {
    expect(parseManagedUpdateRequest({ ...batch, all })).toBeUndefined();
  }
});

test("强制更新标记仅接受布尔值，可用于单项和全量", () => {
  expect(parseManagedUpdateRequest({ ...request, force: true })).toEqual({ ...request, force: true });
  expect(parseManagedUpdateRequest({ ...request, force: false })).toEqual({ ...request, force: false });
  expect(parseManagedUpdateRequest({ ...request, all: true, force: true })).toBeUndefined();
  const batch = { quiet: true, all: true, force: true, target: { type: "terminal" as const }, directories: [directory] };
  expect(parseManagedUpdateRequest(batch)).toEqual(batch);
  for (const force of [null, 0, 1, "false", "true", {}]) {
    expect(parseManagedUpdateRequest({ ...request, force })).toBeUndefined();
  }
});

test("定时更新目标只接受普通静默全量请求", () => {
  const scheduled = {
    all: true, quiet: true, target: { type: "scheduled" as const, botIds: [99, 88], terminal: true }, directories: [directory],
  };
  expect(parseManagedUpdateRequest(scheduled)).toEqual(scheduled);
  expect(parseManagedUpdateRequest({ ...scheduled, force: false })).toEqual({ ...scheduled, force: false });
  for (const overrides of [{ requested: "system" }, { all: false }, { all: undefined }, { quiet: false }, { force: true }]) {
    expect(parseManagedUpdateRequest({ ...scheduled, ...overrides })).toBeUndefined();
  }
  const noRecipients = { ...scheduled, target: { ...scheduled.target, botIds: [], terminal: false } };
  expect(parseManagedUpdateRequest(noRecipients)).toEqual(noRecipients);
});

test("定时更新目标只保留唯一安全账号和布尔终端标记", () => {
  const target = { type: "scheduled" as const, botIds: Array.from({ length: 128 }, (_, index) => index + 1), terminal: false };
  const scheduled = { all: true, quiet: true, target, directories: [] };
  const parsed = parseManagedUpdateRequest({ ...scheduled, target: { ...target, id: 77, fake: true } });
  expect(parsed).toEqual(scheduled);
  if (parsed?.target.type !== "scheduled") throw new Error("未解析出定时更新目标。");
  expect(parsed.target.botIds).not.toBe(target.botIds);
  for (const botIds of [undefined, "99", [0], [-1], [1.5], ["99"], [2 ** 53], [NaN], [99, 99], Array(1),
    [...target.botIds, 129]]) {
    expect(parseManagedUpdateRequest({ ...scheduled, target: { ...target, botIds } })).toBeUndefined();
  }
  for (const terminal of [undefined, 0, 1, null, "false"]) {
    expect(parseManagedUpdateRequest({ ...scheduled, target: { ...target, terminal } })).toBeUndefined();
  }
});

test("托管更新校验请求 UUID 和有限状态码", () => {
  expect(isManagedUpdateRequestId(crypto.randomUUID())).toBe(true);
  expect(isManagedUpdateRequestId(crypto.randomUUID() + "\n")).toBe(false);
  expect(isManagedUpdateRequestId("invalid")).toBe(false);
  expect(isManagedUpdateProgress("failed")).toBe(true);
  expect(isTerminalManagedUpdateProgress("failed")).toBe(true);
  expect(isTerminalManagedUpdateProgress("switching")).toBe(true);
  expect(isManagedUpdateProgress("arbitrary command output")).toBe(false);
});

test("托管安装仅传目录短名和原会话，不能混用更新参数", () => {
  const { requested: _, ...base } = request;
  const install = { ...base, install: "群工具" };
  expect(parseManagedUpdateRequest({ ...install, url: "https://example.invalid/repo.git" })).toEqual(install);
  expect(parseManagedUpdateRequest({ ...install, target: { type: "terminal" } })?.install).toBe("群工具");
  for (const mixed of [
    { install: "插件" }, { install: "https://example.invalid/a" }, { install: "../test" }, { install: "a\n" },
    { requested: "system" }, { all: true }, { all: false }, { quiet: true }, { force: true },
    { target: { type: "scheduled", botIds: [], terminal: true } },
  ]) expect(parseManagedUpdateRequest({ ...install, ...mixed })).toBeUndefined();
});

test("Milky 托管更新与安装使用独立的线协议接收人类型", () => {
  for (const [type, wireType] of [["private", "milky-private"], ["group", "milky-group"]] as const) {
    const target = { ...request.target, type, adapter: "milky" as const };
    for (const input of [{ ...request, target }, { install: "群工具", quiet: false, directories: [directory], target }]) {
      const wire = encodeManagedUpdateRequest(input);
      expect(wire.target).toEqual({ type: wireType, botId: 99, id: 77 });
      expect(wire.target).not.toHaveProperty("adapter");
      const parsed = parseManagedUpdateRequest(JSON.parse(JSON.stringify(wire)));
      expect(parsed).toEqual(input);
      expect(parseManagedUpdateRequest(parsed)).toEqual(input);
      expect(parseManagedUpdateRequest(input)).toEqual(input);
    }
  }
});

test("非 Milky 请求继续使用原线协议，拒绝错误位置或值的适配器", () => {
  const scheduled = { all: true, quiet: true, target: { type: "scheduled" as const, botIds: [99], terminal: true }, directories: [] };
  const terminal = { ...request, target: { type: "terminal" as const } };
  const privateRequest = { ...request, target: { ...request.target, type: "private" as const } };
  for (const input of [request, privateRequest, scheduled, terminal]) {
    expect(encodeManagedUpdateRequest(input)).toEqual(input);
    expect(parseManagedUpdateRequest(encodeManagedUpdateRequest(input))).toEqual(input);
  }
  for (const adapter of ["onebot", "Milky", "", null, true]) {
    expect(parseManagedUpdateRequest({ ...request, target: { ...request.target, adapter } })).toBeUndefined();
  }
  for (const input of [terminal, scheduled]) {
    expect(parseManagedUpdateRequest({ ...input, target: { ...input.target, adapter: "milky" } })).toBeUndefined();
  }
  for (const type of ["milky-private", "milky-group"]) {
    const target = { ...request.target, type };
    expect(parseManagedUpdateRequest({ ...request, target: { ...target, adapter: "milky" } })).toBeUndefined();
    expect(parseManagedUpdateRequest({ ...request, target: { ...target, botId: 0 } })).toBeUndefined();
    expect(parseManagedUpdateRequest({ ...request, target: { ...target, id: String(target.id) } })).toBeUndefined();
  }
});
