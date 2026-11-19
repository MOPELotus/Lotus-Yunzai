import { expect, test } from "bun:test";
import { mergeGenshinGachaHistory } from "../plugins/genshin/gacha-history.ts";
import {
  exportGenshinUigf, selectGenshinUigf, type GenshinUigfItemResolver,
} from "../plugins/genshin/gacha-uigf.ts";

const uid = "100000002";
const otherUid = "500000003";
const oldId = "1700000000000000001";
const newId = "1700000000000000002";
const itemId = "10000002";
const time = "2023-10-20 12:17:00";
const exportOptions = {
  uid, exportedAt: new Date("2023-11-01T08:09:10.125Z"), app: { name: "Lotus-Yunzai", version: "test" },
};

const ayaka = {
  itemId, name: "神里绫华", itemType: "角色" as const, rank: 5 as const,
};
const resolveItem: GenshinUigfItemResolver = (query) =>
  (query.itemId === itemId || (!query.itemId && query.name === ayaka.name)) ? ayaka : undefined;

function minimal(change: object = {}) {
  return { id: oldId, item_id: itemId, gacha_type: "400", uigf_gacha_type: "301", time, ...change } as const;
}

function full(change: object = {}) {
  return { ...minimal(), uid, name: ayaka.name, item_type: ayaka.itemType, rank_type: "5", count: "1", ...change } as const;
}

function v4(list: unknown[], timezone: number = 8) {
  return { info: { version: "v4.0", export_app: "Miao-Yunzai", export_app_version: "test", export_timestamp: "1700000000" },
    hk4e: [{ uid, timezone, list }] };
}

function v2(list: unknown[]) {
  return { info: { uid, lang: "zh-cn", uigf_version: "v2.3", export_app: "Miao-Yunzai",
    export_app_version: "test", export_timestamp: "1700000000" }, list };
}

test("UIGF v4 取匹配的原神账号并逐行补齐资料，忽略同文件星铁和其他账号", () => {
  const target = Object.freeze({ uid: Number(uid), timezone: 8, lang: "en-us", list: Object.freeze([
    Object.freeze(minimal({ name: "Kamisato Ayaka" })),
    Object.freeze(minimal({ id: newId, gacha_type: "301", item_id: "11401", name: "Favonius Sword" })),
  ]) });
  const document = Object.freeze({
    ...v4([]),
    hk4e: Object.freeze([{ uid: otherUid, timezone: "不验证其他账号", list: [null] }, target]),
    hkrpg: [{ uid, list: [null] }],
  });
  const sought: Parameters<GenshinUigfItemResolver>[0][] = [];
  const result = selectGenshinUigf(document, { uid, resolveItem(query) {
    sought.push(query);
    return query.itemId === "11401" ? { itemId: "11401", name: "西风剑", itemType: "武器", rank: 4 } : resolveItem(query);
  } });
  expect(result.region).toBe("cn_gf01");
  expect(result.pools.map(({ type, records }) => [type, records.length])).toEqual([[301, 2], [302, 0], [500, 0], [200, 0]]);
  expect(result.pools[0]!.records).toEqual([
    { id: newId, uid, item_id: "11401", name: "西风剑", item_type: "武器", rank_type: "4", time, lang: "zh-cn",
      gacha_type: "301", uigf_gacha_type: "301" },
    { id: oldId, uid, item_id: itemId, name: ayaka.name, item_type: "角色", rank_type: "5", time, lang: "zh-cn",
      gacha_type: "400", uigf_gacha_type: "301" },
  ]);
  expect(sought.map(({ itemId, lang }) => [itemId, lang])).toEqual([[itemId, "en-us"], ["11401", "en-us"]]);
  expect(selectGenshinUigf({
    ...document, info: { ...document.info, version: "v4.2" },
    hk4e: [{ uid: otherUid, timezone: 8, list: [full({ uid: otherUid })] }, target],
  }, { uid: otherUid }).region).toBe("cn_qd01");
});

test("UIGF 账号匹配、每行 UID、卡池和版本同时受校验", () => {
  const one = v4([full()]);
  expect(() => selectGenshinUigf(one, { uid: otherUid })).toThrow("恰好");
  expect(() => selectGenshinUigf({ ...one, hk4e: [one.hk4e[0], one.hk4e[0]] }, { uid })).toThrow("恰好");
  expect(() => selectGenshinUigf(v4([full({ uid: otherUid })]), { uid })).toThrow("UID");
  expect(() => selectGenshinUigf(v2([full()]), { uid: otherUid })).toThrow("UID");
  expect(() => selectGenshinUigf(v4([full({ uigf_gacha_type: "302" })]), { uid })).toThrow("标准卡池");
  expect(() => selectGenshinUigf(v4([full(), minimal({ gacha_type: "100", uigf_gacha_type: "100" })]), { uid }))
    .toThrow("当前导入暂不支持新手池");
  expect(() => selectGenshinUigf(v4([]), { uid })).toThrow("没有可导入");
  expect(() => selectGenshinUigf({ ...one, info: { version: "v4.3" } }, { uid })).toThrow("版本");
  expect(() => selectGenshinUigf({ info: { uid, srgf_version: "v1.0", uigf_version: "v2.3" }, list: [full()] }, { uid }))
    .toThrow("版本或游戏");
});

test("UIGF 保留相邻 19 位 ID，合并 301/400 重复，不让冲突 ID 或不安全数字入库", () => {
  const snapshot = selectGenshinUigf(v4([
    full(), full({ id: `00${oldId}`, gacha_type: "301" }), full({ id: newId, gacha_type: "301" }),
  ]), { uid });
  expect(snapshot.pools[0]!.records.map(({ id, gacha_type }) => [id, gacha_type])).toEqual([
    [newId, "301"], [oldId, "400"],
  ]);
  expect(() => selectGenshinUigf(v4([full({ id: Number(newId) })]), { uid })).toThrow("精度不足");
  expect(() => selectGenshinUigf(v4([full(), full({ time: "2023-10-21 12:17:00" })]), { uid })).toThrow("内容不同");
  expect(() => selectGenshinUigf(v4([full(), full({ gacha_type: "200", uigf_gacha_type: "200" })]), { uid }))
    .toThrow("内容不同");

  const prior = Object.freeze({ ...full(), name: "已有的可信名称" });
  const first = mergeGenshinGachaHistory({ 301: Object.freeze([prior]) }, snapshot);
  const repeat = mergeGenshinGachaHistory(first.records, snapshot);
  expect(first.records[301][1]).toBe(prior);
  expect(repeat.pools.every(({ changed }) => !changed)).toBe(true);
});

test("UIGF 逐条校验最低物品字段，v2 历史完整中文条目可兼容缺 item_id", () => {
  expect(() => selectGenshinUigf(v4([full(), minimal({ id: newId, item_id: "99999" })]), { uid, resolveItem }))
    .toThrow("物品名称、类型或星级");
  expect(() => selectGenshinUigf(v4([full({ item_id: undefined })]), { uid, resolveItem })).toThrow("物品编号");
  expect(() => selectGenshinUigf(v4([full()]), { uid,
    resolveItem: () => ({ ...ayaka, itemId: "10000003" }),
  })).toThrow("不一致");
  const row = full({ id: 1234, item_id: "undefined" });
  expect(selectGenshinUigf(v2([row]), { uid }).pools[0]!.records[0]).toMatchObject({
    id: "1234", rank_type: "5", name: ayaka.name,
  });
  expect(selectGenshinUigf(v2([row]), { uid }).pools[0]!.records[0]?.item_id).toBeUndefined();
});

test("UIGF 日期按明确偏移跨日调整，显式旧 Miao 模式保留原国服时间", () => {
  const doc = v4([full({ time: "2024-02-29 23:45:00" })], 0);
  expect(selectGenshinUigf(doc, { uid }).pools[0]!.records[0]?.time).toBe("2024-03-01 07:45:00");
  expect(selectGenshinUigf(doc, { uid, legacyMiaoServerTime: true }).pools[0]!.records[0]?.time)
    .toBe("2024-02-29 23:45:00");
  expect(selectGenshinUigf(v4([full({ time: "2023-12-31 12:30:00" })], -5), { uid }).pools[0]!.records[0]?.time)
    .toBe("2024-01-01 01:30:00");
  expect(selectGenshinUigf(v2([full()]), { uid }).pools[0]!.records[0]?.time).toBe(time);
  const oldWithZone = v2([full()]);
  expect(selectGenshinUigf({ ...oldWithZone, info: { ...oldWithZone.info, uigf_version: "v2.4", region_time_zone: 1 } },
    { uid }).pools[0]!.records[0]?.time).toBe("2023-10-20 19:17:00");
  for (const offset of [-13, 15, 5.5, Number.NaN]) {
    expect(() => selectGenshinUigf(v4([full()], offset), { uid, legacyMiaoServerTime: true })).toThrow("时区");
  }
  for (const bad of ["2023-02-29 12:17:00", "2023-10-20 24:00:00", "2023-10-20T12:17:00Z"]) {
    expect(() => selectGenshinUigf(v4([full({ time: bad })]), { uid })).toThrow("时间");
  }
});

test("UIGF 导出兼容旧 v2.3 与默认 v4.0，精确正序且不透传额外字段", () => {
  const original = Object.freeze({
    301: Object.freeze([Object.freeze(full({ id: newId, item_id: undefined, cookie: "fixture", is_up: true })),
      Object.freeze(full({ authkey: "fixture", url: "fixture" }))]),
  });
  const legacy = exportGenshinUigf(original, { ...exportOptions, version: "v2", resolveItem });
  const latest = exportGenshinUigf(original, { ...exportOptions, resolveItem });
  const info = { export_time: "2023-11-01 16:09:10", export_timestamp: "1698826150",
    export_app: "Lotus-Yunzai", export_app_version: "test" };
  expect(legacy.info).toEqual({ ...info, uid, lang: "zh-cn", uigf_version: "v2.3" });
  expect(latest.info).toEqual({ ...info, version: "v4.0" });
  if (!("list" in legacy) || !("hk4e" in latest)) throw new Error("UIGF fixture format");
  expect(latest.hk4e).toEqual([{ uid, lang: "zh-cn", timezone: 8, list: legacy.list }]);
  expect(legacy.list).toEqual([
    { ...full(), lang: "zh-cn" },
    { ...full({ id: newId }), lang: "zh-cn" },
  ]);
  expect(original[301][0]).toMatchObject({ id: newId, item_id: undefined, cookie: "fixture" });
  expect(selectGenshinUigf(JSON.parse(JSON.stringify(latest)), { uid }).pools[0]!.records.map(({ id }) => id))
    .toEqual([newId, oldId]);
  expect(() => exportGenshinUigf(original, exportOptions)).toThrow("物品编号");
  expect(() => exportGenshinUigf({}, exportOptions)).toThrow("没有可导出");
});
