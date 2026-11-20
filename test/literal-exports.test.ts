import { expect, test } from "bun:test";
import { readLiteralArrayExport, readLiteralObjectExport } from "@lotus-yunzai/gacha/literal-exports";
import { readMiaoArrayExport, readMiaoObjectExport } from "@lotus-yunzai/gacha/miao-data";

test("旧武器别名只读取所选导出的字符串字面量", () => {
  const table = `export const abbr = {
  // 同谐
  '舞！舞！舞！': "舞舞舞",
  流浪的晚星: '流浪晚星',
}
export const alias = { '舞！舞！舞！': '舞舞舞,跳舞' }`;
  expect(readLiteralObjectExport(table, "abbr")).toEqual({ "舞！舞！舞！": "舞舞舞", "流浪的晚星": "流浪晚星" });
  expect(readLiteralObjectExport(table, "alias")).toEqual({ "舞！舞！舞！": "舞舞舞,跳舞" });
  expect(readLiteralObjectExport(table, "missing")).toBeUndefined();
  expect(readLiteralObjectExport("export const abbr = { 光锥: readName() }", "abbr")).toBeUndefined();
  expect(readLiteralObjectExport("export const abbr = { 光锥: '旧', 光锥: '新' }", "abbr")).toBeUndefined();
});

test("旧资源读取接口仍指向同一个字面量解析器", () => {
  expect(readMiaoArrayExport).toBe(readLiteralArrayExport);
  expect(readMiaoObjectExport).toBe(readLiteralObjectExport);
});
