import { linkHostPackages } from "./host-fixture.ts";
import { expect, test } from "bun:test";
import { cp, mkdir, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const privateUid = "100008042", publicUid = "100008043", reloadUid = "100008044";
const proof = Bun.env.LOTUS_PUBLIC_PANEL_GPU_PROOF;
const skia = join(import.meta.dir, "../packages/skia/node_modules/skia-canvas/lib/index.js");
const preload = `
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
Bun.env.LOTUS_PROFILE_DIR = "./profiles";
Bun.env.LOTUS_GENSHIN_PANEL_THEME_DIR = "./theme";
Bun.env.LOTUS_GENSHIN_PANEL_DIR = "./panels";
Bun.env.LOTUS_GENSHIN_LEGACY_PANEL_DIR = "./legacy";
Bun.env.LOTUS_GENSHIN_SHOWCASE_DIR = "./public";
Bun.env.LOTUS_GENSHIN_SHOWCASE_SERVER = "0";
${proof ? `
import { Canvas } from ${JSON.stringify(skia)};
Bun.env.VK_DRIVER_FILES = "/usr/share/vulkan/icd.d/nvidia_icd.json";
const toBuffer = Canvas.prototype.toBuffer;
Canvas.prototype.toBuffer = async function (...args) {
  const image = await toBuffer.call(this, ...args);
  const { renderer, api, device, driver } = this.engine;
  assert.equal(renderer, "GPU");
  assert.equal(api, "Vulkan");
  assert.match(device, /RTX A4000/u);
  appendFileSync("./engine.jsonl", JSON.stringify({ renderer, api, device, driver }) + "\\n");
  return image;
};
` : ""}
const native = globalThis.fetch;
globalThis.fetch = Object.assign(async (input, options) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname === "127.0.0.1") return native(input, options);
  const headers = new Headers(options?.headers);
  if (url.hostname === "profile.microgg.cn") {
    assert.equal(options.method, "GET");
    assert.equal(options.credentials, "omit");
    assert.equal(headers.has("Cookie"), false);
    assert.equal(headers.has("Authorization"), false);
    assert.equal(options.body, undefined);
    const uid = url.pathname.split("/").at(-1);
    appendFileSync("./queries", uid + "\\n");
    return Response.json({ uid, ttl: 60, playerInfo: { nickname: "fixture", signature: "discard this" },
      avatarInfoList: [{ avatarId: 10000089, propMap: { 4001: { val: "90" } }, fightPropMap: { 2000: 15000 },
        equipList: [{ itemId: 11513, flat: { itemType: "ITEM_WEAPON" }, weapon: { level: 90 } }] }] });
  }
  if (url.pathname === "/game_record/app/genshin/api/character/list") {
    assert.match(headers.get("Cookie"), /cookie_token=synthetic-token/u);
    appendFileSync("./queries", "official\\n");
    return Response.json({ retcode: 0, data: { list: [] } });
  }
  throw Error("非夹具请求");
}, { preconnect: native.preconnect });
`;

async function prepare(root: string) {
  const source = join(import.meta.dir, "../plugins/genshin"), target = join(root, "plugins/genshin");
  await cp(source, target, { recursive: true, filter: file => ![".git", "node_modules"].includes(basename(file)) });
  await symlink(join(source, "node_modules"), join(target, "node_modules"), "dir");
  await linkHostPackages(root);
  await mkdir(join(root, "profiles"));
  await mkdir(join(root, "theme/meta-gs/character"), { recursive: true });
  await writeFile(join(root, "theme/meta-gs/character/data.json"), JSON.stringify({
    10000089: { name: "芙宁娜", elem: "hydro", star: 5 },
  }));
  await mkdir(join(root, "theme/meta-gs/weapon/sword"), { recursive: true });
  await writeFile(join(root, "theme/meta-gs/weapon/sword/data.json"), JSON.stringify({ 11513: { name: "静水流涌之辉" } }));
  for (const [id, uid] of [[1, privateUid], [2, reloadUid]] as const) {
    await writeFile(join(root, "profiles", id === 1 ? "42.yaml" : "42-2.yaml"), Bun.YAML.stringify({
      user: { qq: "42" }, profile: { id }, account: {
        ltuid: "900001", stuid: "900001", stoken: "synthetic-stoken",
        cookie: "account_id=900001;cookie_token=synthetic-token",
        game_roles: { gs: [{ uid, region: "cn_gf01", game_biz: "hk4e_cn" }] }, current_uid: { gs: uid },
      },
    }));
  }
}

async function assertPicture(params: unknown, file: string) {
  const text = JSON.stringify(params);
  const encoded = /base64:\/\/([A-Za-z0-9+/=]+)/u.exec(text)?.[1];
  if (!encoded) throw new Error(text);
  expect(encoded).toBeDefined();
  const png = Uint8Array.fromBase64(encoded!);
  expect(await new Bun.Image(png).metadata()).toMatchObject({ format: "png" });
  if (proof) await Bun.write(join(proof, file + ".png"), png);
}

test("原神双协议冷读遵守提示回执，重载走选中档案，官方更新独立", async () => {
  await withDualGatewayFixture("public-panel", "disablePrivate: false\n", async ({ root, onebot, milky, sendOneBot, sendMilky }) => {
    const requests = async () => Bun.file(join(root, "queries")).text().catch(() => "");
    sendOneBot("#面板");
    const denied = await onebot.next("send_msg");
    expect(JSON.stringify(denied.params)).toContain("仅发送游戏 UID");
    expect(await requests()).toBe("");
    denied.respond({}, "failed");
    const absent = await onebot.next("send_msg");
    expect(JSON.stringify(absent.params)).toContain("本地暂无原神角色面板");
    absent.respond({ message_id: 61 });
    expect(await requests()).toBe("");

    sendOneBot("#原神面板列表");
    const pending = await onebot.next("send_msg");
    expect(JSON.stringify(pending.params)).toContain("仅发送游戏 UID");
    expect(await requests()).toBe("");
    pending.respond({ message_id: 62 });
    const list = await onebot.next("send_msg");
    await assertPicture(list.params, "onebot-cold");
    list.respond({ message_id: 63 });

    await sendMilky(`#面板列表${publicUid}`);
    const notice = await milky.next("send_private_message");
    expect(JSON.stringify(notice.params)).toContain("仅发送游戏 UID");
    notice.respond({ message_seq: 64 });
    const publicList = await milky.next("send_private_message");
    await assertPicture(publicList.params, "milky-explicit-public-uid");
    publicList.respond({ message_seq: 65 });

    sendOneBot("#重载面板2");
    const reloadNotice = await onebot.next("send_msg");
    expect(JSON.stringify(reloadNotice.params)).toContain("仅发送游戏 UID");
    reloadNotice.respond({ message_id: 66 });
    const reloaded = await onebot.next("send_msg");
    await assertPicture(reloaded.params, "onebot-reload-slot-2");
    reloaded.respond({ message_id: 67 });

    sendOneBot("#更新面板");
    const official = await onebot.next("send_msg");
    expect(JSON.stringify(official.params)).toContain("米游社没有返回");
    official.respond({ message_id: 68 });
    expect((await requests()).trim().split("\n")).toEqual([privateUid, publicUid, reloadUid, "official"]);
    expect(await Bun.file(join(root, "panels/42", privateUid + ".json")).exists()).toBe(false);
    const stored = await Bun.file(join(root, "public/43", publicUid + ".json")).text();
    expect(stored).not.toContain("discard this");
    if (proof) await Bun.write(join(proof, "engine.jsonl"), Bun.file(join(root, "engine.jsonl")));
  }, 8_000, preload, prepare);
}, 38_000);
