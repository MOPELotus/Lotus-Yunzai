import { expect, test } from "bun:test";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const [named, empty, refusal, discarded, changed, replacement] =
  ["100000732", "100000733", "100000734", "100000735", "100000736", "100000737"] as const;
const modulePath = join(import.meta.dir, "../plugins/starrail");
const proof = Bun.env.LOTUS_PROFILE_BRIDGE_PROOF;
const preload = `
import { appendFileSync } from "node:fs";
import assert from "node:assert/strict";
import { Canvas } from ${JSON.stringify(join(modulePath, "node_modules/skia-canvas/lib/index.js"))};
Bun.env.LOTUS_PROFILE_DIR = "./profiles";
Bun.env.LOTUS_STAR_RAIL_SHOWCASE_SERVER = "0";
Bun.env.LOTUS_SKIA_MODE = "gpu";
const local = globalThis.fetch;
globalThis.fetch = Object.assign((input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return local(input, init);
  if (url.hostname === "q1.qlogo.cn") return Promise.resolve(new Response(null, { status: 404 }));
  const headers = new Headers(init?.headers);
  assert.equal(url.origin, "https://api.mihomo.me");
  assert.equal(headers.has("Cookie"), false);
  assert.equal(headers.has("Authorization"), false);
  assert.equal(url.search, "");
  appendFileSync("./public-requests", url.pathname + "\\n");
  const uid = url.pathname.split("/").at(-1);
  const permitted = { ${JSON.stringify(named)}: 1102, ${JSON.stringify(empty)}: 1001 };
  if (!(uid in permitted)) throw new Error("unexpected public UID");
  return Promise.resolve(Response.json({detailInfo:{uid, avatarDetailList:[{
    avatarId: permitted[uid], level:80, promotion:6, rank:0,
    skillTreeList:[{ pointId:permitted[uid]*1000+1, level:5 }],
  }]}}));
}, { preconnect: local.preconnect });
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
function profile(qq: number, id: number, uid: string) {
  return Bun.YAML.stringify({ user: { qq: String(qq) }, profile: { id }, account: {
    game_roles: { sr: [{ uid, region: "prod_gf_cn", game_biz: "hkrpg_cn" }] }, current_uid: { sr: uid },
  } });
}
async function write(root: string, entry: string, data: string) {
  const file = join(root, entry);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, data);
}
const at = "2026-11-01T10:00:00Z";
const ownedPanel = JSON.stringify({ version: 1, uid: named, source: "miyoushe", updatedAt: at, avatars: [{
  id: "1001", name: "三月七", element: "冰", path: "存护", face: "", splash: "", stars: [], traces: [],
  level: 80, rank: 0, skills: [], stats: [], relics: [],
}] });
const emptyPanel = JSON.stringify({ version: 1, uid: empty, source: "miyoushe", updatedAt: at, avatars: [] });
const deletedPanel = JSON.stringify({ version: 1, uid: discarded, source: "miyoushe", updatedAt: at,
  avatars: [], panelDiscardedAt: Date.parse(at) });
async function prepare(root: string) {
  const target = join(root, "plugins/starrail");
  await cp(modulePath, target, { recursive: true, filter: item => ![".git", "node_modules", "test"].includes(basename(item)) });
  await symlink(join(modulePath, "node_modules"), join(target, "node_modules"), "dir");
  await symlink(join(import.meta.dir, "../packages"), join(root, "packages"), "dir");
  for (const [qq, id, uid] of [[42, 2, named], [43, 3, empty], [42, 4, refusal], [42, 5, discarded], [42, 6, changed]] as const) {
    await write(root, `profiles/${qq}-${id}.yaml`, profile(qq, id, uid));
  }
  await write(root, `data/starrail/panels/42/${named}.json`, ownedPanel);
  await write(root, `data/starrail/panels/43/${empty}.json`, emptyPanel);
  await write(root, `data/starrail/panels/42/${discarded}.json`, deletedPanel);
}

function png(frame: unknown) {
  const content = /base64:\/\/([A-Za-z\d+/=]+)/u.exec(JSON.stringify(frame))?.[1];
  expect(content).toBeDefined();
  const data = Buffer.from(content!, "base64");
  expect(data.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return data;
}

test("星铁面板按已选档回退公开展板，经双协议确认后只传 UID", async () => {
  await withDualGatewayFixture("starrail-profile-fallback", "disablePrivate: false\n", async ({ root, onebot, milky, sendOneBot, sendMilky }) => {
    const checkFile = () => readFile(join(root, "public-requests"), "utf8").catch(() => "");
    let sequence = 21;
    const one = async (text?: string, accepted = true) => {
      const call = await onebot.next("send_msg");
      if (text) expect(JSON.stringify(call.params)).toContain(text);
      call.respond(accepted ? { message_id: sequence++ } : {}, accepted ? "ok" : "failed");
      return call.params;
    };
    sendOneBot("*面板2");
    png(await one());
    expect(await checkFile()).toBe("");
    sendOneBot("*希儿面板2");
    await one("本地暂无「希儿」的星铁面板");
    const namedCard = png(await one());
    sendOneBot("#星铁希儿详情2");
    png(await one());
    expect(await checkFile()).toBe(`/sr_info/${named}\n`);

    expect((await sendMilky("#星铁面板3")).status).toBe(200);
    const notice = await milky.next("send_private_message");
    expect(JSON.stringify(notice.params)).toContain("此绑定 UID 的公开展板");
    notice.respond({ message_seq: sequence++ });
    const list = await milky.next("send_private_message");
    list.respond({ message_seq: sequence++ });
    const roster = png(list.params);
    expect(await checkFile()).toBe(`/sr_info/${named}\n/sr_info/${empty}\n`);

    sendOneBot("*面板4");
    await one("此绑定 UID 的公开展板", false);
    await one("已取消公开展板回退");
    sendOneBot("*不存在面板4");
    await one("暂无星铁角色面板");
    sendOneBot(`*${refusal}希儿面板 4`);
    await one("暂无星铁角色面板");
    sendOneBot("*面板5");
    await one("暂无星铁角色面板");
    sendOneBot("*面板6");
    const awaiting = await onebot.next("send_msg");
    expect(JSON.stringify(awaiting.params)).toContain("公开展板");
    await write(root, "profiles/42-6.yaml", profile(42, 6, replacement));
    awaiting.respond({ message_id: sequence++ });
    await one("档案已变更");
    const publicRequests = await checkFile();
    expect(publicRequests).toBe(`/sr_info/${named}\n/sr_info/${empty}\n`);
    for (const [qq, uid, body] of [[42, named, ownedPanel], [43, empty, emptyPanel], [42, discarded, deletedPanel]] as const) {
      expect(await readFile(join(root, `data/starrail/panels/${qq}/${uid}.json`), "utf8")).toBe(body);
    }
    if (proof) {
      await Bun.write(join(proof, "starrail-public-named.png"), namedCard);
      await Bun.write(join(proof, "starrail-public-roster.png"), roster);
      await Bun.write(join(proof, "starrail-public-requests.log"), publicRequests);
      await cp(join(root, "engines.jsonl"), join(proof, "starrail-engines.jsonl"));
    }
  }, 20_000, preload, prepare);
}, 100_000);
