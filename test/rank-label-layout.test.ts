import { expect, test } from "bun:test";
import { rankLabelLayout } from "../lib/rank-label-layout.ts";

test("练度长图输出、头像展示及群榜武器名称完整分行显示", () => {
  for (const value of ["焚曜千阳", "驶向第二次生命", "唯有香如故", "The Unreachable Side", "A"]) {
    const measure = (value: string) => Array.from(value).length * 11;
    const result = rankLabelLayout(value, 48, measure);
    expect(result.lines.join("")).toBe(value);
    expect(result.lines.length).toBeLessThanOrEqual(2);
    expect(result.size).toBeGreaterThan(0);
    for (const line of result.lines) expect(measure(line) * result.size / 11).toBeLessThanOrEqual(48.001);
  }
});
