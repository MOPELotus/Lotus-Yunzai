import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProfileRequestContext } from "@lotus-yunzai/account";
import { lockFile } from "../lib/file-lock.ts";
import { normalizeZzzPanelAvatar, readZzzPanel } from "../packages/hoyo-client/zzz-panel.ts";
import { zzzPanelCommand } from "../plugins/zzz/panel-command.ts";
import { createZzzPanelStorage, decodeZzzPanelRows, zzzPanelRegion } from "../plugins/zzz/panel-storage.ts";

const uid = "12345678";
const cn = "prod_gf_cn";
const source = {
  qq: "42", profileId: 2, game: "zzz", revision: "fixture-revision",
  account: { cookie: "ltoken=fixture-cookie" }, device: { id: "fixture-device", fp: "fixture-fp" },
  role: { uid, region: cn, gameBiz: "nap_cn" },
} as ProfileRequestContext;

const zh = { id: 1151, name_mi18n: "「11号」", full_name_mi18n: "「11号」", rarity: "S", rank: 0, level: 60,
  equip: [{id:941,properties:[{property_id:23203,base:"9",count:1}]}], weapon:{id:14115}, skills:[{level:12}] };
const other = { ...zh, id: 1141, name_mi18n: "莱卡恩", full_name_mi18n: "冯·莱卡恩", rank: 6 };
const reply = (data: unknown) => Response.json({ retcode: 0, data });

test("绝区零面板旧名册、全量刷新与单选更新保留旧前缀和档案编号", () => {
  expect(zzzPanelCommand("%面板")).toEqual({ kind: "list", profileId: 1 });
  expect(zzzPanelCommand("#ZZZ面板列表 2")).toEqual({ kind: "list", profileId: 2 });
  expect(zzzPanelCommand("％绝区零面板刷新")).toEqual({ kind: "update", profileId: 1, names: [] });
  expect(zzzPanelCommand("/zzz更新莱卡恩、11号面板2")).toEqual({
    kind: "update", profileId: 2, names: ["莱卡恩", "11号"],
  });
  expect(zzzPanelCommand("%11号面板")).toEqual({ kind: "detail", profileId: 1, name: "11号" });
  for (const unrelated of ["%更新展柜面板", "%面板256", "#原神面板", "%危局"]) {
    expect(zzzPanelCommand(unrelated)).toBeUndefined();
  }
});

test("面板迁移保留原始面板字段和真实 0 影画，忽略上游未约定字段", () => {
  const avatar = normalizeZzzPanelAvatar({ ...zh, unknownField: "unrelated", rank: "0" });
  expect(avatar).toMatchObject(zh);
  expect(avatar).not.toHaveProperty("unknownField");
  expect(decodeZzzPanelRows([zh, other]).map(row => row.id)).toEqual([1151, 1141]);
  expect(() => decodeZzzPanelRows([zh, zh])).toThrow(/重复/);
  expect(() => decodeZzzPanelRows([{ ...zh, rank: 7 }])).toThrow();
  expect(zzzPanelRegion("1300000001", "", "nap_global")).toBe("prod_gf_jp");
  expect(zzzPanelRegion("1300000001", "prod_gf_eu", "nap_global")).toBeUndefined();
  expect(zzzPanelRegion(uid, cn, "nap_global")).toBeUndefined();
});

test("官方面板先取已有角色，再按原顺序单角色请求，接受明确空的角色结果", async () => {
  const visits: string[] = [];
  let verified = 0;
  const panel = await readZzzPanel(source, async (endpoint, options) => {
    visits.push(endpoint.href);
    expect(endpoint.origin).toBe("https://api-takumi-record.mihoyo.com");
    const headers = new Headers(options.headers);
    expect(headers.get("cookie")).toBe("ltoken=fixture-cookie");
    expect(headers.get("x-rpc-device_fp")).toBe("fixture-fp");
    expect(options).toMatchObject({ method:"GET", redirect:"error", credentials:"omit" });
    const id = endpoint.searchParams.get("id_list[]");
    const avatar_list = id === null ? [{ id: 1151 }, {id:1141}] : id === "1151" ? [zh] : [];
    return reply({ uid, region: cn, avatar_list });
  }, { roleInterval: 0 }, async () => { verified++; });
  expect(visits.map(url => new URL(url).pathname.split("/").at(-1))).toEqual(["basic", "info", "info"]);
  expect(visits[1]).toEndWith("lang=zh-cn&role_id=12345678&server=prod_gf_cn&need_wiki=false&id_list%5B%5D=1151");
  expect(visits[2]).toEndWith("id_list%5B%5D=1141");
  expect(verified).toBe(6);
  expect(panel.avatars[0]?.id).toBe(1151);
  expect(panel.missingIds).toEqual([1141]);
});

test("指定角色跳过名册，错误角色、错误区服和国际服均不能产生可归档数据", async () => {
  let requests = 0;
  await expect(readZzzPanel(source, async () => { requests++; return reply({}); },
    { ids: ["1151" as unknown as number] })).rejects.toMatchObject({ code: "invalid-input" });
  await expect(readZzzPanel(source, async () => { requests++; return reply({}); },
    { ids: [1151], roleInterval: 2_147_483_648 })).rejects.toMatchObject({ code: "invalid-input" });
  expect(requests).toBe(0);
  await expect(readZzzPanel(source, async (url) => {
    requests++;
    expect(url.pathname).toEndWith("/avatar/info");
    expect(url.searchParams.getAll("id_list[]")).toEqual(["1151"]);
    return reply({ avatar_list:[other] });
  }, { ids: [1151, 1151], roleInterval: 30_001 })).rejects.toMatchObject({code:"response"});
  expect(requests).toBe(1);
  await expect(readZzzPanel(source, async () => reply({ server:"prod_qd_cn",avatar_list:[zh] }), {ids:[1151]}))
    .rejects.toMatchObject({code:"response"});
  const overseas = {...source,role:{...source.role,uid:"1300000001",region:"prod_gf_jp",gameBiz:"nap_global"}};
  await expect(readZzzPanel(overseas, async () => { requests++; return reply({}); }, {ids:[1151]}))
    .rejects.toMatchObject({code:"invalid-input"});
  expect(requests).toBe(1);
});

test("同一 QQ 区服归档保留旧面板顺序、部分更新和换绑保护", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-zzz-panel-test-"));
  try {
    const legacy = join(root,"legacy"), managed = join(root,"managed");
    await mkdir(join(legacy,"panel"),{recursive:true});
    const old = join(legacy,"panel",uid+".json");
    const text = JSON.stringify([zh,other]);
    await writeFile(old,text);
    const storage = createZzzPanelStorage(lockFile,{legacy,managed});
    const user = {qq:"42",uid,region:cn};
    expect((await storage.read(user)).map(row=>row.id)).toEqual([1151,1141]);
    expect(await storage.read({...user,region:"prod_qd_cn"})).toEqual([]);
    const update = normalizeZzzPanelAvatar({...other,rank:5});
    expect((await storage.merge(user,[update],async()=>{})).map(row=>[row.id,row.rank])).toEqual([[1141,5],[1151,0]]);
    const doc = join(managed,cn,"42",uid+".json");
    const before = await readFile(doc);
    await expect(storage.merge(user,[normalizeZzzPanelAvatar(zh)],async()=>{throw new Error("fixture changed");})).rejects.toThrow("fixture changed");
    expect(await readFile(doc)).toEqual(before);
    expect(await readFile(old,"utf8")).toBe(text);
    expect((await storage.read({...user,qq:"43"})).map(row=>row.id)).toEqual([1151,1141]);
    await symlink(old,join(legacy,"panel","12345679.json"));
    await expect(storage.read({...user,uid:"12345679"})).rejects.toThrow("原归属文件");
    const outside=join(root,"outside.json");
    await writeFile(outside,text);
    await symlink(outside,join(legacy,"panel","12345680.json"));
    await expect(storage.read({...user,uid:"12345680"})).rejects.toThrow("超出数据目录");
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});
