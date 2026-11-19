import { expect, test } from "bun:test";
import { readMiaoObjectExport } from "../packages/gacha/miao-data.ts";

test("旧武器别名只读取所选导出的字符串字面量", () => {
  const table = `export const abbr = {
  // 同谐
  '舞！舞！舞！': "舞舞舞",
  流浪的晚星: '流浪晚星',
}
export const alias = { '舞！舞！舞！': '舞舞舞,跳舞' }`;
  expect(readMiaoObjectExport(table, "abbr")).toEqual({ "舞！舞！舞！": "舞舞舞", "流浪的晚星": "流浪晚星" });
  expect(readMiaoObjectExport(table, "alias")).toEqual({ "舞！舞！舞！": "舞舞舞,跳舞" });
  expect(readMiaoObjectExport(table, "missing")).toBeUndefined();
  expect(readMiaoObjectExport("export const abbr = { 光锥: readName() }", "abbr")).toBeUndefined();
  expect(readMiaoObjectExport("export const abbr = { 光锥: '旧', 光锥: '新' }", "abbr")).toBeUndefined();
});
