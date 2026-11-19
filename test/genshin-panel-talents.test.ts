import { expect, test } from "bun:test";
import { matchGenshinPanel, readPanel } from "../plugins/genshin/panel/model.ts";
import { buildPanelStatistics, buildTalentStatistics, talentStatisticsDay } from "../plugins/genshin/panel/statistics.ts";
import type { PanelTheme } from "../plugins/genshin/panel/theme.ts";

const tuesday = Date.parse("2026-11-17T04:00:00+08:00");
const family = (name: string, type: "talent" | "weekly") => ({ name, type, star: type === "talent" ? 4 : 5 });
const materials = {
  "芙宁娜": { talent: "「正义」的哲学", weekly: "无光质块" },
  "芭芭拉": { talent: "「自由」的哲学", weekly: "北风之环" },
  "旅行者": { talent: "「秩序」的哲学", weekly: "生长天地之蕨草" },
  "胡桃": { talent: "「未知」的哲学", weekly: "未记载周本" },
};

const theme: PanelTheme = {
  characters: {},
  artifacts: new Map(),
  artifactSets: new Map(),
  async picture() { return undefined; },
  async metadata(...parts) {
    if (parts[1] === "material") {
      return Object.fromEntries(Object.values(materials).flatMap(row => [[row.talent, family(row.talent, "talent")],
        ...(row.weekly === "未记载周本" ? [] : [[row.weekly, family(row.weekly, "weekly")]])]));
    }
    if (parts[1] === "character") return { materials: materials[parts[2] as keyof typeof materials] };
    return {};
  },
};

test("原神旧天赋统计选择日期、星级和档案并避开攻略与图鉴", () => {
  expect(matchGenshinPanel("#原神我的今日五星天赋统计 档案2")).toMatchObject({
    type: "statistics", profileId: 2, talentStatistics: { day: "today", star: 5 },
  });
  expect(matchGenshinPanel("#明日技能汇总2")?.talentStatistics?.day).toBe("tomorrow");
  expect(matchGenshinPanel("#周六4星天赋列表")?.talentStatistics).toEqual({ day: 6, star: 4 });
  expect(matchGenshinPanel("#周天天赋")?.talentStatistics?.day).toBe(7);
  expect(matchGenshinPanel("#天赋统计100123456")?.uid).toBe("100123456");
  for (const message of ["#芙宁娜天赋图鉴", "#原神养成计算 芙芙 天赋10 10 10", "#星铁天赋统计", "#天赋统计256"]) {
    expect(matchGenshinPanel(message)).toBeUndefined();
  }
});

test("北京时间 04:00 翻日，明日按游戏日推算，周日开放所有已确认分组", () => {
  expect(talentStatisticsDay({ day: "today" }, tuesday - 1)).toEqual({ today: 1, selected: 1, label: "周一" });
  expect(talentStatisticsDay({ day: "today" }, tuesday)).toEqual({ today: 2, selected: 2, label: "周二" });
  expect(talentStatisticsDay({ day: "tomorrow" }, tuesday - 1)).toEqual({ today: 1, selected: 2, label: "周二" });
  expect(talentStatisticsDay({ day: "today" }, Date.parse("2026-11-22T04:00:00+08:00"))).toEqual({ today: 7, selected: 7, label: "周日" });
});

test("旧米游社记录使用当地书籍和周本，未知开放日不会进入指定工作日", async () => {
  const uid = "100123456";
  const snapshot = readPanel(uid, { uid, avatars: {
    10000007: { id: 10000007, name: "荧", star: 5, level: 85, elem: "hydro", _source: "mys" },
    10000014: { id: 10000014, name: "芭芭拉", star: 4, level: 85, elem: "hydro", _source: "mys" },
    10000046: { id: 10000046, name: "胡桃", star: 5, level: 80, elem: "pyro", _source: "mys" },
    10000089: { id: 10000089, name: "芙宁娜", star: 5, level: 90, elem: "hydro", _source: "mys", talent: { a: 9 } },
  } }, theme, true, true)!;
  const stats = await buildPanelStatistics(snapshot, theme, undefined, false);
  const current = await buildTalentStatistics(stats, theme, { day: "today", star: 5 }, tuesday);
  expect(current.rows.map(row => row.avatar.name)).toEqual(["芙宁娜"]);
  expect(current.rows[0]?.materials).toMatchObject({
    weekly: { name: "无光质块", icon: "meta-gs/material/weekly/无光质块.webp" },
    talent: { name: "正义", region: "枫丹", days: "周二/周五", icon: "meta-gs/material/talent/「正义」的哲学.webp" },
    open: true,
  });
  const tomorrow = await buildTalentStatistics(stats, theme, { day: "tomorrow" }, tuesday);
  expect(tomorrow.rows.map(row => row.avatar.name)).toEqual(["荧"]);
  expect(tomorrow.rows[0]?.materials).toMatchObject({ talent: { name: "秩序" }, open: false });
  const saturday = await buildTalentStatistics(stats, theme, { day: 6, star: 4 }, tuesday);
  expect(saturday.rows).toEqual([]);
  const sunday = await buildTalentStatistics(stats, theme, { day: "today" }, Date.parse("2026-11-22T04:00:00+08:00"));
  expect(sunday.rows).toHaveLength(4);
  expect(sunday.rows.at(-1)?.materials).toMatchObject({ talent: { name: "未知", days: undefined }, weekly: undefined, open: false });
});
