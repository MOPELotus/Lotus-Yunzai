import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { registerGachaThemeFont } from "../packages/skia/gacha-theme-fonts.ts";
import type { renderPng } from "../packages/skia/index.ts";

type Context = Parameters<Parameters<typeof renderPng>[2]>[0];
const { Canvas } = createRequire(new URL("../packages/skia/index.ts", import.meta.url))("skia-canvas") as {
  Canvas: new (width: number, height: number) => { getContext(type: "2d"): Context };
};

const proportional = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
const monospace = "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf";

test.skipIf(!existsSync(proportional) || !existsSync(monospace))("加载其他主题不会覆盖已缓存的抽卡字族", () => {
  const ctx = new Canvas(1, 1).getContext("2d");
  const measure = (alias: string) => {
    ctx.font = `40px ${alias}`;
    return ctx.measureText("WWWWiiii 123678").width;
  };
  const original = registerGachaThemeFont("Number", proportional);
  const width = measure(original);
  const alternate = registerGachaThemeFont("Number", monospace);
  expect(alternate).not.toBe(original);
  expect(measure(alternate)).not.toBe(width);
  expect(measure(original)).toBe(width);
});
