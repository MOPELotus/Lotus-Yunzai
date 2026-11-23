import { expect, test } from "bun:test";
import { arkPublicUid, createArkCustomRankSessions, queryArkCustomPanel, queryArkCustomRank, type ArkCustomRankQuery } from "../lib/ark-custom-rank.ts";
import type { RankStatsTransport } from "../lib/rank-statistics.ts";

const queryId = "ae91f10cb8209310723bc83231ddef34";
const uid = "100000042";
const requested = { game: "gs", characterId: 10000046, metric: "artifacts", count: 2,
  filters: [{ field: "cons", operator: 5, value: 1 }] } as const satisfies ArkCustomRankQuery;
const row = { uid, level: 90, cons: 0, talent_a: 10, weapon_name: "护摩之杖", weapon_affix: 1,
  dmg_avg: 1000, mark_score: 200, artisSet: { sets: { 炽烈的炎之魔女: 4 } } };

test("公开榜以匿名请求固定排序和筛选，保留上游行顺序及最小字段", async () => {
  const signal = new AbortController().signal;
  const other = "100000043";
  const fetchBoard: RankStatsTransport = async (url, request) => {
    expect(url).toBe("https://ark.ivny.cn/rank/custom");
    expect(request).toMatchObject({ method: "POST", credentials: "omit", redirect: "error" });
    expect(new Headers(request.headers).has("Authorization")).toBe(false);
    expect(JSON.parse(String(request.body))).toEqual({ game: "gs", charId: 10000046, version: "2.1.0",
      data: { rank: { col: "mark_score", order: "desc" }, filter: [{ type: "cons", rule: 5, value: 1 }], nums: 2 } });
    return Response.json({ retcode: 0, data: { charId: "10000046", dmgTitle: "有效伤害", query_id: queryId,
      rows: [{ ...row, uid: other, unrelated: "ignored" }, row] } });
  };
  const result = await queryArkCustomRank(requested, signal, undefined, fetchBoard);
  expect(result).toMatchObject({ queryId, title: "有效伤害", rows: [
    { uid: other, level: 90, cons: 0, talent: { a: 10 }, sets: { 炽烈的炎之魔女: 4 }, damage: 1000, score: 200 },
    { uid, weaponName: "护摩之杖", weaponRefinement: 1 },
  ] });
  const invalid: RankStatsTransport = async () => Response.json({ retcode: 0, data: {
    charId: 10000046, query_id: queryId, rows: [{ uid: "invalid" }, row],
  } });
  expect(await queryArkCustomRank(requested, signal, undefined, invalid)).toHaveProperty("message");
});

test("高级筛选只以授权请求提交，面板读取局限已确认名次", async () => {
  const signal = new AbortController().signal;
  const advanced = { ...requested, game: "sr", filters: [{ field: "pos4", operator: 1, value: 4 }] } as const;
  const never: RankStatsTransport = async () => { throw Error("输入校验不得外发请求"); };
  expect(await queryArkCustomRank(advanced, signal, undefined, never)).toHaveProperty("message");
  expect(await queryArkCustomPanel(queryId, 20, signal, undefined, never)).toHaveProperty("message");
  let called = 0;
  const request: RankStatsTransport = async (url, options) => {
    expect(new Headers(options.headers).get("Authorization")).toBe("Bearer test-only");
    const payload = JSON.parse(String(options.body));
    called++;
    if (url.endsWith("/specific")) {
      expect(payload).toEqual({ version: "2.1.0", query_id: queryId, index: 19 });
      return Response.json({ retcode: 0, data: { info: { uid: "10@@@@042", avatars: [{ id: 1102 }] } } });
    }
    expect(payload.data.filter).toEqual([{ type: "pos4", rule: 1, value: 4 }]);
    return Response.json({ retcode: 0, data: { charId: 10000046, query_id: queryId, rows: [row] } });
  };
  expect(await queryArkCustomRank(advanced, signal, "test-only", request)).toHaveProperty("queryId", queryId);
  expect(await queryArkCustomPanel(queryId, 19, signal, "test-only", request)).toEqual({ snapshot: { uid: "10****042", avatars: [{ id: 1102 }] } });
  expect(arkPublicUid("110@@@@042")).toBe("110****042");
  expect(arkPublicUid("10@@@@042")).not.toBe(arkPublicUid(uid));
  expect(arkPublicUid("10@*@*042")).toBeUndefined();
  expect(called).toBe(2);
});

test("仅在原协议、机器人和会话中引用已送达榜单，高级榜限定原发起者", () => {
  let time = 0;
  const sessions = createArkCustomRankSessions(() => time);
  const origin = { self_id: 99, user_id: 42, group_id: 77, message_type: "group" };
  const shared = { game: "gs", name: "胡桃", characterId: 10000046, queryId, count: 1, uids: ["10****042"] } as const;
  expect(sessions.find({ ...origin, reply_id: -6 })).toBeUndefined();
  sessions.remember(origin, -6, shared);
  expect(sessions.find({ ...origin, user_id: 43, reply_id: "-6" })).toEqual(shared);
  expect(sessions.find({ ...origin, group_id: 78, reply_id: -6 })).toBeUndefined();
  expect(sessions.find({ ...origin, adapter: "milky", reply_id: -6 })).toBeUndefined();
  expect(sessions.find({ ...origin, isDelegated: true, reply_id: -6 })).toBeUndefined();
  const milky = { ...origin, adapter: "milky" };
  sessions.remember(milky, 0, { ...shared, authorizedBy: 42 });
  expect(sessions.find({ ...milky, reply_id: 0 })?.authorizedBy).toBe(42);
  expect(sessions.find({ ...milky, reply_id: 0, user_id: 43 })).toBeUndefined();
  time = 300_000;
  expect(sessions.find({ ...origin, reply_id: -6 })).toBeUndefined();
});
