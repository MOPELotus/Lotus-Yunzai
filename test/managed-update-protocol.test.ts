import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { isManagedUpdateName, isManagedUpdateProgress, isManagedUpdateRequestId, isTerminalManagedUpdateProgress,
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

test("托管更新校验请求 UUID 和有限状态码", () => {
  expect(isManagedUpdateRequestId(crypto.randomUUID())).toBe(true);
  expect(isManagedUpdateRequestId(crypto.randomUUID() + "\n")).toBe(false);
  expect(isManagedUpdateRequestId("invalid")).toBe(false);
  expect(isManagedUpdateProgress("failed")).toBe(true);
  expect(isTerminalManagedUpdateProgress("failed")).toBe(true);
  expect(isTerminalManagedUpdateProgress("switching")).toBe(true);
  expect(isManagedUpdateProgress("arbitrary command output")).toBe(false);
});
