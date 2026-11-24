import { expect, test } from "bun:test";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const uid = "100000042";
const otherUid = "100000044";
const accounts = [[42, 2, 4202, uid], [42, 3, 4203, uid], [42, 4, 4204, otherUid], [43, 2, 4302, uid]] as const;
const skiaEntry = join(import.meta.dir, "../packages/skia/node_modules/skia-canvas/lib/index.js");
const proof = Bun.env.LOTUS_GACHA_ROLE_LOCK_GPU_PROOF;
const preload = `
import { appendFileSync } from "node:fs";
import { Canvas } from ${JSON.stringify(skiaEntry)};
Bun.env.LOTUS_PROFILE_DIR = "./profiles";
${proof ? `
Bun.env.VK_DRIVER_FILES = "/usr/share/vulkan/icd.d/nvidia_icd.json";
const toBuffer = Canvas.prototype.toBuffer;
Canvas.prototype.toBuffer = async function (...args) {
  const output = await toBuffer.call(this, ...args);
  if (this.engine.renderer !== "GPU" || this.engine.api !== "Vulkan" || !this.engine.device?.includes("RTX A4000")) {
    throw Error("原神抽卡出图需要在物理显卡验证");
  }
  await Bun.write("./engine.json", JSON.stringify({ ...this.engine, device: String(this.engine.device) }));
  return output;
};
` : ""}
const native = globalThis.fetch;
const trace = entry => appendFileSync("./requests.log", entry + "\\n");
async function waitForRelease(file) {
  for (let i = 0; i < 500; i++) {
    if (await Bun.file(file).exists()) return;
    await Bun.sleep(10);
  }
  throw Error("测试未释放上游请求");
}
globalThis.fetch = Object.assign(async (input, options) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname === "127.0.0.1") return native(input, options);
  if (url.hostname === "api-takumi.mihoyo.com" && url.pathname === "/binding/api/genAuthKey") {
    const account = /(?:^|;)\\s*stuid=(\\d+)/u.exec(new Headers(options.headers).get("Cookie"))?.[1];
    trace("auth " + account);
    if (account === "4202" && !await Bun.file("./official-release").exists()) {
      await waitForRelease("./official-release");
      return Response.json({ retcode: -499 });
    }
    return Response.json({ retcode: 0, data: { authkey: "fixture-" + account } });
  }
  if (url.hostname === "www.lelaer.com" && url.pathname === "/outputGacha.php") {
    const body = new URLSearchParams(options.body);
    const ticket = new URL(body.get("gachaurl")).searchParams.get("authkey");
    trace("external " + ticket);
    if (ticket === "fixture-4203") await waitForRelease("./external-release");
    return Response.json({ list: [] });
  }
  if (url.hostname === "public-operation-hk4e.mihoyo.com" && url.pathname === "/gacha_info/api/getGachaLog") {
    trace("pool " + url.searchParams.get("authkey"));
    return Response.json({ retcode: 0, data: { list: [] } });
  }
  trace("unexpected " + url.hostname);
  throw Error("测试未发送外部请求");
}, {preconnect: native.preconnect});
`;

async function prepare(root: string) {
  const source = join(import.meta.dir, "../plugins/genshin");
  const target = join(root, "plugins/genshin");
  await cp(source, target, { recursive: true, filter: file => ![".git", "node_modules"].includes(basename(file)) });
  await symlink(join(source, "node_modules"), join(target, "node_modules"), "dir");
  await symlink(join(import.meta.dir, "../packages"), join(root, "packages"), "dir");
  await mkdir(join(root, "profiles"));
  for (const [qq, id, account, uid] of accounts) {
    await writeFile(join(root, "profiles", `${qq}-${id}.yaml`), Bun.YAML.stringify({
      user: { qq: String(qq) }, profile: { id }, account: {
        stuid: String(account), stoken: `v2_fixture_${account}`, mid: `fixture-mid-${account}`,
        stoken_cookie: `stuid=${account};stoken=v2_fixture_${account};mid=fixture-mid-${account}`,
        cookie: `account_id_v2=${account};account_mid_v2=fixture-mid-${account};cookie_token_v2=v2_stored_cookie_${account}`,
        game_roles: { gs: [{ uid, region: "cn_gf01", game_biz: "hk4e_cn" }] }, current_uid: { gs: uid },
      }, device: { id: "fixture-device-" + account },
    }));
  }
}

async function waitForRequest(root: string, request: string) {
  const file = join(root, "requests.log");
  for (let i = 0; i < 300; i++) {
    if ((await readFile(file, "utf8").catch(() => "")).includes(request)) return;
    await Bun.sleep(10);
  }
  throw Error("测试未收到上游请求 " + request + "，已记录：" + (await readFile(file, "utf8").catch(() => "空")));
}

test("原神同 QQ 和 UID 的两档案按来源避免重复换票，失败后允许重试", async () => {
  await withDualGatewayFixture("genshin-role-lock", "disablePrivate: false\n", async ({
    root, onebot, milky, sendOneBot, sendMilky,
  }) => {
    let seq = 100;
    const one = async (text?: string) => {
      const call = await onebot.next("send_msg");
      if (text) expect(JSON.stringify(call.params).includes(text), text).toBe(true);
      call.respond({ message_id: seq++ });
      return call.params;
    };
    const mil = async (text?: string) => {
      const call = await milky.next("send_private_message");
      if (text) expect(JSON.stringify(call.params).includes(text), text).toBe(true);
      call.respond({ message_seq: seq++ });
    };

    sendOneBot("#更新抽卡记录2");
    await one("正在更新 Profile 2");
    await waitForRequest(root, "auth 4202");
    expect((await sendMilky("#原神更新抽卡记录3", { sender_id: 42, peer_id: 42 })).status).toBe(200);
    await mil("正在更新 Profile 3");
    await mil("该账号的原神抽卡记录正在更新");

    expect((await sendMilky("#同步外部抽卡记录3", { sender_id: 42, peer_id: 42 })).status).toBe(200);
    await mil("正在同步档案 3");
    await waitForRequest(root, "external fixture-4203");
    sendOneBot("#同步外部抽卡记录2");
    await one("正在同步档案 2");
    await one("该账号的外部抽卡记录正在同步");

    expect((await sendMilky("#同步外部抽卡记录2")).status).toBe(200);
    await mil("正在同步档案 2");
    await mil("外部抽卡记录为空");
    sendOneBot("#同步外部抽卡记录4");
    await one("正在同步档案 4");
    await one("外部抽卡记录为空");

    await Bun.write(join(root, "external-release"), "");
    await mil("外部抽卡记录为空");
    await Bun.write(join(root, "official-release"), "");
    await one();

    sendOneBot("#更新抽卡记录3");
    await one("正在更新 Profile 3");
    const sent = await one();
    const calls = (await Bun.file(join(root, "requests.log")).text()).trim().split("\n");
    expect(calls.filter(line => !line.startsWith("pool"))).toEqual([
      "auth 4202", "auth 4203", "external fixture-4203", "auth 4302",
      "external fixture-4302", "auth 4204", "external fixture-4204", "auth 4203",
    ]);
    expect(calls.filter(line => line.startsWith("pool"))).toEqual(Array(4).fill("pool fixture-4203"));
    if (proof) {
      const engine = await Bun.file(join(root, "engine.json")).json();
      expect(engine).toMatchObject({ renderer: "GPU", api: "Vulkan" });
      expect(engine.device).toContain("RTX A4000");
      await Bun.write(proof, JSON.stringify(engine));
      const image = /base64:\/\/([A-Za-z0-9+/]+={0,2})/u.exec(JSON.stringify(sent))?.[1];
      expect(image).toBeDefined();
      await Bun.write(proof + ".png", Uint8Array.fromBase64(image!));
    }
  }, 8_000, preload, prepare);
}, 26_000);
