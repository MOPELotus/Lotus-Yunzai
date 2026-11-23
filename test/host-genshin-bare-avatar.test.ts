import { expect, test } from "bun:test";
import { cp, mkdir, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const proof = Bun.env.LOTUS_BARE_ROLE_PROOF;
const engineEntry = join(import.meta.dir, "../packages/skia/node_modules/skia-canvas/lib/index.js");
const preload = `
Bun.env.LOTUS_ATLAS_DATA_DIR = "./catalog";
Bun.env.LOTUS_GENSHIN_PANEL_THEME_DIR = "./theme";
Bun.env.LOTUS_CHARACTER_GALLERY_DIR = "./gallery";
Bun.env.LOTUS_PROFILE_DIR = "./profiles";
${proof ? `
import { Canvas } from ${JSON.stringify(engineEntry)};
Bun.env.VK_DRIVER_FILES = "/usr/share/vulkan/icd.d/nvidia_icd.json";
const toBuffer = Canvas.prototype.toBuffer;
Canvas.prototype.toBuffer = async function (...args) {
  const engine = this.engine;
  if (engine.renderer !== "GPU" || engine.api !== "Vulkan" || !engine.device?.includes("RTX A4000")) throw Error("没有启用物理显卡");
  await Bun.write("./engine.json", JSON.stringify(engine));
  return toBuffer.call(this, ...args);
};
` : ""}
const fetchBase = globalThis.fetch;
globalThis.fetch = Object.assign((input, options) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") throw Error("夹具不请求外网");
  return fetchBase(input, options);
}, { preconnect: fetchBase.preconnect });
`;

async function prepare(root: string) {
  for (const name of ["atlas", "genshin"]) {
    const source = join(import.meta.dir, "../plugins", name), target = join(root, "plugins", name);
    await cp(source, target, { recursive: true, filter: file => ![".git", "node_modules"].includes(basename(file)) });
    await symlink(join(source, "node_modules"), join(target, "node_modules"), "dir");
  }
  await symlink(join(import.meta.dir, "../packages"), join(root, "packages"), "dir");
  await mkdir(join(root, "config", "config"), { recursive: true });
  await writeFile(join(root, "config/config/group.yaml"),
    'default: { groupCD: 0, singleCD: 0, onlyReplyAt: 0 }\n"79": { disable: ["[genshin] 角色卡片"] }\n');
  for (const directory of ["profiles", "catalog/items", "gallery/gs-character/胡桃", "theme/meta-gs/character", "config/character-aliases"]) {
    await mkdir(join(root, directory), { recursive: true });
  }
  await writeFile(join(root, "config/character-aliases/alias_gs.cfg"), "胡桃：核核苗\n");
  await Bun.write(join(root, "gallery/gs-character/胡桃/原图.png"),
    Uint8Array.fromBase64("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVQIW2P8/x8AAwMCAO+a2e8AAAAASUVORK5CYII="));
  await writeFile(join(root, "theme/meta-gs/character/data.json"), JSON.stringify({ 10000046: { name: "胡桃", elem: "pyro" } }));
  for (const [qq, slot, uid] of [[42, 1, "100004042"], [42, 3, "100008042"], [43, 1, "100004043"]] as const) {
    const account = String(900000000 + qq + slot);
    await writeFile(join(root, "profiles", `${qq}${slot === 1 ? "" : "-" + slot}.yaml`), Bun.YAML.stringify({
      user: { qq: String(qq) }, profile: { id: slot }, account: {
        stuid: account, ltuid: account, stoken: "fixture", ltoken: "fixture",
        cookie: `account_id=${account};cookie_token=fixture;ltuid=${account};ltoken=fixture`,
        game_roles: { gs: [{ uid, region: "cn_gf01", game_biz: "hk4e_cn" }] }, current_uid: { gs: uid },
      },
    }));
    const archive = join(root, "data", "genshin", "panels", String(qq));
    await mkdir(archive, { recursive: true });
    await writeFile(join(archive, uid + ".json"), JSON.stringify({ uid, avatars: {
      10000046: { id: 10000046, name: "胡桃", level: 90, elem: "pyro", _source: "enka" },
    } }));
  }
  const entries = [["gi", "101", "胡桃"], ["hsr", "102", "卡芙卡"]] as const;
  await writeFile(join(root, "catalog/map.json"), JSON.stringify({ games: Object.fromEntries(entries.map(([game, id, name]) =>
    [game, { locales: { zh: { pages: { character: { version: "1", recordCount: 1,
      records: { [id]: { id, name, rarity: "五星", path: `items/${id}.json` } },
    } } } } }])) }));
  for (const [gameId, id, name] of entries) {
    await writeFile(join(root, "catalog/items", id + ".json"), JSON.stringify({
      meta: { gameId, pageId: "character", recordId: id, version: "1" },
      content: { detail: { desc: name + "公开图鉴夹具" } },
    }));
  }
}

async function picture(params: unknown, label: string, atlas = false) {
  const text = JSON.stringify(params);
  const match = /base64:\/\/([A-Za-z0-9+/=]+)/u.exec(text)?.[1];
  expect(match).toBeDefined();
  const png = Uint8Array.fromBase64(match!);
  const dims = await new Bun.Image(png).metadata();
  expect(dims.format).toBe("png");
  if (atlas) expect(dims.width).toBe(3200);
  if (proof) await Bun.write(join(proof, label + ".png"), png);
}

test("原神旧裸名优先角色卡，星铁裸名与明确图鉴走公开 Atlas", async () => {
  await withDualGatewayFixture("bare-avatar-fixed", "disablePrivate: false\n", async ({ root, onebot, milky, sendOneBot, sendMilky }) => {
    const group = { message_type: "group", sub_type: "normal", group_id: 77 };
    sendOneBot("#胡桃", { ...group, user_id: 44 });
    const missing = await onebot.next("send_msg");
    expect(JSON.stringify(missing.params)).toContain("请先登录并同步本人原神档案 1");
    missing.respond({ message_id: 61 });
    sendOneBot("#胡桃", group);
    const bare = await onebot.next("send_msg");
    await picture(bare.params, "onebot-role-card");
    bare.respond({ message_id: 62 });
    sendOneBot("#核核苗", group);
    const alias = await onebot.next("send_msg");
    await picture(alias.params, "onebot-custom-alias");
    alias.respond({ message_id: 69 });
    sendOneBot("#100008042核核苗卡片", group);
    const owned = await onebot.next("send_msg");
    await picture(owned.params, "onebot-explicit-uid");
    owned.respond({ message_id: 63 });
    sendOneBot("#核核苗卡片100004043", group);
    const foreign = await onebot.next("send_msg");
    expect(JSON.stringify(foreign.params)).toContain("只可查询本人");
    foreign.respond({ message_id: 64 });

    sendOneBot("#胡桃图鉴", { ...group, user_id: 44 });
    const atlas = await onebot.next("send_group_forward_msg");
    expect(JSON.stringify(atlas.params)).toContain("胡桃完整图鉴");
    await picture(atlas.params, "onebot-explicit-atlas", true);
    atlas.respond({ message_id: 65, forward_id: "fixture-public" });
    sendOneBot("#胡桃", { ...group, group_id: 79 });
    const permittedPublic = await onebot.next("send_group_forward_msg");
    expect(JSON.stringify(permittedPublic.params)).toContain("胡桃完整图鉴");
    permittedPublic.respond({ message_id: 66, forward_id: "fixture-restricted" });

    await writeFile(join(root, "config/character-aliases/alias_gs.cfg"), "胡桃：新核核苗\n");
    await sendMilky("#新核核苗100004043");
    const ownMilky = await milky.next("send_private_message");
    await picture(ownMilky.params, "milky-role-card");
    ownMilky.respond({ message_seq: 67 });
    for (const [input, label] of [["*卡芙卡", "milky-bare-atlas"], ["*卡芙卡图鉴", "milky-explicit-atlas"]]) {
      await sendMilky(input!);
      const rail = await milky.next("send_private_message");
      expect(JSON.stringify(rail.params)).toContain("卡芙卡完整图鉴");
      await picture(rail.params, label!, true);
      rail.respond({ message_seq: 68 });
    }
    if (proof) await Bun.write(join(proof, "engine.json"), Bun.file(join(root, "engine.json")));
  }, 8_000, preload, prepare);
}, 25_000);
