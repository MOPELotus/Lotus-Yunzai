import { expect, test } from "bun:test";
import { createIntentId } from "../web/miyoushe/intent-id.ts";

const v4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

test("兑换意图优先使用浏览器randomUUID并保留方法接收者", () => {
  const source = { randomUUID() { expect(this).toBe(source); return "00112233-4455-4677-8899-aabbccddeeff"; },
    getRandomValues() { throw new Error("不应调用回退"); } };
  expect(createIntentId(source)).toBe("00112233-4455-4677-8899-aabbccddeeff");
});

test("内网HTTP无randomUUID时以安全随机生成标准v4且设置版本和variant位", () => {
  expect(createIntentId({ getRandomValues(bytes) { bytes.fill(255); return bytes; } }))
    .toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
  const ids = Array.from({ length: 20 }, () => createIntentId({ getRandomValues: bytes => crypto.getRandomValues(bytes) }));
  expect(ids.every(id => typeof id === "string" && v4.test(id))).toBe(true);
  expect(new Set(ids).size).toBe(20);
});

test("randomUUID不可用时继续安全回退，缺安全随机数时明确失败", () => {
  expect(createIntentId({ randomUUID() { throw new Error("不可用"); },
    getRandomValues(bytes) { bytes.fill(0); return bytes; } })).toBe("00000000-0000-4000-8000-000000000000");
  expect(createIntentId({})).toBeUndefined();
  expect(createIntentId({ getRandomValues() { throw new Error("不可用"); } })).toBeUndefined();
});
