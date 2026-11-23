import { expect, test } from "bun:test";
import { queryStygianRank } from "../lib/stygian-rank.ts";

const signal = new AbortController().signal;
const first = "100000001";
const second = "100000002";
const arkRow = { hard: 6, time: 124, rank: 10, sum: 210 };

test("Ark 群榜只向原服务发送授权 UID 和客户端版本", async () => {
  const result = await queryStygianRank("ark", [first, second, first], undefined, signal, async (url, init) => {
    expect(url).toBe("https://ark.ivny.cn/rank/stygian");
    expect(init).toMatchObject({ method: "POST", credentials: "omit", redirect: "error" });
    expect(new Headers(init.headers).has("authorization")).toBe(false);
    expect(new Headers(init.headers).has("cookie")).toBe(false);
    expect(JSON.parse(String(init.body))).toEqual({ uid: [first, second], version: "2.1.0" });
    return Response.json({ retcode: 100, data: [{ uid: second, ...arkRow }, { uid: first, ...arkRow, rank: 32 }] });
  });
  expect(result).toEqual({ status: "ok", rows: [
    { uid: second, difficulty: 6, seconds: 124, rank: 10, total: 210 },
    { uid: first, difficulty: 6, seconds: 124, rank: 32, total: 210 },
  ] });
});

test("旧 Ark 单条无 UID 回包可归属，批量无身份、重复和异 UID 均拦截", async () => {
  const query = (uids: string[], data: unknown) =>
    queryStygianRank("ark", uids, undefined, signal, async () => Response.json({ retcode: 100, data }));
  expect(await query([first], [arkRow])).toMatchObject({ status: "ok", rows: [{ uid: first }] });
  expect(await query([first, second], [arkRow, arkRow])).toEqual({ status: "unverified" });
  expect(await query([first, second], [{ ...arkRow, uid: "100000081" }])).toEqual({ status: "unverified" });
  expect(await query([first, second], [{ ...arkRow, uid: first }, { ...arkRow, uid: first }])).toEqual({ status: "unverified" });
  expect(await query([first], [{ ...arkRow, hard: 7, uid: first }])).toEqual({ status: "ok", rows: [] });
});

test("Akasha 当前与旧期使用明确版本，只发送自己的授权批次，总数请求不带任何 UID", async () => {
  const requests: URL[] = [];
  const result = await queryStygianRank("akasha", [first], "6.1", signal, async (input, init) => {
    const url = new URL(input);
    requests.push(url);
    expect(url.origin + url.pathname).toBe("https://akasha.cv/api/leaderboards/stygian");
    expect(url.searchParams.get("version")).toBe("6_1");
    expect(url.searchParams.get("uid")).toBe("");
    expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "error" });
    expect(new Headers(init.headers).has("cookie")).toBe(false);
    if (url.searchParams.get("size") === "1") {
      expect(url.searchParams.get("uids")).toBe("");
      return Response.json({ data: [{ index: 11000 }] });
    }
    expect(url.searchParams.get("uids")).toBe(`[uid]${first}`);
    return Response.json({ data: [{ uid: first, stygianIndex: 5, stygianSeconds: 77, index: 113 }] });
  });
  expect(requests).toHaveLength(2);
  expect(result).toEqual({ status: "ok", rows: [{ uid: first, difficulty: 5, seconds: 77, rank: 113, total: 11000 }] });
});

test("无授权、错误期数和无效 UID 不出站，站点封锁结果与空榜区分", async () => {
  let unexpectedCalls = 0;
  const unexpected = async () => { unexpectedCalls++; return new Response(); };
  expect(await queryStygianRank("akasha", [], "6.1", signal, unexpected)).toEqual({ status: "ok", rows: [] });
  expect(await queryStygianRank("akasha", ["0"], "6.1", signal, unexpected)).toEqual({ status: "unverified" });
  expect(await queryStygianRank("akasha", [first], "6_1", signal, unexpected)).toEqual({ status: "unverified" });
  expect(await queryStygianRank("ark", [first], "6.1", signal, unexpected)).toEqual({ status: "unavailable" });
  expect(unexpectedCalls).toBe(0);
  expect(await queryStygianRank("ark", [first], undefined, signal,
    async () => Response.json({ retcode: 102 }))).toEqual({ status: "ok", rows: [] });
  expect(await queryStygianRank("akasha", [first], "6.1", signal,
    async () => new Response("Forbidden", { status: 403 }))).toEqual({ status: "unavailable" });
  const controller = new AbortController();
  expect(await queryStygianRank("ark", [first], undefined, controller.signal, async () => {
    controller.abort();
    return Response.json({ retcode: 100, data: [arkRow] });
  })).toEqual({ status: "unavailable" });
});
