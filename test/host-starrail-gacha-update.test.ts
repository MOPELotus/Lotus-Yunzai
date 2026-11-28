import {physicalGpuFixture,functionalRenderingPreload,physicalRenderingPreload} from "./physical-gpu-fixture.ts";
import { linkHostPackages, linkHostBuiltinResources } from "./host-fixture.ts";
import { expect, test } from "bun:test";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const gpu = await physicalGpuFixture();
if (!gpu.available) console.warn("[GPU]", gpu.reason);

const uid = "100123456";
const path = `data/legacy-game-history/Lotus-ReFactor/starRailGachaJson/42/${uid}.json`;
const current = `data/starRailGachaJson/42/${uid}.json`;
const priorId = "1735853810000001901";
const nextId = "1735853810000001902";
const legacy = JSON.stringify({
  version: 1, qq: "42", uid, source: "mihoyo_star_rail_gacha_miniapp", region: "prod_gf_cn", profileId: 1,
  pools: { GachaType_AvatarUp: { totalDraws: 24, pity: 8, cards: [], fiveStars: [{
    id: priorId, item: { item_id: 1003, name: "姬子", item_type: "ItemType_Avatar" }, gacha_count: 16, is_up: false,
  }] } },
});

const preload = `
Bun.env.LOTUS_PROFILE_DIR = "./profiles";
Bun.env.LOTUS_STAR_RAIL_GACHA_THEME_DIR = "./data/starrail/theme";
const native = globalThis.fetch;
const { appendFileSync } = require("node:fs");
globalThis.fetch = async (input, options) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return native(input, options);
  const endpoint = url.pathname.split("/").at(-1);
  if (endpoint === "account" && url.pathname === "/common/badge/v1/login/account" && url.origin === "https://api-takumi.mihoyo.com") {
    const role = JSON.parse(options.body);
    if (role.uid !== ${JSON.stringify(uid)} || role.region !== "prod_gf_cn") throw Error("unexpected role");
    appendFileSync("seen-badge", role.uid + "\\n");
    while (await Bun.file("hold-first").exists() && !await Bun.file("release-first").exists()) await Bun.sleep(10);
    return Response.json({ retcode: 0 }, { headers: { "Set-Cookie": "e_hkrpg_token=fixture-ephemeral; Secure" } });
  }
  if (url.origin !== "https://act-api-takumi.mihoyo.com") throw Error("isolated fixture has no network");
  if (url.searchParams.get("uid") !== ${JSON.stringify(uid)}) throw Error("wrong role");
  if (endpoint === "brief" && await Bun.file("rate-limit").exists())
    return Response.json({ retcode: -100, message: "visit too frequently, cookie_token=withheld-fixture" });
  if (endpoint === "brief") return Response.json({retcode:0, data:{items:[]}});
  const avatar = url.searchParams.get("gacha_type") === "GachaType_AvatarUp";
  if (endpoint === "pool_stat") return Response.json({retcode:0,data:{cards:avatar ? [{gacha_id:"fixture-period",total_count:25}] : []}});
  if (endpoint === "five_star_list") return Response.json({retcode:0,data:{list:avatar ? [{
    id:${JSON.stringify(nextId)},item:{item_id:1003,name:"姬子",item_type:"ItemType_Avatar"},gacha_count:9,is_up:true,
  }] : [],has_more:false}});
  throw Error("unexpected endpoint");
};
`;

async function put(root: string, file: string, text: string) {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), text);
}

for (const rendering of [false, true]) test.skipIf(rendering && !gpu.available)(`星铁旧档、国服汇总成功、同 UID 拒绝重入与限频后查询通过真实双协议 [${rendering ? "GPU" : "functional"}]`, async () => {
  await withDualGatewayFixture("starrail-gacha-update-fixture", "disablePrivate: false\n", async ({ root, sendOneBot, sendMilky, onebot, milky }) => {
    const simulateAck = async (queue: typeof onebot, action: string, id: number, wanted?: string) => {
      const frame = await queue.next(action);
      frame.respond({ message_id: id, message_seq: id });
      const serialized = JSON.stringify(frame.params);
      if (wanted) expect(serialized).toContain(wanted);
      return serialized;
    };
    const png = async (id: number) => {
      const result = await simulateAck(onebot, "send_msg", id);
      const content = /base64:\/\/([A-Za-z0-9+/=]+)/u.exec(result)?.[1];
      if (rendering && !content) throw Error(result.slice(0, 400));
      if (!rendering) { expect(content).toBeUndefined(); if(id===5)expect(result).toContain("新增 1 条五星记录"); }
      const evidence = Bun.env.LOTUS_SR_UPDATE_EVIDENCE;
      if (evidence && content) await Bun.write(join(evidence, `card-${id}.png`), Buffer.from(content, "base64"));
      expect(result).not.toContain("withheld-fixture");
    };
    sendOneBot("*逐抽记录");
    await simulateAck(onebot, "send_msg", 1, "显示用汇总记录");
    expect(await readFile(join(root, path), "utf8")).toBe(legacy);
    await put(root, "hold-first", "true");
    sendOneBot("*更新抽卡记录");
    await simulateAck(onebot, "send_msg", 2, "正在更新星铁抽卡记录（档案 1）");
    for (let attempt = 0; attempt < 100 && !await Bun.file(join(root, "seen-badge")).exists(); attempt++) await Bun.sleep(10);
    expect(await Bun.file(join(root, "seen-badge")).exists()).toBe(true);
    sendOneBot("*更新抽卡记录2");
    await simulateAck(onebot, "send_msg", 3, "正在更新星铁抽卡记录（档案 2）");
    await simulateAck(onebot, "send_msg", 4, "该账号的星铁抽卡记录正在更新");
    expect((await readFile(join(root, "seen-badge"), "utf8")).trim()).toBe(uid);
    await put(root, "release-first", "true");
    await png(5);
    const saved = await readFile(join(root, current), "utf8");
    expect(JSON.parse(saved).pools.GachaType_AvatarUp.fiveStars.map((record: { id: string }) => record.id)).toEqual([nextId, priorId]);
    expect(await readFile(join(root, path), "utf8")).toBe(legacy);
    expect(saved).not.toContain("fixture-ephemeral");
    await put(root, "rate-limit", "true");
    sendOneBot("*更新抽卡记录2");
    await simulateAck(onebot, "send_msg", 6, "正在更新星铁抽卡记录（档案 2）");
    await png(7);
    expect(await readFile(join(root, current), "utf8")).toBe(saved);
    expect(await readFile(join(root, path), "utf8")).toBe(legacy);
    sendOneBot("*抽卡记录");
    await png(8);
    await sendMilky("*逐抽记录");
    await simulateAck(milky, "send_private_message", 9, "显示用汇总记录");
    await sendMilky("*抽卡记录");
    const local = await simulateAck(milky, "send_private_message", 10);
    expect(local).toContain(rendering ? "base64://" : "原版详情图暂时无法生成");
    if (rendering) {
    const multi = JSON.parse(saved);
    // No ordinary character pool: the all-records path must still include both collab pools.
    multi.pools = {
      GachaType_CollabAvatarUp: { totalDraws: 4, fiveStars: [{ id: "collab-role", item: { item_id: 1003, name: "姬子", item_type: "ItemType_Avatar" }, gacha_count: 4 }] },
      GachaType_CollabEquipmentUp: { totalDraws: 7, fiveStars: [{ id: "collab-cone", item: { name: "只需等待", item_type: "ItemType_Equipment" }, gacha_count: 7 }] },
    };
    await put(root, current, JSON.stringify(multi));
    sendOneBot("*抽卡记录");
    const frame = await onebot.next("send_private_forward_msg");
    const nodes = frame.params.messages as { data: { content: unknown } }[];
    expect(nodes).toHaveLength(3);
    expect(JSON.stringify(nodes[0])).not.toMatch(/分\d+张图/u);
    const images = nodes.slice(1).map(node => /base64:\/\/([A-Za-z0-9+/=]+)/u.exec(JSON.stringify(node))?.[1]);
    expect(images.every(Boolean)).toBe(true);
    frame.respond({ message_id: 11 });
    for (const [index, image] of images.entries()) {
      if (image && Bun.env.LOTUS_SR_UPDATE_EVIDENCE) await Bun.write(join(Bun.env.LOTUS_SR_UPDATE_EVIDENCE, `miao-collab-${index + 1}.png`), Buffer.from(image, "base64"));
    }
    sendOneBot("*联动角色记录");
    await png(12);
    sendOneBot("*联动光锥记录");
    await png(13);
    multi.pools = { GachaType_Newbie: { totalDraws: 10, fiveStars: [{ id: "newbie", item: { item_id: 1003, name: "姬子", item_type: "ItemType_Avatar" }, gacha_count: 10 }] } };
    await put(root, current, JSON.stringify(multi));
    sendOneBot("*全部记录");
    await png(14);
    const engines = (await readFile(join(root, "renderers.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(engines.length).toBeGreaterThan(0);
    if (Bun.env.LOTUS_SR_UPDATE_EVIDENCE) {
      await Bun.write(join(Bun.env.LOTUS_SR_UPDATE_EVIDENCE, "renderers.json"), JSON.stringify(engines, null, 2));
    }
    }
  }, 10_000, preload + (rendering ? physicalRenderingPreload : functionalRenderingPreload), async root => {
    const plugin = join(import.meta.dir, "../plugins/starrail");
    const installed = join(root, "plugins/starrail");
    await cp(plugin, installed, { recursive: true, filter: file => ![".git", "node_modules", "test"].includes(basename(file)) });
    await symlink(join(plugin, "node_modules"), join(installed, "node_modules"), "dir");
    await linkHostPackages(root);
    await linkHostBuiltinResources(root);
    const theme = join(root, "data/starrail/theme");
    for (const font of ["HYWH-65W.ttf", "NZBZ.ttf", "tttgbnumber.ttf"]) {
      await mkdir(join(theme, "common/font"), { recursive: true });
      await cp(join(plugin, "monthly-theme/statistics/tttgbnumber.ttf"), join(theme, "common/font", font));
    }
    for (const asset of ["common/bg/bg-sr.webp", "meta-sr/character/common/imgs/banner.webp",
      "gacha/imgs/date-icon.webp", "common/item/bg5.png", "gacha/imgs/no-avatar.webp"]) {
      const target = join(theme, asset);
      await mkdir(dirname(target), { recursive: true });
      await cp(join(plugin, "monthly-theme/online/logo.png"), target);
    }
    await put(root, "config/global.yaml", "coin_shop: {enable: false}\nscheduler: {enable: false}\n");
    for (const [qq, id] of [[42, 1], [42, 2], [43, 1]] as const) {
      await put(root, `profiles/${qq}${id === 1 ? "" : `-${id}`}.yaml`, Bun.YAML.stringify({
        user: { qq: String(qq) }, profile: { id }, account: {
          stuid: String(qq), stoken: "fixture-local-session", cookie: `account_id=${qq};cookie_token=fixture-cookie`,
          game_roles: { sr: [{ uid, region: "prod_gf_cn", game_biz: "hkrpg_cn" }] }, current_uid: { sr: uid },
        }, device: { id: "fixture-device" },
      }));
    }
    await put(root, path, legacy);
    await put(root, path.replace("/42/", "/43/"), legacy.replace('"qq":"42"', '"qq":"43"'));
  });
}, 40_000);
