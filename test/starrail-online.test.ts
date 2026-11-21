import { expect, test } from "bun:test";
import type { ProfileRequestContext } from "@lotus-yunzai/account";
import { createHoyoClient } from "@lotus-yunzai/hoyo-client";

const uid = "100000732", ticket = "fixture-online";
const source = {
  qq: "42", profileId: 2, game: "sr", revision: "fixture",
  role: { uid, region: "prod_gf_cn", gameBiz: "hkrpg_cn" },
  device: {},
  account: { stuid: "42", ltuid: "42", stoken: "fixture-token", stokenCookie: "", mid: "", cookie: "cookie_token=fixture-game; account_id=42" },
} as ProfileRequestContext;
const response = (data: unknown, retcode = 0) => Response.json({ retcode, data });
const row = { time: "2025-12-31 23:59:00", action: "随时间回复开拓力", add_num: 1, marker: "not-projected" };

test("在线时长用一次本人短票串行读旧 50 行页到空，保留自然恢复和合法批量", async () => {
  const stages: string[] = [];
  const client = createHoyoClient(async (url, init) => {
    expect(url.origin).toBe("https://api-takumi.mihoyo.com");
    if (init.method === "POST") {
      stages.push("ticket");
      expect(JSON.parse(String(init.body))).toEqual({ auth_appid: "csc", game_biz: "hkrpg_cn", game_uid: Number(uid), region: "prod_gf_cn" });
      return response({ authkey: ticket, game_uid: uid });
    }
    expect(url.pathname).toBe("/common/hkrpg_self_help_inquiry/Power/GetList");
    expect(url.searchParams.get("authkey")).toBe(ticket);
    expect(url.searchParams.get("page_size")).toBe("50");
    expect(new Headers(init.headers).has("Cookie")).toBe(false);
    const page = url.searchParams.get("page")!;
    stages.push(page);
    return response({ page, list: page === "1" ? [row, { ...row, action: "其他回复" }] :
      page === "2" ? [{ ...row, time: "2025-12-31 23:50:00", add_num: "8" }] : [] });
  });
  const result = await client.fetchStarRailOnline(source, { intervalMs: 0 });
  expect(stages).toEqual(["ticket", "1", "2", "3"]);
  expect(result.complete).toBe(true);
  expect(result.recoveries).toEqual([{ time: row.time, count: 1 }, { time: "2025-12-31 23:50:00", count: 8 }]);
});

test("重复页、错账号和后续失败不交付片段，达到上限明确为不完整", async () => {
  let behavior: "repeat" | "wrong" | "failure" = "repeat";
  const client = createHoyoClient(async (url, init) => {
    if (init.method === "POST") return response({ authkey: ticket });
    const page = url.searchParams.get("page");
    if (page === "1" || behavior === "repeat") return response({ list: [row] });
    if (behavior === "wrong") return response({ uid: "100000733", list: [] });
    return response({}, 429);
  });
  expect((await client.fetchStarRailOnline(source, { intervalMs: 0, maxPages: 1 })).complete).toBe(false);
  await expect(client.fetchStarRailOnline(source, { intervalMs: 0 })).rejects.toThrow("重复页");
  behavior = "wrong";
  await expect(client.fetchStarRailOnline(source, { intervalMs: 0 })).rejects.toMatchObject({ code: "response" });
  behavior = "failure";
  await expect(client.fetchStarRailOnline(source, { intervalMs: 0 })).rejects.toMatchObject({ code: "api" });
});

test("关闭当前会话可中止后续页", async () => {
  const controller = new AbortController();
  const stages: string[] = [];
  const client = createHoyoClient(async (url, init) => {
    if (init.method === "POST") { stages.push("ticket"); return response({ authkey: ticket }); }
    stages.push(url.searchParams.get("page")!);
    setTimeout(() => controller.abort(), 20);
    return response({ list: [row] });
  });
  const operation = client.fetchStarRailOnline(source, { signal: controller.signal, intervalMs: 500 });
  await expect(operation).rejects.toBeDefined();
  expect(stages).toEqual(["ticket", "1"]);
});
