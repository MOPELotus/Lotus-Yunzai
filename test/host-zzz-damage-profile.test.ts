import { expect, test } from "bun:test";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const first = "82521041", second = "82521042";
const avatar = {
  id: 1011, name_mi18n: "安比", level: 30, rank: 0, rarity: "A", avatar_profession: 2, element_type: 203,
  skills: [0, 1, 2, 3, 5, 6].map(skill_type => ({ skill_type, level: 1 })),
  properties: [
    ["生命值", "1000"], ["攻击力", "100"], ["防御力", "100"], ["冲击力", "100"], ["暴击率", "0%"],
    ["暴击伤害", "10%"], ["异常掌控", "100"], ["异常精通", "100"], ["能量自动回复", "1.20"], ["穿透率", "0%"],
  ].map(([property_name, final]) => ({ property_name, base: "", final })),
};
const proof = Bun.env.LOTUS_PROFILE_BRIDGE_PROOF;
const modulePath = join(import.meta.dir, "../plugins/zzz");
const preload = `
import { appendFileSync } from "node:fs";
import assert from "node:assert/strict";
import { Canvas } from ${JSON.stringify(join(modulePath, "node_modules/skia-canvas/lib/index.js"))};
Bun.env.LOTUS_PROFILE_DIR = "./profiles";
Bun.env.LOTUS_SKIA_MODE = "gpu";
const original = globalThis.fetch;
globalThis.fetch = Object.assign((input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return original(input, init);
  if (url.hostname === "q1.qlogo.cn") return Promise.resolve(new Response(null, { status: 404 }));
  throw new Error("isolated fixture has no private upstream access");
}, { preconnect: original.preconnect });
${proof ? `
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
const region = "prod_gf_cn";
const path = `data/zzzPanels/${region}/42/${second}.json`;
const panelData = JSON.stringify({ version: 1, uid: second, region, avatars: [avatar] });
async function write(root: string, entry: string, data: string) {
  const file = join(root, entry);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, data);
}
async function prepare(root: string) {
  const target = join(root, "plugins/zzz");
  await cp(modulePath, target, { recursive: true, filter: item => ![".git", "node_modules", "test"].includes(basename(item)) });
  await symlink(join(modulePath, "node_modules"), join(target, "node_modules"), "dir");
  await symlink(join(import.meta.dir, "../packages"), join(root, "packages"), "dir");
  for (const [qq, id, uid] of [[42, 1, first], [42, 2, second], [43, 1, second]] as const) {
    await write(root, `profiles/${qq}${id === 1 ? "" : "-" + id}.yaml`, Bun.YAML.stringify({ user: { qq: String(qq) },
      profile: { id }, account: { game_roles: { zzz: [{ uid, region, game_biz: "nap_cn" }] }, current_uid: { zzz: uid } },
    }));
  }
  await write(root, path, panelData);
}

function bytes(frame: unknown) {
  const content = /base64:\/\/([A-Za-z\d+/=]+)/u.exec(JSON.stringify(frame))?.[1];
  expect(content).toBeDefined();
  const png = Buffer.from(content!, "base64");
  expect(png.readUInt32BE(16)).toBe(3360);
  return png;
}

test("绝区零伤害旧裸档号和显式技能经过真实双协议，按 QQ 选本人面板", async () => {
  await withDualGatewayFixture("zzz-old-damage-profile", "disablePrivate: false\n", async ({ root, sendOneBot, sendMilky, onebot, milky }) => {
    sendOneBot("%安比伤害2");
    const old = await onebot.next("send_msg");
    old.respond({ message_id: 11 });
    const defaultSkill = bytes(old.params);
    expect((await sendMilky("#绝区零安比伤害技能2 档案2", { sender_id: 42, peer_id: 42 })).status).toBe(200);
    const explicit = await milky.next("send_private_message");
    explicit.respond({ message_seq: 12 });
    const requestedSkill = bytes(explicit.params);
    expect(defaultSkill.equals(requestedSkill)).toBe(false);
    expect((await sendMilky("#绝区零安比伤害1")).status).toBe(200);
    const missing = await milky.next("send_private_message");
    expect(missing.params.user_id).toBe(43);
    expect(JSON.stringify(missing.params)).toContain("角色安比不存在");
    missing.respond({ message_seq: 13 });
    sendOneBot("%安比伤害1");
    const firstProfile = await onebot.next("send_msg");
    expect(JSON.stringify(firstProfile.params)).toContain("角色安比不存在");
    firstProfile.respond({ message_id: 14 });
    expect(await readFile(join(root, path), "utf8")).toBe(panelData);
    if (proof) {
      await Bun.write(join(proof, "zzz-damage-default.png"), defaultSkill);
      await Bun.write(join(proof, "zzz-damage-skill2.png"), requestedSkill);
      await cp(join(root, "engines.jsonl"), join(proof, "zzz-engines.jsonl"));
    }
  }, 18_000, preload, prepare);
}, 50_000);
