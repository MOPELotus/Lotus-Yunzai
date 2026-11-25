import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createAkashaAbyss } from "../plugins/guides/akasha-abyss.ts";
import { builtinResourceDirectory } from "../lib/builtin-resources.ts";

const fixed = ["img/background/AbyssUR_bg.webp", "img/background/AbyssTeams_bg.webp",
  ...["split100", "split75", "split50", "split10", "team_split"].map(name => `img/separator/${name}.png`)];

test("虚空榜单固定图与114张源角色图均随内置包校验，不依赖旧插件", async () => {
  const source = await Bun.file(new URL("../resources/builtin/social/sources.json", import.meta.url)).json() as {
    files: { path: string; originalPath: string; revision: string; size: number; sha256: string }[];
  };
  const rows = source.files.filter(row => row.path.startsWith("guides/img/"));
  const paths = new Set(rows.map(row => row.path.slice("guides/".length)));
  for (const path of fixed) expect(paths.has(path)).toBe(true);
  expect(rows.filter(row => row.path.startsWith("guides/img/role/")).length).toBe(114);
  for (const row of rows) {
    const bytes = await Bun.file(`${builtinResourceDirectory("social")}/${row.path}`).arrayBuffer();
    expect(bytes.byteLength).toBe(row.size);
    expect(createHash("sha256").update(Buffer.from(bytes)).digest("hex")).toBe(row.sha256);
    expect(row.revision).toBe("8667289b51a70e144336a968008f46ded1fbcc91");
  }
});

test("无旧主题时实际虚空使用率和队伍入口可读内置背景分隔线及角色图", async () => {
  const loaded = new Map<string, boolean>();
  const team = { tl: [1, 2], ac: 12, mr: 50, uc: 7, umr: 50, dc: 5, dmr: 50, ud: "50:50" };
  const data = { modify_time: "2026-11-25 12:00", schedule_version_desc: "合成一期",
    character_used_list: [{ name: "七七", rarity: 5, value: 50 }, { name: "凯亚", rarity: 4, value: 25 }],
    team_list: [team], team_up_list: [team], team_down_list: [team] };
  const handler = createAkashaAbyss({ themes: [], signal: new AbortController().signal,
    transport: async url => String(url).endsWith("abyss_total.js")
      ? new Response(`var static_abyss_total = ${JSON.stringify(data)};`)
      : new Response('var static_card_dict = {"1":{"name":"七七"},"2":{"name":"凯亚"}};'),
    draw: async (card, read) => {
      const paths = card.type === "usage" ? [fixed[0]!, ...fixed.slice(2, 6)] : [fixed[1]!, fixed[6]!];
      for (const path of [...paths, "img/role/七七.png", "img/role/凯亚.png"]) loaded.set(path, !!await read(path, !path.includes("/role/")));
      throw new Error("仅验证真实入口资源读取，图片渲染由独立物理GPU验收");
    },
  });
  await handler("#虚空使用率");
  await handler("#虚空队伍");
  expect([...loaded.keys()].sort()).toEqual([...fixed, "img/role/七七.png", "img/role/凯亚.png"].sort());
  expect([...loaded.values()].every(Boolean)).toBe(true);
});
