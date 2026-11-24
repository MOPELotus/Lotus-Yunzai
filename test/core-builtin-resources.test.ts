import { createHash } from "node:crypto";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { builtinResourceDirectory } from "../lib/builtin-resources.ts";
import { prepareBuiltinFonts, builtinFontFallback } from "../packages/skia/builtin-fonts.ts";
import { openProfileCardTheme } from "../packages/skia/profile-card.ts";

test.each([['passport', 7], ['daily-note-reminder', 10], ['fonts', 1], ['rank-fonts', 2]] as const)("内置核心素材 %s 与固定来源清单一致", async (name, count) => {
  const root = builtinResourceDirectory(`core/${name}`);
  const manifest = await Bun.file(join(root, "SOURCES.json")).json();
  expect(manifest.revision).toMatch(/^[0-9a-f]{40}$/u);
  expect(manifest.files).toHaveLength(count);
  for (const { path, bytes, sha256 } of manifest.files) {
    const content = await Bun.file(join(root, path)).bytes();
    expect(content.byteLength).toBe(bytes);
    expect(createHash("sha256").update(content).digest("hex")).toBe(sha256);
    if (path.endsWith('.png')) expect(Buffer.from(content.subarray(0, 8))).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
});

test("账号资料卡默认主题可直接从内置文件加载，不需要旧插件目录或初始化下载", async () => {
  const theme = await openProfileCardTheme();
  expect(theme.background.width).toBeGreaterThan(0);
  expect(theme.background.height).toBeGreaterThan(0);
  expect(theme.text).toContain("ProfileBody");
});

test("项目自带中文和emoji字库可注册，不需要系统字体目录", () => {
  expect(() => prepareBuiltinFonts()).not.toThrow();
  expect(() => prepareBuiltinFonts()).not.toThrow();
  expect(builtinFontFallback).toContain('"LotusBuiltinEmoji"');
});
