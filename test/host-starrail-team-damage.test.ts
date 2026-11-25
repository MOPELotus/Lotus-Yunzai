import { linkHostPackages } from "./host-fixture.ts";
import { expect, test } from "bun:test";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const uid = "100000731", otherUid = "100000732";
const archive = `data/starrail/panels/42/${uid}.json`;
const otherArchive = `data/starrail/panels/43/${uid}.json`;
const input = "{corrupt synthetic panel";
const available = JSON.stringify({ version: 1, uid, source: "miyoushe", updatedAt: "2026-11-20T10:00:00Z", avatars: [{
  id: "1220", name: "飞霄", element: "风", path: "巡猎", level: 80, rank: 3,
  face: "", splash: "", stars: [], traces: [], relics: [],
  skills: [{ key: "a", level: 7, original: 6, icon: "" }, { key: "q", level: 12, icon: "" }],
  stats: [{ key: "atk", base: "1440", value: "2700" }, { key: "speed", base: "112", value: "143" }],
}] });
const discard = JSON.stringify({ version: 1, uid, source: "miyoushe", updatedAt: "2026-11-21T10:00:00Z", avatars: [],
  panelDiscardedAt: Date.parse("2026-11-21T10:00:00Z") });
const proof = Bun.env.LOTUS_SR_TEAM_TEST_PROOF;
const modulePath = join(import.meta.dir, "../plugins/starrail");
const skia = join(modulePath, "node_modules/skia-canvas/lib/index.js");
const preload = `
import { appendFileSync } from "node:fs";
import assert from "node:assert/strict";
import { Canvas } from ${JSON.stringify(skia)};
Bun.env.LOTUS_PROFILE_DIR = "./profiles";
Bun.env.LOTUS_STAR_RAIL_PANEL_THEME_DIR = "./theme";
Bun.env.LOTUS_STAR_RAIL_LEGACY_PANEL_DIR = "./legacy";
const native = globalThis.fetch;
globalThis.fetch = Object.assign((input, options) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return native(input, options);
  appendFileSync("./unwanted-network", url.origin + "\\n");
  throw Error("isolated team fixture forbids outbound requests");
}, { preconnect: native.preconnect });
${proof ? `
Bun.env.VK_DRIVER_FILES = "/usr/share/vulkan/icd.d/nvidia_icd.json";
const toBuffer = Canvas.prototype.toBuffer;
Canvas.prototype.toBuffer = async function (...args) {
  const output = await toBuffer.call(this, ...args);
  assert.equal(this.engine.renderer, "GPU");
  assert.equal(this.engine.api, "Vulkan");
  assert.match(this.engine.device, /RTX A4000/u);
  appendFileSync("./engines.jsonl", JSON.stringify(this.engine) + "\\n");
  return output;
};
` : ""}
`;

async function write(root: string, file: string, value: string) {
  const target = join(root, file);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, value);
}

async function prepare(root: string) {
  const installed = join(root, "plugins/starrail");
  await cp(modulePath, installed, { recursive: true, filter: item => ![".git", "node_modules", "test"].includes(basename(item)) });
  await symlink(join(modulePath, "node_modules"), join(installed, "node_modules"), "dir");
  await linkHostPackages(root);
  if (proof && await Bun.file(join(proof, "theme/character/imgs/bg-02.jpg")).exists()) {
    await cp(join(proof, "theme"), join(root, "theme"), { recursive: true });
  }
  for (const [qq, profile, selected] of [[42, 2, uid], [43, 2, otherUid]] as const) {
    await write(root, `profiles/${qq}-${profile}.yaml`, Bun.YAML.stringify({ user: { qq: String(qq) }, profile: { id: profile }, account: {
      cookie: `cookie_token=team-${qq}`, stuid: String(qq), stoken: "fixture-session",
      game_roles: { sr: [{ uid: selected, region: "prod_gf_cn", game_biz: "hkrpg_cn" }] }, current_uid: { sr: selected },
    } }));
  }
  await write(root, archive, input);
  await write(root, otherArchive, available);
}

function image(frame: unknown) {
  const base64 = /base64:\/\/([A-Za-z\d+/=]+)/u.exec(JSON.stringify(frame))?.[1];
  if (!base64) throw new Error(JSON.stringify(frame).slice(0, 300));
  return Buffer.from(base64, "base64");
}

test("星铁队伤本人面板拒读时继续默认配装，保持隔离和两种出图协议", async () => {
  await withDualGatewayFixture("starrail-team-damage-recheck", "disablePrivate: false\n", async ({ root, sendOneBot, onebot, sendMilky, milky }) => {
    const group = { message_type: "group", sub_type: "normal", group_id: 601 };
    const command = "*队伤2飞托阮同 3轮 5敌";
    sendOneBot(command, group);
    const fallback = await onebot.next("send_msg");
    expect(fallback.params.group_id).toBe(601);
    fallback.respond({ message_id: 51 });
    const fallbackPng = image(fallback.params);
    expect(fallbackPng.readUInt32BE(16)).toBe(2880);
    expect(await readFile(join(root, archive), "utf8")).toBe(input);
    expect(await readFile(join(root, otherArchive), "utf8")).toBe(available);
    sendOneBot(`*队伤2 ${otherUid} 飞霄`);
    const wrong = await onebot.next("send_msg");
    expect(JSON.stringify(wrong.params)).toContain("UID 与所选档案当前绑定");
    wrong.respond({ message_id: 52 });

    await write(root, archive, available);
    expect((await sendMilky("#星铁伤害过程 飞霄 托帕 2", { sender_id: 42, peer_id: 42 })).status).toBe(200);
    const owned = await milky.next("send_private_message");
    expect(owned.params.user_id).toBe(42);
    owned.respond({ message_seq: 53 });
    const ownedPng = image(owned.params);
    expect(ownedPng.readUInt32BE(16)).toBe(2880);
    expect(ownedPng.readUInt32BE(20)).toBeGreaterThan(fallbackPng.readUInt32BE(20));
    expect(await readFile(join(root, archive), "utf8")).toBe(available);

    await write(root, archive, discard);
    await write(root, `legacy/${uid}.json`, "{旧档不得复活");
    sendOneBot(command, group);
    const deleted = await onebot.next("send_msg");
    deleted.respond({ message_id: 54 });
    const deletedPng = image(deleted.params);
    expect(deletedPng.readUInt32BE(16)).toBe(2880);
    expect(Buffer.compare(deletedPng, fallbackPng)).not.toBe(0);
    expect(await readFile(join(root, archive), "utf8")).toBe(discard);
    expect(await readFile(join(root, `legacy/${uid}.json`), "utf8")).toBe("{旧档不得复活");
    expect(await Bun.file(join(root, "unwanted-network")).exists()).toBe(false);
    if (proof) {
      await Bun.write(join(proof, "unreadable.png"), fallbackPng);
      await Bun.write(join(proof, "owned-detail.png"), ownedPng);
      await Bun.write(join(proof, "discarded.png"), deletedPng);
      await cp(join(root, "engines.jsonl"), join(proof, "engines.jsonl"));
    }
  }, 12_000, preload, prepare);
}, 45_000);
