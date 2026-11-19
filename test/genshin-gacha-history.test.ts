import { expect, test } from "bun:test";
import { genshinGachaPools, type GenshinGachaPool, type GenshinGachaRow } from "../packages/hoyo-client/genshin-gacha.ts";
import { mergeGenshinGachaHistory, type GenshinGachaSnapshot } from "../plugins/genshin/gacha-history.ts";

const uid = "512345678";
const region = "cn_qd01";
const older = "9223372036854775807";
const overlap = "17358538100000019221";
const next = "17358538100000019222";

function snapshot(pools: Partial<Record<GenshinGachaPool, GenshinGachaRow[]>> = {}): GenshinGachaSnapshot {
  return { uid, region, pools: genshinGachaPools.map((pool) => ({ ...pool, records: pools[pool.type] ?? [] })) };
}

function current(id: string, gacha_type: GenshinGachaRow["gacha_type"], info: object = {}): GenshinGachaRow {
  return { id, uid, gacha_type, ...info };
}

test("原神四池保留官方窗口外的旧记录和字段，长 ID 去重并精确降序", () => {
  // The legacy files contain raw arrays, with UID optional in records from old imports.
  const legacyCharacter = { id: `00${overlap}`, uid, gacha_type: "400", uigf_gacha_type: "301", name: "旧条目名称",
    item_id: "10000001", rank_type: "5", time: "2022-03-01 12:00:00", item_type: "角色", imported: { version: 2 } };
  const outsideWindow = { id: older, gacha_type: 301, name: "窗口外角色", item_type: "角色", rank_type: "5" };
  const oldWeapon = { id: 10, uid: Number(uid), gacha_type: "302", name: "旧武器", remark: "保留" };
  const previous = {
    301: Object.freeze([outsideWindow, legacyCharacter, { id: overlap, uid, gacha_type: "400", name: "被去重旧条目" }]),
    302: Object.freeze([oldWeapon]),
  };
  const recent = snapshot({
    301: [current(overlap, "400", { name: "这次名称", rank_type: "5" }), current(next, "301", { name: "新角色" }),
      current(next, "301", { name: "同编号重复角色" })],
    302: [current("00010", "302", { name: "不覆盖旧武器" }), current("100", "302", { name: "新武器" })],
    500: [current("1000", "500", { name: "集录条目" })],
  });
  const before = JSON.stringify({ previous, recent });
  const result = mergeGenshinGachaHistory(previous, recent, { uid, region });
  expect(result.uid).toBe(uid);
  expect(result.region).toBe(region);
  expect(result.records[301]).toEqual([recent.pools[0]!.records[1]!, legacyCharacter, outsideWindow]);
  expect(result.records[301][1]).toBe(legacyCharacter);
  expect(result.records[302]).toEqual([recent.pools[1]!.records[1]!, oldWeapon]);
  expect(result.records[500]).toEqual([recent.pools[2]!.records[0]!]);
  expect(result.records[200]).toEqual([]);
  expect(result.pools).toEqual([
    { ...genshinGachaPools[0], added: 1, total: 3, changed: true },
    { ...genshinGachaPools[1], added: 1, total: 2, changed: true },
    { ...genshinGachaPools[2], added: 1, total: 1, changed: true },
    { ...genshinGachaPools[3], added: 0, total: 0, changed: false },
  ]);
  expect(JSON.stringify({ previous, recent })).toBe(before);
});

test("完整空结果不删旧档案，返回的变更标记支持仅保存实际改变的池", () => {
  const previous = { 301: [{ id: next, uid, gacha_type: 400 }, { id: overlap, uid, gacha_type: "301" }], 302: [] };
  const empty = snapshot();
  empty.pools.reverse();
  const result = mergeGenshinGachaHistory(previous, empty);
  expect(result.records[301]).toEqual(previous[301]);
  expect(result.pools).toEqual(genshinGachaPools.map((pool) => ({ ...pool, added: 0,
    total: pool.type === 301 ? 2 : 0, changed: false,
  })));
  const unsorted = mergeGenshinGachaHistory({ 301: [...previous[301]].reverse() }, empty);
  expect(unsorted.records[301]).toEqual(previous[301]);
  expect(unsorted.pools[0]).toMatchObject({ added: 0, changed: true });
});

test("缺少、重复或未知卡池的部分响应不能与旧档案合并", () => {
  const complete = snapshot();
  const previous = { 301: [{ id: older, uid, gacha_type: "301" }] };
  const before = JSON.stringify(previous);
  const invalid = [
    { ...complete, pools: complete.pools.slice(0, 3) },
    { ...complete, pools: [...complete.pools.slice(0, 3), complete.pools[0]!] },
    { ...complete, pools: [...complete.pools.slice(0, 3), { type: 400, name: "未知", records: [] }] },
    { ...complete, pools: [...complete.pools.slice(0, 3), { type: 200, name: "常驻", records: undefined }] },
  ];
  for (const partial of invalid) {
    expect(() => mergeGenshinGachaHistory(previous, partial as unknown as GenshinGachaSnapshot)).toThrow(/卡池/u);
  }
  expect(() => mergeGenshinGachaHistory(previous, complete, { uid: "112345678" })).toThrow(/区服与档案/u);
  expect(() => mergeGenshinGachaHistory(previous, { ...complete, region: "cn_gf01" })).toThrow(/区服与档案/u);
  expect(JSON.stringify(previous)).toBe(before);
});

test("旧文件拒绝非数组、已失真编号和明确属于其他档案或卡池的条目", () => {
  for (const invalid of [{}, null, { list: [] }]) {
    expect(() => mergeGenshinGachaHistory({ 302: invalid }, snapshot())).toThrow(/JSON 数组/u);
  }
  expect(() => mergeGenshinGachaHistory({ 301: [{ id: Number(next), uid, gacha_type: "301" }] }, snapshot()))
    .toThrow(/精度不足/u);
  expect(() => mergeGenshinGachaHistory({ 301: [{ id: next, uid: "112345678", gacha_type: "301" }] }, snapshot()))
    .toThrow(/UID 与档案/u);
  expect(() => mergeGenshinGachaHistory({ 302: [{ id: next, uid, gacha_type: "400" }] }, snapshot()))
    .toThrow(/文件所属卡池/u);
  expect(() => mergeGenshinGachaHistory({}, snapshot({ 301: [current(next, "400", { uigf_gacha_type: "302" })] })))
    .toThrow(/标准卡池编号/u);
  expect(() => mergeGenshinGachaHistory({}, snapshot({ 500: [current(next, "500", { uid: undefined })] })))
    .toThrow(/UID 与档案/u);
});
