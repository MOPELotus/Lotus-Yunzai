import { expect, test } from "bun:test";
import {
  convertStarRailUigfTimezone, exportStarRailUigf, selectStarRailUigf, validateStarRailUigfArchive, type StarRailUigfPool,
} from "../plugins/starrail/gacha-uigf.ts";

const uid = "100000002";
const otherUid = "500000003";
const id = "1752984000000000498";
const nextId = "1752984000000000499";
const time = "2025-07-15 12:00:07";
const options = { uid, exportedAt: new Date("2025-09-06T21:30:11.432Z"),
  app: { name: "Lotus-Yunzai", version: "test" } };

function row(change: object = {}) {
  return { id, gacha_id: "2005", gacha_type: "1", item_id: "20002", time, ...change } as const;
}

function v4(list: readonly unknown[], timezone: unknown = 8, version = "v4.1", app = "Miao-Yunzai") {
  return { info: { version, export_app: app, export_app_version: "test", export_timestamp: "1752984000" },
    hkrpg: [{ uid, timezone, lang: "zh-cn", list }] };
}

function srgf(list: readonly unknown[], timezone: unknown = 8, app = "Miao-Yunzai") {
  return { info: { srgf_version: "v1.0", uid, region_time_zone: timezone, lang: "zh-cn",
    export_app: app, export_app_version: "test", export_timestamp: "1752984000" }, list };
}

test("UIGF 精确选取指定星铁 UID，保留必填字段和可选元数据", () => {
  const target = Object.freeze({ uid: Number(uid), timezone: 8, lang: "en-us", list: Object.freeze([
    Object.freeze(row({ id: nextId, uid: Number(uid), name: "Darting Arrow", item_type: "Light Cone", rank_type: "3",
      count: 1, cookie: "fixture", is_up: true })),
    Object.freeze(row()),
  ]) });
  const document = Object.freeze({ ...v4([]), hk4e: [{ uid, list: [null] }],
    hkrpg: Object.freeze([{ uid: otherUid, list: [null] }, target]) });
  const data = selectStarRailUigf(document, { uid });
  expect(data).toEqual({ uid, timezone: 8, lang: "en-us", records: [
    { ...row(), uid },
    { ...row({ id: nextId }), uid, name: "Darting Arrow", item_type: "Light Cone", rank_type: "3", count: "1" },
  ] });
  expect(() => selectStarRailUigf({ ...document, hkrpg: [target, target] }, { uid })).toThrow("恰好包含一个");
  expect(() => selectStarRailUigf(v4([row()]), { uid: otherUid })).toThrow("UID 匹配");
  expect(() => selectStarRailUigf(v4([row({ uid: otherUid })]), { uid })).toThrow("UID 与当前档案");
  expect(() => selectStarRailUigf(srgf([row()]), { uid: otherUid })).toThrow("UID 与当前档案");
  expect(() => selectStarRailUigf({ ...document, info: { version: "v4.3" } }, { uid })).toThrow("UIGF 版本");
  expect(() => selectStarRailUigf({ ...document, hkrpg: undefined }, { uid })).toThrow("没有星铁账号列表");
});

test("SRGF 与 UIGF v4.0 兼容旧 Miao 六池输出，默认 v4.1 可标准导出六池", () => {
  const types: StarRailUigfPool[] = ["11", "12", "21", "22", "2", "1"];
  const all = types.map((type, index) =>
    row({ id: String(BigInt(id) + BigInt(index)), gacha_type: type, gacha_id: String(2000 + index) }));
  const legacy = selectStarRailUigf(srgf(all), { uid });
  expect(selectStarRailUigf(v4(all, 8, "v4.0"), { uid })).toEqual(legacy);
  expect(selectStarRailUigf(v4(all, 8, "v4.2", "other"), { uid })).toEqual(legacy);
  expect(() => selectStarRailUigf(srgf(all, 8, "other"), { uid })).toThrow("不支持星铁联动");
  expect(() => selectStarRailUigf(v4(all, 8, "v4.0", "other"), { uid })).toThrow("不支持星铁联动");
  const output = exportStarRailUigf(legacy, options);
  expect(output.info).toEqual({ version: "v4.1", export_time: "2025-09-07 05:30:11",
    export_timestamp: 1757194211, export_app: "Lotus-Yunzai", export_app_version: "test" });
  if (!("hkrpg" in output)) throw new Error("expected UIGF");
  expect(output.hkrpg[0].list.map(({ gacha_type }) => gacha_type)).toEqual(types);
  expect(selectStarRailUigf(JSON.parse(JSON.stringify(output)), { uid })).toEqual(legacy);
  expect(() => exportStarRailUigf(legacy, { ...options, version: "v2" })).toThrow("不支持星铁联动");
});

test("四种原有卡池可导出标准 SRGF，按精确 ID 正序且不泄露附加字段", () => {
  const source = selectStarRailUigf(v4([row({ id: nextId, gacha_type: "2" }), row()]), { uid });
  const archive = { ...source, records: source.records.map((item) => ({ ...item, authkey: "fixture" })) };
  const legacy = exportStarRailUigf(archive, { ...options, version: "v2" });
  if (!("list" in legacy)) throw new Error("expected SRGF");
  expect(legacy.info).toMatchObject({ srgf_version: "v1.0", uid, lang: "zh-cn", region_time_zone: 8 });
  expect(legacy.list).toEqual([row(), { ...row(), id: nextId, gacha_type: "2" }]);
  expect(selectStarRailUigf(legacy, { uid })).toEqual(source);
  expect(() => exportStarRailUigf(archive, { ...options, uid: otherUid })).toThrow("UID");
  expect(() => exportStarRailUigf({ ...archive, lang: undefined }, { ...options, version: "v2" })).toThrow("账号语言");
});

test("仅接受真实逐抽，清楚拒绝整份旧 Lotus 镜像及所有已知占位形式", () => {
  for (const fake of [
    row({ id: "lotus-11-1" }), row({ id: "lotus-five-11-2" }), row({ name: " 占位记录 " }),
    row({ time: "1970-01-01 00:00:00" }),
  ]) {
    const rows = [row({ gacha_id: undefined, item_id: undefined }), fake, row({ id: nextId })];
    expect(() => selectStarRailUigf(v4(rows), { uid })).toThrow("显示占位记录");
    expect(() => selectStarRailUigf(srgf(rows), { uid })).toThrow("显示占位记录");
  }
  const archive = selectStarRailUigf(v4([row()]), { uid });
  expect(() => exportStarRailUigf({ ...archive, records: [
    ...archive.records, { ...archive.records[0]!, id: "lotus-1-1" },
  ] }, options)).toThrow("显示占位记录");
  expect(() => selectStarRailUigf(v4([row({ gacha_id: undefined })]), { uid })).toThrow("活动卡池编号");
  expect(() => selectStarRailUigf(v4([row({ item_id: undefined })]), { uid })).toThrow("物品编号");
  expect(() => selectStarRailUigf(v4([]), { uid })).toThrow("没有可转换");
});

test("用十进制字符串区分相邻 ID，补齐完全重复行并拒绝跨池冲突", () => {
  const imported = selectStarRailUigf(v4([
    row({ id: nextId }), row(), row({ name: "锋镝", rank_type: "3" }),
  ]), { uid });
  expect(imported.records.map(({ id, name }) => [id, name])).toEqual([[id, "锋镝"], [nextId, undefined]]);
  expect(() => selectStarRailUigf(v4([row({ id: Number(nextId) })]), { uid })).toThrow("精度不足");
  for (const conflict of [{ gacha_type: "12" }, { gacha_id: "1234" }, { item_id: "1234" }, { count: "2" },
    { time: "2025-07-15 12:00:08" }, { rank_type: "4" }]) {
    expect(() => selectStarRailUigf(v4([row({ rank_type: "3" }), row(conflict)]), { uid })).toThrow("内容不同");
  }
  expect(() => selectStarRailUigf(v4([row({ gacha_type: "301" })]), { uid })).toThrow("卡池编号");
});

test("保留原服务器时钟，跨偏移换算同一瞬间并显式支持旧 Miao 的错误时区", () => {
  const clock = "2024-02-29 23:45:00";
  const raw = v4([row({ time: clock })], 0, "v4.0");
  const utc = selectStarRailUigf(raw, { uid });
  expect(utc.timezone).toBe(0);
  expect(utc.records[0]?.time).toBe(clock);
  const moved = convertStarRailUigfTimezone(utc, 8);
  expect(moved.timezone).toBe(8);
  expect(moved.records[0]?.time).toBe("2024-03-01 07:45:00");
  expect(convertStarRailUigfTimezone(moved, 0)).toEqual(utc);
  expect(utc.records[0]?.time).toBe(clock);
  expect(selectStarRailUigf(raw, { uid, legacyMiaoServerTime: true })).toEqual({ ...utc, timezone: 8 });
  expect(selectStarRailUigf(srgf([row({ time: clock })], 0), { uid, legacyMiaoServerTime: true }))
    .toEqual({ ...utc, timezone: 8 });
  expect(selectStarRailUigf(v4([row({ time: clock })], 0), { uid, legacyMiaoServerTime: true })).toEqual(utc);
  const fraction = selectStarRailUigf(srgf([row({ time: clock })], 5.5), { uid });
  expect(convertStarRailUigfTimezone(fraction, 8).records[0]?.time).toBe("2024-03-01 02:15:00");
  expect(exportStarRailUigf(fraction, { ...options, version: "v2" }).info).toMatchObject({ region_time_zone: 5.5 });
  expect(() => exportStarRailUigf(fraction, options)).toThrow("时区偏移无效");
  for (const invalid of ["2025-02-29 09:00:00", "2025-07-15 24:00:00", "2025-07-15T12:00:07+08:00"]) {
    expect(() => selectStarRailUigf(v4([row({ time: invalid })]), { uid })).toThrow("抽卡时间");
  }
  for (const invalid of [-13, 15, 5.5, "8", NaN]) {
    expect(() => selectStarRailUigf(v4([row()], invalid), { uid })).toThrow("时区偏移");
  }
});

test("独立逐抽档可保留分时区的联动记录，跨偏移合并同一抽不会重复", () => {
  const raw = row({ gacha_type: "21" });
  const existing = selectStarRailUigf(srgf([raw], 5.5), { uid });
  const incoming = selectStarRailUigf(v4([row({ ...raw, time: "2025-07-15 14:30:07", name: "姬子" })]), { uid });
  const shifted = convertStarRailUigfTimezone(incoming, existing.timezone);
  const merged = validateStarRailUigfArchive({ ...existing, records: [...existing.records, ...shifted.records] }, uid);
  expect(merged).toEqual({ ...existing, records: [{ ...raw, uid, name: "姬子" }] });
  expect(() => validateStarRailUigfArchive(existing, otherUid)).toThrow("UID");
  expect(() => validateStarRailUigfArchive({ ...existing, lang: 7 }, uid)).toThrow("语言");
});
