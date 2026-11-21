import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ProfileRequestContext } from "@lotus-yunzai/account";
import { HoyoRequestError } from "@lotus-yunzai/hoyo-client";
import { normalizeZzzExploration, readZzzExploration, splitZzzExploration } from "../packages/hoyo-client/zzz-exploration.ts";

const identity = { uid: "12345678", region: "prod_gf_cn" };
const source = {
  qq: "42", profileId: 1, game: "zzz", revision: "fixture-revision",
  account: { cookie: "cookie_token=fixture-cookie" }, device: { id: "fixture-device", fp: "fixture-fp" },
  role: { ...identity, gameBiz: "nap_cn" },
} as ProfileRequestContext;
const icon = "https://act-webstatic.mihoyo.com/fixture/collection.webp";
const map = { name: "地图甲", icon, collection_progress: "31.50",
  collections: [{ name: "甲", icon, num: 0, total: 5 }, { name: "乙", total: "7" },
    { name: "丙", num: 0, total: 0 }, { name: "丁" }, { name: "模板不展示的第五项" }] };
const fixture = { uid: identity.uid, region: identity.region, area_collections: [
  { name: "区域甲", collection_progress: 0, map_collections: [map, { name: "地图乙" }] }, { name: "空区域" },
] };

test("区域收集保持组与地图顺序、收集项和小数精度，区分零和缺字段", () => {
  expect(normalizeZzzExploration(fixture, identity)).toMatchObject({ status: "available", page: 1, pageCount: 1, areas: [
    { name: "区域甲", progress: "0", continued: false, maps: [
      { name: "地图甲", progress: "31.50", icon, collections: [
        { name: "甲", icon, current: 0, maximum: 5 }, { name: "乙", current: undefined, maximum: 7 },
        { name: "丙", current: 0, maximum: 0 }, { name: "丁", current: undefined, maximum: undefined },
      ] }, { name: "地图乙", progress: undefined, collections: [] },
    ] },
    { name: "空区域", progress: undefined, maps: [] },
  ] });
});

test("区域页码只解码当前部分，保留原区域名称与末地图，拒绝跨档响应", () => {
  const data = { area_collections: [
    { name: "同一区", map_collections: Array.from({ length: 24 }, (_, index) => ({ name: `地图 ${index + 1}` })) },
    { name: "下一区", map_collections: [{ name: "最后地图" }] },
  ] };
  expect(normalizeZzzExploration(data, identity)).toMatchObject({ pageCount: 2,
    areas: [{ continued: false, maps: Array.from({ length: 21 }, (_, index) => ({ name: `地图 ${index + 1}` })) }] });
  expect(normalizeZzzExploration(data, identity, 2)).toMatchObject({ pageCount: 2, areas: [
    { name: "同一区", continued: true, maps: [{ name: "地图 22" }, { name: "地图 23" }, { name: "地图 24" }] },
    { name: "下一区", continued: false, maps: [{ name: "最后地图" }] },
  ] });
  expect(normalizeZzzExploration(data, identity, 3)).toMatchObject({ pageCount: 2, areas: [] });
  for (const input of [{ ...fixture, uid: "23456789" }, { ...fixture, region: "prod_qd_cn" },
    { area_collections: [{ collection_progress: "100.1" }] }, { area_collections: true }]) {
    expect(() => normalizeZzzExploration(input, identity)).toThrow(HoyoRequestError);
  }
});

test("完整视图和超限分段复用同一已核验响应，显式页沿用旧分页", async () => {
  const data = { ...identity, area_collections: [
    { name: "甲", map_collections: Array.from({ length: 24 }, (_, index) => ({ name: `地图 ${index + 1}` })) },
    { name: "空区域" }, { name: "乙", map_collections: [{ name: "末地图" }] },
  ] };
  let requests = 0;
  const transport = async () => {
    requests++;
    return Response.json({ retcode: 0, data });
  };
  const full = await readZzzExploration(source, transport, { whole: true });
  expect(full).toMatchObject({ ...identity, page: 1, pageCount: 1 });
  expect(full.areas.map(area => area.maps.length)).toEqual([24, 0, 1]);
  expect(splitZzzExploration(full)).toEqual([
    normalizeZzzExploration(data, identity, 1),
    normalizeZzzExploration(data, identity, 2),
  ]);
  expect(splitZzzExploration(full, 3).flatMap(part => part.areas.flatMap(area => area.maps.map(map => map.name)))).toEqual(
    full.areas.flatMap(area => area.maps.map(map => map.name)));
  expect(requests).toBe(1);
  expect(await readZzzExploration(source, transport, { whole: true, page: 2 })).toEqual(normalizeZzzExploration(data, identity, 2));
  expect(await readZzzExploration(source, transport, {})).toEqual(normalizeZzzExploration(data, identity, 1));
});

test("区域收集固定 GET 仅签 uid、region，翻页参数不离开宿主", async () => {
  let guarded = 0;
  const result = await readZzzExploration(source, async (url, init) => {
    expect(url.href).toBe("https://api-takumi-record.mihoyo.com/event/game_record_zzz/api/zzz/exploration_detail?uid=12345678&region=prod_gf_cn");
    expect(init).toMatchObject({ method: "GET", redirect: "error", credentials: "omit" });
    expect(init.body).toBeUndefined();
    const headers = new Headers(init.headers);
    expect(headers.get("Cookie")).toBe("cookie_token=fixture-cookie");
    expect(headers.get("x-rpc-device_id")).toBe("fixture-device");
    expect(headers.get("x-rpc-device_fp")).toBe("fixture-fp");
    const [t, r, hash] = headers.get("DS")!.split(",");
    expect(hash).toBe(createHash("md5").update(`salt=xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs&t=${t}&r=${r}&b=&q=${url.search.slice(1)}`).digest("hex"));
    return Response.json({ retcode: 0, data: null });
  }, { page: 2 }, async () => { guarded++; });
  expect(result).toMatchObject({ status: "empty", areas: [], page: 2 });
  expect(guarded).toBe(2);
});
