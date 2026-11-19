import { expect, test } from "bun:test";
import { fetchRankStats, matchRankStats, readRankStatsPayload } from "../plugins/genshin/rank-statistics/stats.ts";

const damage = { retcode: 100, data: { total: 41, name: "召唤物伤害", scores: [420, 405, 391, 365, 311, 300, 215, "40", 16, 0] } };
const artifact = { retcode: 100, data: { total: 23, name: "圣遗物评分", scores: Array(10).fill(10) } };
const result = { stats: { total: 41, title: "召唤物伤害", scores: [420, 405, 391, 365, 311, 300, 215, 40, 16, 0] } };

test("Ark 旧统计入口只识别原神角色和别名", () => {
  for (const message of ["#芙宁娜排名统计", "#原神芙芙排名统计", "#10000089排名统计"]) {
    expect(matchRankStats(message)?.id).toBe(10000089);
  }
  for (const message of ["#芙宁娜面板", "#芙宁娜伤害2", "#芙宁娜圣遗物排行", "#星铁卡芙卡排名统计", "#幽境危战排名统计"]) {
    expect(matchRankStats(message)).toBeUndefined();
  }
});

test("Ark 旧单对象和双数组正确保留伤害样本及已知零值", () => {
  expect(readRankStatsPayload(damage)).toEqual(result);
  expect(readRankStatsPayload([artifact, damage])).toEqual(result);
  expect(readRankStatsPayload({ retcode: 100, data: { total: 0 } })).toEqual({ message: "暂无此角色的伤害排名样本。" });
  expect(readRankStatsPayload({ retcode: 100, data: { ...damage.data, scores: [1, 2] } }))
    .toEqual({ message: "排名服务返回的伤害排名统计不完整。" });
  expect(readRankStatsPayload([artifact, { retcode: 104 }])).toEqual({ message: "排名查询过于频繁，请稍后重试。" });
});

test("Ark 固定公开端点，仅发送角色编号、百分位和版本", async () => {
  const signal = new AbortController().signal;
  let called = 0;
  expect(await fetchRankStats(10000089, signal, async (url, init) => {
    called++;
    expect(url).toBe("https://ark.ivny.cn/rank/specific");
    expect(init).toMatchObject({ method: "POST", credentials: "omit", redirect: "error" });
    expect(new Headers(init.headers).get("authorization")).toBeNull();
    expect(new Headers(init.headers).get("cookie")).toBeNull();
    expect(JSON.parse(String(init.body))).toEqual({ id: 10000089, percent: 0, version: "2.1.0" });
    return Response.json([artifact, damage]);
  })).toEqual(result);
  expect(await fetchRankStats(8001, signal, async () => { called++; throw new Error("unexpected"); }))
    .toEqual({ message: "此角色没有有效的原神角色编号。" });
  expect(called).toBe(1);
  expect(await fetchRankStats(10000089, signal, async () => new Response("", { status: 429 })))
    .toEqual({ message: "排名查询过于频繁，请稍后重试。" });
});
