import { linkHostBuiltinResources, linkHostPackages } from "./host-fixture.ts";
import { expect, test } from "bun:test";
import { cp, mkdir, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const onePixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const portrait = "https://webstatic.mihoyo.com/hard-fixture.png";
const hardPath = "/game_record/app/genshin/api/hard_challenge";
const samples = [[42, 3, "100000042", "cn_gf01"], [43, 1, "500000043", "cn_qd01"]] as const;
const keqing = { avatar_id: 10000042, name: "刻晴", rarity: 5, level: 90, rank: 6, icon: portrait };
const round = { name: "兆载永劫龙兽", second: 42, teams: [keqing],
  monster: { icon: portrait, level: 110, desc: ["元素爆发伤害提高"] },
  best_avatar: [{ avatar_id: keqing.avatar_id, dps: 250000 }, { avatar_id: keqing.avatar_id, dps: 1500000 }] };
const single = { has_data: true, best: { difficulty: 6, second: 42 }, challenge: [round] };
const multiplayer = { ...single, best: { difficulty: 6, second: 35 } };
const seasons = [
  { schedule: { start_time: "1761926400", end_time: "1763136000", version: "6.1" }, single, mp: multiplayer },
  { schedule: { start_time: 1760716800, end_time: 1761926400, version: "6.1" }, single, mp: { has_data: false } },
];
const proofDirectory = Bun.env.LOTUS_HARD_CHALLENGE_PROOF;
const skiaEntry = join(import.meta.dir, "../packages/skia/node_modules/skia-canvas/lib/index.js");
const preload = `
import { Canvas } from ${JSON.stringify(skiaEntry)};
const nativeFetch = globalThis.fetch;
Bun.env.LOTUS_PROFILE_DIR = "./profiles";
${proofDirectory ? `
Bun.env.VK_DRIVER_FILES = "/usr/share/vulkan/icd.d/nvidia_icd.json";
const write = Canvas.prototype.toBuffer;
Canvas.prototype.toBuffer = async function (...args) {
  const output = await write.call(this, ...args);
  if (this.engine.renderer !== "GPU" || this.engine.api !== "Vulkan" || !this.engine.device?.includes("RTX A4000")) throw Error("缺少物理显卡验证");
  await Bun.write("./engine.json", JSON.stringify(this.engine));
  return output;
};
` : ""}
const seen = [];
globalThis.fetch = async (address, options) => {
  const url = new URL(address instanceof Request ? address.url : address);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return nativeFetch(address, options);
  const headers = new Headers(options.headers);
  if (url.href === ${JSON.stringify(portrait)}) {
    if (headers.has("Cookie")) throw Error("公开图像请求携带 Cookie");
    return new Response(Uint8Array.fromBase64(${JSON.stringify(onePixel)}), { headers: { "Content-Type": "image/png" } });
  }
  const [qq, profile, uid, server] = ${JSON.stringify(samples)}.find(([, , uid]) => url.searchParams.get("role_id") === uid) || [];
  const path = ${JSON.stringify(hardPath)};
  if (url.origin !== "https://api-takumi-record.mihoyo.com" || options.method !== "GET" || options.redirect !== "error" ||
      !qq || url.searchParams.get("server") !== server || !headers.get("Cookie")?.includes("cookie_token=hard-" + qq) ||
      headers.get("x-rpc-device_id") !== "device-" + profile) throw Error("错误的档案或请求目标");
  seen.push([uid, url.pathname]);
  await Bun.write("./requests.json", JSON.stringify(seen));
  if (url.pathname === path && url.searchParams.get("need_detail") === "true") {
    return Response.json({ retcode: 0, data: { uid, server, data: ${JSON.stringify(seasons)} } });
  }
  if (url.pathname === path + "/popularity" && !url.searchParams.has("need_detail")) {
    return Response.json({ retcode: 0, data: { avatar_list: [{ avatar_id: 10000042 }] } });
  }
  throw Error("未登记的隔离请求：" + url.pathname);
};
`;

async function prepare(root: string) {
  const source = join(import.meta.dir, "../plugins/genshin");
  const plugin = join(root, "plugins/genshin");
  await cp(source, plugin, { recursive: true, filter: file => ![".git", "node_modules"].includes(basename(file)) });
  await symlink(join(source, "node_modules"), join(plugin, "node_modules"), "dir");
  await linkHostPackages(root);
  await linkHostBuiltinResources(root);
  await mkdir(join(root, "profiles"));
  for (const [qq, id, uid, region] of samples) {
    await writeFile(join(root, "profiles", `${qq}${id === 1 ? "" : "-" + id}.yaml`), Bun.YAML.stringify({
      user: { qq: String(qq) }, profile: { id },
      account: { cookie: `account_id=${qq};cookie_token=hard-${qq};ltuid=${qq};ltoken=fixture`, stuid: String(qq),
        stoken: "fixture", ltuid: String(qq), ltoken: "fixture", game_roles: { gs: [{ uid, region, game_biz: "hk4e_cn" }] },
        current_uid: { gs: uid } }, device: { id: `device-${id}`, fp: `fp-${id}` },
    }));
  }
  const theme = "data/genshin/miao-theme";
  for (const file of ["stat/imgs/bg1.png", "stat/imgs/footer.png", "common/cont/card-bg.png", "common/font/NZBZ.woff",
    "common/font/HYWH-65W.woff", "common/font/tttgbnumber.woff", "meta-gs/character/刻晴/imgs/gacha.webp"]) {
    const target = join(root, theme, file);
    await mkdir(dirname(target), { recursive: true });
    const installed = Bun.file(join(import.meta.dir, "..", theme, file));
    if (proofDirectory && await installed.exists()) await Bun.write(target, installed);
    else if (file.endsWith(".png")) await Bun.write(target, Uint8Array.fromBase64(onePixel));
  }
}

function imageBytes(params: unknown) {
  const text = /base64:\/\/([A-Za-z0-9+/]+={0,2})/u.exec(JSON.stringify(params))?.[1];
  expect(text).toBeDefined();
  return Uint8Array.fromBase64(text!);
}

test("幽境战绩通过 OneBot 和 Milky 的正常模块入口按各自当前国服档案返回", async () => {
  await withDualGatewayFixture("genshin-hard-challenge", "disablePrivate: false\n", async ({ root, onebot, milky, sendOneBot, sendMilky }) => {
    sendOneBot("#本期幽境危战最佳 档案3", { message_type: "group", sub_type: "normal", group_id: 601 });
    const group = await onebot.next("send_msg");
    expect(group.params).toMatchObject({ group_id: 601, message: [{ type: "image" }] });
    const image = imageBytes(group.params);
    expect(await new Bun.Image(image).metadata()).toMatchObject({ width: 3880, format: "png" });
    group.respond({ message_id: 166 });
    expect((await sendMilky("#上期幽境合作数据")).status).toBe(200);
    const privateReply = await milky.next("send_private_message");
    expect(JSON.stringify(privateReply.params)).toContain("暂无上期幽境危战组队挑战数据");
    privateReply.respond({ message_seq: 167 });
    expect(await Bun.file(join(root, "requests.json")).json()).toEqual([
      [samples[0][2], hardPath], [samples[0][2], hardPath + "/popularity"], [samples[1][2], hardPath],
    ]);
    if (proofDirectory) {
      await Bun.write(join(proofDirectory, "onebot-host.png"), image);
      await Bun.write(join(proofDirectory, "onebot-engine.json"), Bun.file(join(root, "engine.json")));
    }
  }, 8_000, preload, prepare);
}, 20_000);
