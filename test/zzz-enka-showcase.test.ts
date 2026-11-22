import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { formatEnkaPanel } from "../plugins/zzz/enka-panel-data.ts";
import { createZzzShowcaseClient, decodeEnkaShowcase } from "../plugins/zzz/enka-showcase.ts";
import { buildZzzPanelDetail } from "../plugins/zzz/panel-detail.ts";
import { createZzzShowcaseStorage } from "../plugins/zzz/panel-storage.ts";

const source = { uid: "1300000002", region: "prod_gf_jp" };
const sibling = { uid: "1500000003", region: "prod_gf_eu" };
const signal = new AbortController().signal;

function provide(uid: string, rows: readonly unknown[], ttl = 120) {
  return { uid, ttl, PlayerInfo: {
    SocialDetail: { ProfileDetail: { Uid: Number(uid), Nickname: "展柜测试", Level: 60, Password: "never copied" } },
    ShowcaseDetail: { AvatarList: rows },
  } };
}

test("只有同 UID 同区服的公开角色可用，隐藏行和社交私有元数据不出归档对象", () => {
  const payload = { ...provide(source.uid, [{ Id: 1011 }, { Id: 1021, IsHidden: true }], 0), region: "asia" };
  expect(decodeEnkaShowcase(payload, source)).toEqual({
    ttl: 60, nickname: "展柜测试", level: 60, rows: [{ Id: 1011 }],
  });
  expect(() => decodeEnkaShowcase({ ...payload, region: "na" }, source)).toThrow(/区服/u);
  expect(() => decodeEnkaShowcase({ ...payload, uid: sibling.uid }, source)).toThrow(/UID/u);
  expect(() => decodeEnkaShowcase(provide(sibling.uid, []), source)).toThrow(/UID/u);
  expect(() => decodeEnkaShowcase(provide(source.uid, [{ Id: 1011 }, { Id: 1011 }]), source)).toThrow(/无法核验/u);
  expect(() => decodeEnkaShowcase(provide(source.uid, [{ Id: 1011, IsHidden: "true" }]), source)).toThrow(/无法核验/u);
  expect(() => decodeEnkaShowcase(provide(source.uid, [{ Id: 1011 }], -1), source)).toThrow(/无法核验/u);
  expect(decodeEnkaShowcase(provide(source.uid, [{ Id: 1011, IsHidden: true }]), source).rows).toEqual([]);
});

test("公开展柜只发固定 HTTPS URL 和识别 UA，尊重 UID TTL、跨 UID 限流、在途排他和换绑", async () => {
  let now = 1_000_000;
  let requests = 0;
  const pending = Promise.withResolvers<void>();
  const read = createZzzShowcaseClient(async (url, init) => {
    requests++;
    expect(url.origin).toBe("https://enka.network");
    expect(url.search).toBe("");
    expect(init).toMatchObject({ method: "GET", redirect: "error", credentials: "omit", referrerPolicy: "no-referrer" });
    const headers = new Headers(init.headers);
    expect([...headers.keys()].sort()).toEqual(["accept", "user-agent"]);
    expect(headers.get("user-agent")).toStartWith("Lotus-Yunzai/ZZZ");
    if (requests === 1) {
      expect(url.pathname).toBe("/api/zzz/uid/" + source.uid);
      await pending.promise;
      return Response.json(provide(source.uid, [{ Id: 1011 }]));
    }
    if (requests === 2) return new Response("noise", { status: 429, headers: { "retry-after": "90" } });
    return new Response("large text", { headers: { "content-type": "application/json", "content-length": "1048577" } });
  }, () => now);
  const first = read(source, signal);
  await expect(read(source, signal)).rejects.toMatchObject({ code: "rate-limited" });
  await expect(read(sibling, signal)).rejects.toMatchObject({ code: "rate-limited" });
  pending.resolve();
  expect((await first).rows).toEqual([{ Id: 1011 }]);
  now += 1000;
  await expect(read(source, signal)).rejects.toThrow(/119 秒/u);
  await expect(read(sibling, signal, async () => { throw new Error("binding changed"); })).rejects.toThrow("binding changed");
  expect(requests).toBe(1);
  await expect(read(sibling, signal)).rejects.toThrow(/90 秒/u);
  now += 85_000;
  await expect(read({ uid: "1700000004", region: "prod_gf_sg" }, signal)).rejects.toThrow(/5 秒/u);
  now += 34_000;
  await expect(read(source, signal)).rejects.toMatchObject({ code: "response" });
  expect(requests).toBe(3);
});

test("群榜实时读跳过本地 UID TTL，与手动展柜共用 Enka 站级冷却和退避", async () => {
  let now = 1_000_000;
  let count = 0;
  const read = createZzzShowcaseClient(async (url, options) => {
    const uid = url.pathname.split("/").at(-1)!;
    expect(options.credentials).toBe("omit");
    expect(new Headers(options.headers).has("Cookie")).toBe(false);
    count++;
    if (count === 3) return new Response(null, { status: 404 });
    if (count === 4) return new Response(null, { status: 429, headers: { "retry-after": "90" } });
    return Response.json(provide(uid, [{ Id: 1011 }]));
  }, () => now);
  const verify = async () => {};
  expect((await read(source, signal)).rows).toHaveLength(1);
  now += 1000;
  await expect(read(source, signal)).rejects.toThrow(/缓存期/u);
  expect((await read.forGroupRank(source, signal, verify))?.rows).toHaveLength(1);
  now += 1000;
  expect(await read.forGroupRank(sibling, signal, verify)).toBeUndefined();
  now += 1000;
  await expect(read.forGroupRank(source, signal, verify)).rejects.toThrow(/90 秒/u);
  now += 1000;
  await expect(read.forGroupRank(sibling, signal, verify)).rejects.toThrow(/89 秒/u);
  await expect(read({ uid: "1700000004", region: "prod_gf_sg" }, signal)).rejects.toThrow(/89 秒/u);
  expect(count).toBe(4);
});

const tables = {
  partners: { 1011: { name: "安比", full_name: "安比·德玛拉", WeaponType: "2", Rarity: "A", ElementType: "203",
    HpMax: 603, Attack: 95, Defence: 49, HpGrowth: 818426, AttackGrowth: 54230, DefenceGrowth: 66882,
    Crit: 500, SpRecover: 120, Level: { 6: { HpMax: 2000, Attack: 120, Defence: 200 } } } },
  weapons: { 14102: { Name: "钢铁肉垫", Rarity: "S", BaseProperty: { Id: 12101, Value: 46, Name: "基础攻击力" },
    RandProperty: { Id: 20103, Value: 960, Name: "暴击率" },
    Level: { 60: { Rate: 94090 } }, Stars: { 5: { StarRate: 44610, RandRate: 15000 } } } },
  suits: { 31000: { name: "啄木鸟电音", properties: [{ property_id: 20103, base: "8%" }] } },
};

const agent = {
  Id: 1011, Level: 60, TalentLevel: 5, PromotionLevel: 6, CoreSkillEnhancement: 0,
  Weapon: { Uid: "never retained", Id: 14102, Level: 60, BreakLevel: 5, UpgradeLevel: 2 },
  SkillLevelList: { 0: 12, 2: 10, 5: 6, 6: 8 },
  EquippedList: [{ Slot: 1, Equipment: { Uid: "never retained", Id: 31041, Level: 14,
    MainStatList: [{ PropertyId: 11103, PropertyValue: 550 }],
    RandomPropertyList: [{ PropertyId: 20103, PropertyLevel: 3, PropertyValue: 240 }] } }],
};

test("公开展柜适配保留公布公式的音擎和驱动盘结果、影画技能，并排除装备实例标识", () => {
  const result = formatEnkaPanel(agent, tables)!;
  expect(JSON.stringify(result)).not.toContain("never retained");
  const model = buildZzzPanelDetail(result);
  expect(model.skills).toEqual([16, 14, 12, undefined, undefined, 6]);
  expect(model.weapon).toMatchObject({ name: "钢铁肉垫", star: 2, main: [{ value: "684" }], extra: [{ value: "24%" }] });
  expect(model.discs[0]).toMatchObject({ name: "啄木鸟电音[1]", rarity: "S", level: 14, main: [{ value: "2090" }],
    extra: [{ value: "7.2%", enhancements: 2 }] });
  expect(model.properties).toContainEqual({ id: 201, name: "暴击率", value: "36.2%", base: "5.0%", added: "31.2%" });
  expect(formatEnkaPanel({ ...agent, Id: 9999 }, tables)).toBeUndefined();
  expect(formatEnkaPanel({ ...agent, EquippedList: [...agent.EquippedList, ...agent.EquippedList] }, tables)).toBeUndefined();
  expect(buildZzzPanelDetail(formatEnkaPanel({ ...agent, Weapon: { Id: 0 }, EquippedList: [{Slot:1}] }, tables)!).weapon).toBeUndefined();
});

test("独立公开归档按同 QQ、地区和 UID 保存，隐去旧角色，拒绝较迟提交与绑定变化", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-zzz-showcase-test-"));
  try {
    const archive = createZzzShowcaseStorage(async () => ({ close() {} }), root);
    const identity = { ...source, qq: "42" };
    const row = formatEnkaPanel(agent, tables)!;
    await archive.replace(identity, [row], 1000, async () => {});
    expect((await archive.read(identity)).map(avatar => avatar.id)).toEqual([1011]);
    expect(await archive.read({ ...identity, qq: "43" })).toEqual([]);
    await expect(archive.replace(identity, [], 2000, async () => { throw new Error("rebound"); })).rejects.toThrow("rebound");
    expect((await archive.read(identity)).length).toBe(1);
    await archive.replace(identity, [], 2000, async () => {});
    await archive.replace(identity, [row], 1500, async () => {});
    expect(await archive.read(identity)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
