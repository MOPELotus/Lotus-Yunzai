import { expect, test } from "bun:test";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const uid = "100000041", secondary = "500000042", anotherProfile = "100000043", publicUid = "100000044";
const makeRole = (uid: string) => ({ uid, region: uid.startsWith("5") ? "cn_qd01" : "cn_gf01", game_biz: "hk4e_cn" });
const makeAccount = (qq: number, profileId: number, selected: string, uids: readonly string[], account = "900000001") =>
  Bun.YAML.stringify({ user: { qq: String(qq) }, profile: { id: profileId }, account: {
    ltuid: account, stuid: account, stoken: "synthetic-login",
    cookie: `account_id=${account};cookie_token=synthetic-token;ltuid=${account};ltoken=synthetic-ltoken`,
    game_roles: { gs: uids.map(makeRole) }, current_uid: { gs: selected },
  } });
const fixtures = [
  [uid, 10000089, "芙宁娜", "hydro"],
  [secondary, 10000042, "刻晴", "electro"],
  [anotherProfile, 10000042, "刻晴", "electro"],
  [publicUid, 10000089, "芙宁娜", "hydro"],
] as const;
const staticAssets = Bun.env.LOTUS_GS_TEAM_TEST_THEME;
const proof = Bun.env.LOTUS_GS_TEAM_TEST_PROOF;
const skiaEntry = join(import.meta.dir, "../packages/skia/node_modules/skia-canvas/lib/index.js");
const preload = `
import { appendFileSync } from "node:fs";
import assert from "node:assert/strict";
import { Canvas } from ${JSON.stringify(skiaEntry)};
Bun.env.LOTUS_PROFILE_DIR = "./profiles";
Bun.env.LOTUS_GENSHIN_PANEL_THEME_DIR = "./theme";
Bun.env.LOTUS_GENSHIN_LEGACY_PANEL_DIR = "./legacy";
Bun.env.LOTUS_GENSHIN_PANEL_DIR = "./active";
${proof ? `
Bun.env.VK_DRIVER_FILES = "/usr/share/vulkan/icd.d/nvidia_icd.json";
const toBuffer = Canvas.prototype.toBuffer;
Canvas.prototype.toBuffer = async function (...args) {
  const output = await toBuffer.call(this, ...args);
  const { device, renderer, api, driver } = this.engine;
  assert.equal(renderer, "GPU");
  assert.equal(api, "Vulkan");
  assert.match(device, /RTX A4000/u);
  appendFileSync("./engines.jsonl", JSON.stringify({ device, renderer, api, driver }) + "\\n");
  return output;
};
` : ""}
const native = globalThis.fetch;
globalThis.fetch = Object.assign(async (input, options) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname === "127.0.0.1") return native(input, options);
  if (url.href !== "https://api.lelaer.com/ys/getTeamResult.php") throw Error("unexpected external origin");
  const headers = new Headers(options.headers);
  assert.equal(headers.has("Cookie"), false);
  assert.equal(headers.has("Authorization"), false);
  assert.equal(options.credentials, "omit");
  assert.equal(options.redirect, "error");
  const payload = JSON.parse(options.body);
  appendFileSync("./requests.jsonl", JSON.stringify(payload) + "\\n");
  const modeFile = Bun.file("./response-mode");
  const mode = await modeFile.exists() ? await modeFile.text() : "";
  if (mode === "bad-business") return Response.json({ code: 500, info: "fixture-private-upstream" });
  if (mode === "wrong-uid") return Response.json({ code: 200, result: { uid: "999999999" } });
  if (mode === "revoke") {
    await Bun.write("./profiles/42-3.yaml", ${JSON.stringify(makeAccount(42, 3, uid, [uid]))});
  }
  const name = payload.role_data[0].role;
  return Response.json({ code: 200, result: { uid: payload.uid,
    zdl_tips0: "你的队伍24秒内造成总伤害20.8W，DPS为:8667", zdl_result: 8667, zdl_tips2: "良好",
    chart_data: [{ name: name + "\\n20.8W" }], role_list: [{ role: name }], combo_intro: name + " E," + name + " Q",
    advice: Array.from({ length: 28 }, (_, i) => ({ content: (i + 1) + "s 元素爆发，伤害:1080" })),
    buff: [{ content: "1.5s 元素激化-伤害提高" }, { content: "2.5s 增益-暴击提高" }],
  } });
}, { preconnect: native.preconnect });
`;

async function prepare(root: string) {
  const source = join(import.meta.dir, "../plugins/genshin");
  const target = join(root, "plugins/genshin");
  await cp(source, target, { recursive: true, filter: path => ![".git", "node_modules"].includes(basename(path)) });
  await symlink(join(source, "node_modules"), join(target, "node_modules"), "dir");
  await symlink(join(import.meta.dir, "../packages"), join(root, "packages"), "dir");
  await mkdir(join(root, "profiles"));
  await mkdir(join(root, "legacy"));
  await writeFile(join(root, "profiles", "42-3.yaml"), makeAccount(42, 3, uid, [uid, secondary]));
  await writeFile(join(root, "profiles", "42-4.yaml"), makeAccount(42, 4, anotherProfile, [anotherProfile]));
  await writeFile(join(root, "profiles", "43-3.yaml"), makeAccount(43, 3, anotherProfile, [anotherProfile], "900000002"));
  const chars = Object.fromEntries(fixtures.map(([, id, name, elem]) => [id, { name, elem, weapon: "sword",
    attr: { keys: ["hpBase", "atkBase", "defBase", "cpct"], details: { "80+": [9000, 200, 500, 12], "90": [10000, 250, 600, 19.2] } },
  }]));
  async function json(path: string, value: unknown) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(value));
  }
  if (staticAssets) await cp(staticAssets, join(root, "theme"), { recursive: true });
  await json(join(root, "theme/meta-gs/character/data.json"), chars);
  await json(join(root, "theme/meta-gs/artifact/data.json"), { set: { name: "昔日宗室之仪", idxs: { 1: { name: "宗室之花" } } } });
  await json(join(root, "theme/meta-gs/weapon/sword/无锋剑/data.json"),
    { name: "无锋剑", attr: { atk: { "80+": 200, "90": 300 } } });
  for (const [id, row] of Object.entries(chars)) await json(join(root, "theme/meta-gs/character", row.name, "data.json"), chars[id]);
  for (const [uid, id, name, elem] of fixtures) {
    await json(join(root, "legacy", `${uid}.json`), { uid, internal: "should never reach provider",
      avatars: { [id]: { id, name, elem, level: 90, promote: 6, cons: 3, _source: "enka",
        weapon: { name: "无锋剑", promote: 6, level: 90, affix: 1 }, talent: { a: 5, e: 8, q: 10 },
        artis: uid === secondary ? {} : {
          1: { name: "宗室之花", set: "昔日宗室之仪", mainId: 10001, level: 20, star: 5, attrIds: [501201, 501223] },
        } } } });
  }
}

function image(params: unknown) {
  const raw = /base64:\/\/([A-Za-z0-9+/]+={0,2})/u.exec(JSON.stringify(params))?.[1];
  expect(raw !== undefined).toBe(true);
  return Uint8Array.fromBase64(raw!);
}

test("原神队伤宿主按本人选档授权显式角色，并用整图返回容纳得下的明细", async () => {
  await withDualGatewayFixture("genshin-team-damage", "disablePrivate: false\n", async ({
    root, onebot, milky, sendOneBot, sendMilky,
  }) => {
    let sequence = 150;
    const original = await readFile(join(root, "profiles/42-3.yaml"), "utf8");
    const readLog = async () => (await readFile(join(root, "requests.jsonl"), "utf8").catch(() => "")).trim()
      .split("\n").filter(Boolean).map(line => JSON.parse(line));
    const one = async (text?: string, receipt: "confirmed" | "rejected" | "unknown" = "confirmed") => {
      const call = await onebot.next("send_msg");
      if (text) expect(JSON.stringify(call.params).includes(text), text).toBe(true);
      call.respond(receipt === "confirmed" ? { message_id: sequence++ } : {}, receipt === "rejected" ? "failed" : "ok");
      return call.params;
    };
    const mil = async (text?: string) => {
      const call = await milky.next("send_private_message");
      if (text) expect(JSON.stringify(call.params).includes(text), text).toBe(true);
      call.respond({ message_seq: sequence++ });
      return call.params;
    };
    const group = { message_type: "group", sub_type: "normal", group_id: 601 };
    const owner = { sender_id: 42, peer_id: 42 };
    const query = `#队伍伤害3 ${secondary} 刻晴`;
    for (const target of [anotherProfile, publicUid]) {
      sendOneBot(`#队伍伤害3 ${target} 刻晴`, group);
      await one("UID 与当前档案");
    }
    expect((await sendMilky(query, { sender_id: 43, peer_id: 43 })).status).toBe(200);
    await mil("UID 与当前档案");
    for (const receipt of ["rejected", "unknown"] as const) {
      sendOneBot(query, group);
      await one("将发送本人的原神 UID", receipt);
      await one("来源提示未能送出");
    }
    expect(await readLog()).toEqual([]);

    sendOneBot("#队伍伤害3芙芙", group);
    await one("芙宁娜");
    const overview = image(await one());
    expect(await new Bun.Image(overview).metadata()).toMatchObject({ width: 2880, format: "png" });
    expect((await sendMilky(`#原神队伍伤害详情 ${secondary} 刻晴 档案3`, owner)).status).toBe(200);
    await mil("刻晴");
    const detail = image(await mil());
    const detailMetadata = await new Bun.Image(detail).metadata();
    expect(detailMetadata).toMatchObject({ width: 2880, format: "png" });
    expect(detailMetadata.height).toBeGreaterThan(7000);
    expect(milky.calls).toHaveLength(0);
    expect(await readFile(join(root, "profiles/42-3.yaml"), "utf8")).toBe(original);

    for (const [fileMode, expected] of [
      ["bad-business", "暂时无法计算这支队伍"], ["wrong-uid", "返回的 UID 与当前原神档案不一致"],
      ["revoke", "原神档案已变化"],
    ]) {
      await writeFile(join(root, "response-mode"), fileMode!);
      sendOneBot(query, group);
      await one("刻晴");
      await one(expected);
    }
    sendOneBot(query, group);
    await one("UID 与当前档案");
    const calls = await readLog();
    expect(calls.map(({ uid, server, role_data }) => [uid, server, role_data[0].role])).toEqual([
      [uid, "cn_gf01", "芙宁娜"], ...Array(4).fill([secondary, "cn_qd01", "刻晴"]),
    ]);
    expect(calls[1].role_data[0]).toMatchObject({ hp: 10000, base_hp: 10000, artifacts: "", artifacts_detail: [] });
    for (const payload of calls) {
      expect(Object.keys(payload)).toEqual(["uid", "server", "role_data"]);
      expect(JSON.stringify(payload)).not.toMatch(/synthetic|cookie|stoken|internal|900000001/iu);
    }
    if (proof) {
      const engines = await readFile(join(root, "engines.jsonl"), "utf8");
      expect(engines.trim().split("\n")).toHaveLength(2);
      await Bun.write(join(proof, "engines.jsonl"), engines);
      await Bun.write(join(proof, "overview.png"), overview);
      await Bun.write(join(proof, "detail.png"), detail);
    }
  }, 10_000, preload, prepare);
}, 30_000);
