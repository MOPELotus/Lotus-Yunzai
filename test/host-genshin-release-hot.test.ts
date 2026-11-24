import { expect, test } from "bun:test";
import { cp, mkdir, rename, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const uid = "123456789";
const roster = [[10000089, "芙宁娜", "嘟嘟可故事集"], [10000042, "刻晴", "祭礼残章"]].map(([id, name, weapon]) => ({
  id, name, level: 90, rarity: 5, weapon: { name: weapon, rarity: 4, affix_level: 5, level: 90, type_name: "法器" },
}));
const counts = { common_chest_number: 1000, exquisite_chest_number: 1000, precious_chest_number: 1000,
  luxurious_chest_number: 1000, magic_chest_number: 1000, achievement_number: 100, cryoculus_number: 37 };
const skiaEntry = join(import.meta.dir, "../packages/skia/node_modules/skia-canvas/lib/index.js");
const proof = Bun.env.LOTUS_RELEASE_HOT_GPU_PROOF;
const preload = `
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { Canvas, CanvasRenderingContext2D } from ${JSON.stringify(skiaEntry)};
Bun.env.LOTUS_PROFILE_DIR = "./profiles";
Bun.env.LOTUS_GENSHIN_GACHA_RESOURCES_DIR = "./legacy/resources";
${proof ? `Bun.env.VK_DRIVER_FILES = "/usr/share/vulkan/icd.d/nvidia_icd.json";` : ""}
const native = globalThis.fetch;
const model = { uid: "${uid}", region: "cn_gf01" };
globalThis.fetch = Object.assign(async (input, options) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname === "127.0.0.1") return native(input, options);
  if (url.origin !== "https://api-takumi-record.mihoyo.com") throw Error("隔离禁止外部请求");
  assert.match(new Headers(options.headers).get("Cookie"), /cookie_token=local-fixture/u);
  if (url.pathname.endsWith("/character/list")) {
    assert.deepEqual(JSON.parse(options.body), { role_id: model.uid, server: model.region });
    return Response.json({ retcode: 0, data: { uid: model.uid, server: model.region, list: ${JSON.stringify(roster)} } });
  }
  assert.equal(url.searchParams.toString(), "role_id=" + model.uid + "&server=" + model.region);
  if (url.pathname.endsWith("/index")) return Response.json({ retcode: 0, data: { ...model, stats: ${JSON.stringify(counts)} } });
  if (url.pathname.endsWith("/basicInfo")) return Response.json({ retcode: 0, data: null });
  throw Error("未配置上游夹具");
}, { preconnect: native.preconnect });
const labels = new WeakMap();
const draw = CanvasRenderingContext2D.prototype.fillText;
CanvasRenderingContext2D.prototype.fillText = function (value, ...args) {
  const canvas = this.canvas;
  if (!labels.has(canvas)) labels.set(canvas, []);
  labels.get(canvas).push(String(value));
  return draw.call(this, value, ...args);
};
const write = Canvas.prototype.toBuffer;
Canvas.prototype.toBuffer = async function (...args) {
  const png = await write.call(this, ...args);
  const engine = this.engine;
  ${proof ? `assert.equal(engine.renderer, "GPU"); assert.equal(engine.api, "Vulkan"); assert.match(engine.device, /RTX A4000/u);` : ""}
  appendFileSync("./draws.jsonl", JSON.stringify({ labels: labels.get(this), renderer: engine.renderer,
    api: engine.api, device: engine.device ? String(engine.device) : undefined }) + "\\n");
  return png;
};
`;

async function prepare(root: string) {
  const source = join(import.meta.dir, "../plugins/genshin");
  const plugin = join(root, "plugins/genshin");
  await cp(source, plugin, { recursive: true, filter: path => ![".git", "node_modules"].includes(basename(path)) });
  await symlink(join(source, "node_modules"), join(plugin, "node_modules"), "dir");
  await symlink(join(import.meta.dir, "../packages"), join(root, "packages"), "dir");
  await mkdir(join(root, "profiles"), { recursive: true });
  for (const qq of [42, 43]) {
    await writeFile(join(root, "profiles", qq + ".yaml"), Bun.YAML.stringify({
      user: { qq: String(qq) }, account: { cookie: `account_id=${qq};cookie_token=local-fixture;ltuid=${qq};ltoken=fixture`,
        stuid: String(qq), stoken: "fixture", ltuid: String(qq), ltoken: "fixture",
        game_roles: { gs: [{ uid, region: "cn_gf01", game_biz: "hk4e_cn" }] }, current_uid: { gs: uid },
      },
    }));
  }
  await mkdir(join(plugin, "config"), { recursive: true });
  await writeFile(join(plugin, "config/role.index.yaml"), "common_chest: 111\n");
  await mkdir(join(root, "legacy/resources"), { recursive: true });
  await mkdir(join(root, "legacy/defSet/role"), { recursive: true });
  await mkdir(join(root, "legacy/defSet/weapon"), { recursive: true });
}

async function replace(root: string, file: string, yaml: string) {
  const path = join(root, "legacy/defSet", file);
  await writeFile(path + ".next", yaml);
  await rename(path + ".next", path);
}

function imageBytes(params: unknown) {
  const bytes = /base64:\/\/([A-Za-z0-9+/]+={0,2})/u.exec(JSON.stringify(params))?.[1];
  expect(bytes !== undefined).toBe(true);
  return Uint8Array.fromBase64(bytes!);
}

test("原神探索上限和活动武器名单经原始指令逐次热读，坏字段回退", async () => {
  await withDualGatewayFixture("genshin-release-hot", "disablePrivate: false\n", async ({ root, onebot, milky, sendOneBot, sendMilky }) => {
    const images: Uint8Array[] = [];
    for (let iteration = 0; iteration < 3; iteration++) {
      if (iteration === 1) {
        await replace(root, "role/index.yaml", "common_chest: 1800\ncryoculus: 196\nachievement: 2000\nmagic_chest: -1\n");
        await replace(root, "weapon/other.yaml", "actWeapon: [祭礼残章]\nsortName: { 祭礼残章: 无关字段 }\n");
      }
      if (iteration === 2) {
        await replace(root, "role/index.yaml", "common_chest: [bad]\n");
        await replace(root, "weapon/other.yaml", "actWeapon: [2]\n");
      }
      sendOneBot(["#探索", "#宝箱", "#探索度"][iteration]!);
      const one = await onebot.next("send_msg");
      images.push(imageBytes(one.params));
      one.respond({ message_id: 200 + iteration });
      expect((await sendMilky(["#四星武器", "#4星武器", "#原神四星武器"][iteration]!)).status).toBe(200);
      const mil = await milky.next("send_private_message");
      images.push(imageBytes(mil.params));
      mil.respond({ message_seq: 300 + iteration });
    }
    const raw = await Bun.file(join(root, "draws.jsonl")).text();
    const draw: { readonly labels: readonly string[] }[] = raw.trim().split("\n").map(line => JSON.parse(line));
    expect(draw).toHaveLength(6);
    const positions = (labels: readonly string[], name: string) => labels.indexOf(name);
    for (const [index, caps] of [[0, ["/3838", "/9109", "/140", "/1844"]], [2, ["/1800", "/7071", "/196", "/2000"]],
      [4, ["/3838", "/9109", "/140", "/1844"]]] as const) {
      const labels = draw[index]!.labels;
      for (const cap of caps) expect(labels).toContain(cap);
      expect(labels).toContain("/416");
      expect(labels).toContain(index === 2 ? "B[70.71%]" : "D");
      expect(labels).not.toContain("/111");
    }
    for (const [index, first, second] of [[1, "祭礼残章", "嘟嘟可故事集"], [3, "嘟嘟可故事集", "祭礼残章"],
      [5, "祭礼残章", "嘟嘟可故事集"]] as const) {
      expect(positions(draw[index]!.labels, first)).toBeGreaterThan(-1);
      expect(positions(draw[index]!.labels, second)).toBeGreaterThan(positions(draw[index]!.labels, first));
    }
    if (proof) {
      await Bun.write(join(proof, "draws.jsonl"), raw);
      for (const [index, bytes] of images.entries()) await Bun.write(join(proof, `${index}.png`), bytes);
    }
  }, 10_000, preload, prepare);
}, 24_000);
