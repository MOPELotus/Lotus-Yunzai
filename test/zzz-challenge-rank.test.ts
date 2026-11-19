import { expect, test } from "bun:test";
import { normalizeZzzDeadly, normalizeZzzShiyu } from "@lotus-yunzai/hoyo-client";
import { rankCommand, rankRow, sortedRankRows, type RankMode, type RankProfile, type RankRow } from "../plugins/zzz/challenge-rank-model.ts";
import { parseRankConfig } from "../plugins/zzz/challenge-rank-store.ts";

const role = { qq: "42", profileId: 1, uid: "12345678", region: "prod_gf_cn", nickname: "合成绳匠" } satisfies RankProfile;
const identity = { uid: role.uid, region: role.region, scheduleType: 1 as const };
const start = { year: 2026, month: 11, day: 20, hour: 4, minute: 0, second: 0 };
const end = { ...start, day: 30 };
const firstMillis = Date.parse("2026-11-20T04:00:00+08:00");
const lastMillis = Date.parse("2026-11-30T04:00:00+08:00");
const now = Date.parse("2026-11-24T00:00:00+08:00");

test("绝区零旧式舆、危局和绝境群榜别名与可见开关归入正确模式", () => {
  for (const [name, mode] of [
    ["%式舆防卫战排名", "ABYSS"], ["％深渊排名", "ABYSS"], ["/zzz防卫排名", "ABYSS"],
    ["#绝区零危局强袭战排名", "DEADLY"], ["#ZZZ强袭排名", "DEADLY"],
    ["%绝境排名", "DEADLY_HARD"], ["%绝境强袭排名", "DEADLY_HARD"],
    ["#绝区零zzz危局绝境排名", "DEADLY_HARD"],
  ] as const) expect(rankCommand(name)).toEqual({ kind: "board", mode });
  expect(rankCommand("%取消显示深渊群内排名2")).toEqual({ kind: "visibility", enabled: false, profileId: 2, types: ["ABYSS"] });
  expect(rankCommand("%显示危局绝境排名")).toEqual({ kind: "visibility", enabled: true, profileId: 1, types: ["DEADLY"] });
  expect(rankCommand("/zzzoff排名")).toEqual({ kind: "visibility", enabled: false, profileId: 1, types: ["ABYSS", "DEADLY"] });
  for (const input of ["%深渊", "%危局图鉴", "危局排名", "%上期危局排名", "%临界推演排名", "%显示排名256"]) {
    expect(rankCommand(input)).toBeUndefined();
  }
});

test("榜单设置沿用旧黑白名单与 1 至 15 名的上限", () => {
  expect(parseRankConfig(undefined, "77")).toEqual({ allowed: true, maximum: 15 });
  expect(parseRankConfig({ allow_group: false, white_list: [77], black_list: [77], max_display: 0 }, "77"))
    .toEqual({ allowed: true, maximum: 1 });
  expect(parseRankConfig({ allow_group: true, white_list: [77], black_list: ["77"], max_display: 55 }, "77"))
    .toEqual({ allowed: false, maximum: 15 });
  expect(parseRankConfig({ allow_group: 0, white_list: [], max_display: "3" }, "77"))
    .toEqual({ allowed: false, maximum: 3 });
  expect(() => parseRankConfig({ allow_group: "false" }, "77")).toThrow();
});

test("式舆榜只收本期第五防线并按比分、评级、时间排序，统计周期边界沿用北京时间", () => {
  const source = {
    hadal_ver: "v2", hadal_info_v2: {
      hadal_begin_time: start, hadal_end_time: end, brief: { score: 150000, rating: "S+" },
      fitfh_layer_detail: { layer_challenge_info_list: [
        { score: 50000, challenge_time: { ...start, day: 21 } }, { score: 50000, challenge_time: { ...start, day: 23 } },
      ] },
    },
  };
  const record = normalizeZzzShiyu(source, identity);
  expect(rankRow("ABYSS", role, record, firstMillis - 1, "current")).toBeUndefined();
  expect(rankRow("ABYSS", role, record, lastMillis + 1, "current")).toBeUndefined();
  expect(rankRow("ABYSS", role, { ...record, scheduleType: 2 }, now, "current")).toBeUndefined();
  expect(rankRow("ABYSS", role, { ...record, layers: [] }, now, "current")).toBeUndefined();
  expect(rankRow("ABYSS", role, record, firstMillis, "current")?.score).toBe(150000);
  const entry = rankRow("ABYSS", role, record, lastMillis, "current")!;
  expect(entry.latest).toBe(Date.parse("2026-11-23T04:00:00+08:00"));
  expect(entry.bonus).toBe(5);
  expect(sortedRankRows("ABYSS", [
    { ...entry, nickname: "同评级更晚", latest: entry.latest + 100 },
    { ...entry, nickname: "较低评级", bonus: 4, latest: entry.latest - 100 },
    { ...entry, nickname: "同评级较早" },
    { ...entry, nickname: "更低分", score: 149999 },
  ]).map(row => row.nickname)).toEqual(["同评级较早", "同评级更晚", "较低评级", "更低分"]);
});

test("危局试炼先比较星级，绝境合计真实分数，缺绝境或错角色无绝境成绩", () => {
  const record = normalizeZzzDeadly({
    has_data: true, start_time: start, end_time: end, total_score: 163000, total_star: 7,
    list: [{ score: 65000 }, { score: 50000 }, { score: 48000 }],
    has_hard: true, hard_list: [{ score: 50000 }, { score: 10000 }],
  }, identity);
  expect(rankRow("DEADLY_HARD", role, record, now, "current")?.score).toBe(60000);
  expect(rankRow("DEADLY_HARD", role, { ...record, hard: [{ avatars: [] }] }, now, "current")).toBeUndefined();
  expect(rankRow("DEADLY_HARD", role, { ...record, hard: [] }, now, "current")).toBeUndefined();
  expect(rankRow("DEADLY", { ...role, region: "prod_qd_cn" }, record, now, "current")).toBeUndefined();
  const row = rankRow("DEADLY", role, record, now, "current")!;
  for (const mode of ["DEADLY", "DEADLY_HARD"] as const satisfies readonly RankMode[]) {
    const players: readonly RankRow[] = [row, { ...row, bonus: 8, score: 140000 }];
    expect(sortedRankRows(mode, players)[0]?.score).toBe(mode === "DEADLY" ? 140000 : 163000);
  }
});
