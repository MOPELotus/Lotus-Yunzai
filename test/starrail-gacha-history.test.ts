import { expect, test } from "bun:test";
import { starRailGachaPools, type StarRailGachaPool } from "../packages/hoyo-client/index.ts";
import { mergeStarRailGachaHistory, type StarRailGachaSnapshot } from "../plugins/starrail/gacha-history.ts";

const uid = "512345678";
const who = { qq: "42", profileId: 2 };
const updated = new Date("2026-01-29T10:30:00.000Z");
const oldUpdate = "2025-12-02T09:00:00.000Z";
const item = { item_id: 1201, name: "夹具角色" };
const newId = "1735853810000001930";
const sameId = "1735853810000001920";
const mappedId = "1735853810000001903";
const oldId = "1735253810000001920";

type SnapshotPool = StarRailGachaSnapshot["pools"][number];

function capture(overrides: Partial<Record<StarRailGachaPool, Partial<SnapshotPool>>> = {}) {
  const pools = (Object.keys(starRailGachaPools) as StarRailGachaPool[]).map((type): SnapshotPool => ({
    name: starRailGachaPools[type], cards: [], fiveStars: [], pity: null,
    ...overrides[type], type,
  }));
  return { uid, region: "prod_qd_cn", revision: "fixture", refreshedCookie: false, brief: { version_id: "12", items: [] }, pools };
}

function row(id: string, uuid = "") {
  return { id, uuid, item, got_item: null, gacha_count: 50, is_up: true };
}

function fixture() {
  return JSON.parse(JSON.stringify({
    version: 1, qq: 42, uid, profileId: 1, region: "prod_qd_cn",
    source: "mihoyo_star_rail_gacha_miniapp", updatedAt: oldUpdate, brief: { version_id: "11", items: [] },
    importedFromLegacy: true,
    pools: {
      GachaType_AvatarUp: {
        name: "角色活动跃迁",
        cards: [{ gacha_id: "old", total_count: 250, up_count: 2 }, { gacha_id: "active", total_count: "60", up_count: 1 }],
        cardCounters: { old: 250, active: "60" }, totalDraws: "358", pity: 12,
        fiveStars: [
          { ...row(oldId), legacy_time: "2024-12-26 17:00:00" },
          { ...row(sameId, "same"), got_item: { detail: true } },
          { uuid: "now-with-id", item, is_up: true, gacha_count: "20" },
        ],
        imported: { snapshotVersion: 1 },
      },
      GachaType_Standard: {
        name: "常驻跃迁", cards: [{ gacha_id: "legacy-standard", total_count: "88", up_count: 0 }],
        fiveStars: [], totalDraws: 300, pity: 5,
      },
      retainedExtensionPool: { author: "fixture" },
    },
  }));
}

test("合并 Lotus-ReFactor v1 历史的五星、各期累计抽数和垫抽，重复更新不重复累计", () => {
  const previous = fixture();
  const preserved = structuredClone(previous);
  const latest = capture({
    GachaType_AvatarUp: {
      cards: [
        { gacha_id: "old", total_count: 175, up_count: 1 },
        { gacha_id: "active", total_count: 65, up_count: 1 },
        { gacha_id: "new", total_count: 20, up_count: 0 },
        { gacha_id: "active", total_count: 62, up_count: 1 },
      ],
      fiveStars: [row(sameId, "same"), row(mappedId, "now-with-id"), row(newId), row(newId)],
    },
    GachaType_Standard: { cards: [{ gacha_id: "legacy-standard", total_count: 90, up_count: 0 }], pity: 0 },
  });

  const first = mergeStarRailGachaHistory(previous, latest, who, updated);
  expect(first.log).toMatchObject({
    version: 1, qq: "42", profileId: 2, uid, region: "prod_qd_cn",
    source: "mihoyo_star_rail_gacha_miniapp", updatedAt: updated.toISOString(), importedFromLegacy: true,
    brief: latest.brief,
  });
  expect(Object.keys(first.log.pools)).toHaveLength(7);
  expect(first.log.pools.retainedExtensionPool).toEqual({ author: "fixture" });
  expect(first.log.pools.GachaType_AvatarUp).toMatchObject({
    totalDraws: 383, pity: 12, cardCounters: { old: 250, active: 65, new: 20 },
    imported: { snapshotVersion: 1 },
    fiveStars: [
      { id: newId },
      { id: sameId, got_item: { detail: true } },
      { id: mappedId, uuid: "now-with-id" },
      { id: oldId, legacy_time: "2024-12-26 17:00:00" },
    ],
  });
  expect(first.log.pools.GachaType_Standard).toMatchObject({ totalDraws: 302, pity: 0, cardCounters: { "legacy-standard": 90 } });
  expect(first.pools).toHaveLength(6);
  expect(first).toMatchObject({ added: 1, total: 4 });
  expect(previous).toEqual(preserved);
  expect(JSON.stringify(latest)).not.toContain(oldId);

  const replay = mergeStarRailGachaHistory(JSON.parse(JSON.stringify(first.log)), latest, who, updated);
  expect(replay.log).toEqual(first.log);
  expect(replay).toMatchObject({ added: 0, total: 4 });
});

test("当前为空的官方池保留历史或建立正确的空档", () => {
  const empty = capture();
  const retained = mergeStarRailGachaHistory(fixture(), empty, who, updated);
  expect(retained.log.pools.GachaType_AvatarUp).toMatchObject({
    cards: [], cardCounters: { old: 250, active: 60 }, totalDraws: 358, pity: 12,
  });
  expect(retained.log.pools.GachaType_AvatarUp.fiveStars).toHaveLength(3);
  expect(retained).toMatchObject({ added: 0, total: 3 });
  const fresh = mergeStarRailGachaHistory(null, empty, who, updated);
  expect(fresh).toMatchObject({ added: 0, total: 0 });
  expect(fresh.log.pools.GachaType_EquipmentUp).toMatchObject({
    cards: [], cardCounters: {}, fiveStars: [], totalDraws: 0, pity: 0,
  });
  expect(fresh.pools).toHaveLength(6);
});

test("星铁缺池、重复池、无效记录及错误 QQ 或 UID 均中止整份合并", () => {
  const previous = fixture();
  const preserved = structuredClone(previous);
  const snapshot = capture();
  const active = snapshot.pools[0]!;
  const missing = { ...snapshot, pools: snapshot.pools.slice(1) };
  const duplicate = { ...snapshot, pools: [active, ...snapshot.pools.slice(0, -1)] };
  expect(() => mergeStarRailGachaHistory(previous, missing, who, updated)).toThrow("全部六种跃迁");
  expect(() => mergeStarRailGachaHistory(previous, duplicate, who, updated)).toThrow("资料缺失、重复或无效");
  expect(() => mergeStarRailGachaHistory(previous, snapshot, { ...who, qq: "34" }, updated)).toThrow("身份与本次档案不一致");
  expect(() => mergeStarRailGachaHistory(previous, { ...snapshot, uid: "512345679" }, who, updated)).toThrow("身份与本次档案不一致");
  expect(() => mergeStarRailGachaHistory({ ...previous, version: 2 }, snapshot, who, updated)).toThrow("版本");
  expect(() => mergeStarRailGachaHistory(previous, capture({
    GachaType_AvatarUp: { fiveStars: [row(newId, "same")] },
  }), who, updated)).toThrow("编号与 UUID 冲突");
  expect(() => mergeStarRailGachaHistory(previous, capture({
    GachaType_AvatarUp: { cards: [{ gacha_id: "", total_count: 100, up_count: 0 }] },
  }), who, updated)).toThrow("缺少对应卡池编号");
  const unsafeOldData = structuredClone(previous);
  unsafeOldData.pools.GachaType_Standard.fiveStars = [{ id: Number.MAX_SAFE_INTEGER + 1, item }];
  expect(() => mergeStarRailGachaHistory(unsafeOldData, snapshot, who, updated)).toThrow("精度不足");
  expect(previous).toEqual(preserved);
});
