import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProfileRequestContext } from "../packages/account/index.ts";
import { lockFile } from "../lib/file-lock.ts";
import { matchGenshinPanel, officialPanel, readPanel } from "../plugins/genshin/panel/model.ts";
import { createGenshinPanelQuery } from "../plugins/genshin/panel/panel.ts";
import { buildPanelStatistics } from "../plugins/genshin/panel/statistics.ts";
import type { PanelTheme } from "../plugins/genshin/panel/theme.ts";

const uid = "100123456";
const role = { uid, nickname: "", gameBiz: "hk4e_cn", region: "cn_gf01", chosen: true };
const theme: PanelTheme = {
  characters: {
    10000007: { name: "荧", star: 5, elem: "multi", weapon: "sword", talentCons: { e: 5, q: 3 } },
    10000046: { name: "胡桃", star: 5, elem: "pyro", weapon: "polearm", talentCons: { e: 5, q: 3 } },
    10000089: { name: "芙宁娜", star: 5, elem: "hydro", weapon: "sword", talentCons: { e: 5, q: 3 } },
    10000114: { name: "丝柯克", star: 5, elem: "cryo", weapon: "sword", talentCons: { e: 3, q: 5 } },
  },
  artifacts: new Map(),
  artifactSets: new Map([["黄金乐曲的变奏", "黄金剧团"], ["黄金飞鸟的落羽", "黄金剧团"]]),
  async metadata(...parts) {
    return parts[2] === "sword" ? { "11513": { name: "静水流涌之辉", star: 5, abbr: "静水" } } : {};
  },
  async picture() { return undefined; },
};
const basic = { id: 10000089, name: "芙宁娜", level: 90, cons: 5, _source: "mys", talent: { a: 10, e: 10, q: 9 },
  weapon: { name: "静水流涌之辉", level: 90, affix: 1 },
  mysArtis: { 1: { name: "黄金乐曲的变奏", level: 20, star: 5 }, 2: { name: "黄金飞鸟的落羽", level: 20, star: 5 } },
};
const legacy = { uid, avatars: {
  10000046: { id: 10000046, name: "胡桃", level: 90, cons: 6, _source: "enka", talent: { a: 8, e: 9, q: 9 } },
  10000089: basic,
  10000007: { id: 10000007, name: "荧", level: 90, elem: "hydro", cons: 3, _source: "enka", talent: { e: 9, q: 9 } },
} };

test("原神练度统计兼容旧命令，档案与 UID 不混淆", () => {
  expect(matchGenshinPanel("#练度统计")).toEqual({ type: "statistics", profileId: 1 });
  expect(matchGenshinPanel("#原神面板练度统计 档案2")).toEqual({ type: "statistics", profileId: 2 });
  expect(matchGenshinPanel(`#面板练度统计${uid}`)).toEqual({ type: "statistics", profileId: 1, uid });
  expect(matchGenshinPanel("#202611剧诗练度统计")).toEqual({ type: "statistics", profileId: 1, theaterMonth: "202611" });
  for (const message of ["#星铁练度统计", "#练度统计256", "#角色统计", "#芙芙排名统计"]) {
    expect(matchGenshinPanel(message)).toBeUndefined();
  }
});

test("旧米游社简档仅在统计中读取，沿旧天赋顺序显示原级与加成", async () => {
  expect(readPanel(uid, legacy, theme, true)?.avatars["10000089"]).toBeUndefined();
  const panel = readPanel(uid, legacy, theme, true, true)!;
  const result = await buildPanelStatistics(panel, theme);
  expect(result.map(row => row.avatar.id)).toEqual([10000089, 10000046, 10000007]);
  expect(result[0]).toMatchObject({
    talents: [{ original: 10, level: 10 }, { original: 10, level: 13 }, { original: 9, level: 12 }],
    sets: ["黄金剧团"], weapon: { abbr: "静水", star: 5 }, rating: undefined,
  });
  expect(result[2]).toMatchObject({ fetter: 10, talents: [undefined, { original: 9, level: 12 }, { original: 9, level: 9 }] });

  const official = officialPanel(uid, [
    { base: { id: 10000114, level: 90, element: "Cryo", actived_constellation_num: 3 },
      skills: [10, 14, 10].map(level => ({ skill_type: 1, level })) },
  ], theme, 3000);
  const [skirk] = await buildPanelStatistics(readPanel(uid, official, theme)!, theme);
  expect(skirk?.talents).toEqual([{ original: 10, level: 10 }, { original: 10, level: 14 }, { original: 10, level: 10 }]);
});

test("统计实时重新核对同一绑定，查询不给米游社发送请求或写旧档", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lotus-genshin-statistics-"));
  const archiveDirectory = join(dir, "new");
  const legacyDirectory = join(dir, "old");
  await mkdir(legacyDirectory);
  const path = join(legacyDirectory, uid + ".json");
  const original = JSON.stringify(legacy);
  await writeFile(path, original);
  let revision = "initial";
  let changeDuringRender = false;
  let fetches = 0;
  try {
    const png = Buffer.from("test");
    const query = createGenshinPanelQuery({
      async savedRole() { return role; },
      async requestContext(qq, profileId, game) {
        return { qq, profileId, game, role, revision } as ProfileRequestContext;
      },
    }, { async fetchGenshinPanel() { fetches++; throw new Error("Unexpected network"); } },
    lockFile, new AbortController().signal, {
      archiveDirectory, legacyDirectory, theme: async () => theme,
      render: {
        async list() { throw new Error("Wrong renderer"); },
        async detail() { throw new Error("Wrong renderer"); },
        async statistics(panel, rows, _theme, options) {
          expect(panel.uid).toBe(uid);
          expect(rows.map(row => row.avatar.id)).toEqual([10000089, 10000046, 10000007]);
          expect(options?.offset).toBe(0);
          if (changeDuringRender) revision = "different";
          return { png };
        },
      },
    });
    expect(await query("#面板练度统计2", { user_id: 42 })).toEqual({ type: "image", file: png });
    expect(await query("#面板练度统计100999999", { user_id: 42 })).toContain("与当前档案绑定");
    changeDuringRender = true;
    expect(await query("#练度统计", { user_id: 42 })).toContain("档案已变化");
    expect(fetches).toBe(0);
    expect(await readFile(path, "utf8")).toBe(original);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
