import { linkHostPackages } from "./host-fixture.ts";
import { expect, test } from "bun:test";
import { cp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const actor = 42;
const uid = "100000042", alternate = "100000043";
const bad = "{", valid = JSON.stringify({ uid, info: { export_app: "cocogoat" }, list: [{ id: 100, status: 3 }] });
const another = JSON.stringify({ uid: alternate, info: { export_app: "cocogoat" }, list: [{ id: 100, status: 3 }] });
const fileRoot = "https://grouptalk.c2c.qq.com/achievement-fixture/";
const gpuProof = Bun.env.LOTUS_ACHIEVEMENT_GPU_PROOF;
const engineEntry = join(import.meta.dir, "../packages/skia/node_modules/skia-canvas/lib/index.js");
const caption = {
  type: "text", data: { text: "记录见附件" },
} as const;
const preload = `
import { readFileSync } from "node:fs";
Bun.env.LOTUS_ATLAS_DATA_DIR = "./catalog";
Bun.env.LOTUS_PROFILE_DIR = "./profiles";
const now = performance.now.bind(performance);
Object.defineProperty(performance, "now", { value() {
  try { return now() + Number(readFileSync("./elapsed", "utf8")); } catch { return now(); }
} });
${gpuProof ? `
import { Canvas } from ${JSON.stringify(engineEntry)};
Bun.env.VK_DRIVER_FILES = "/usr/share/vulkan/icd.d/nvidia_icd.json";
Bun.env.LOTUS_SKIA_MODE = "gpu";
Bun.env.LOTUS_GENSHIN_PANEL_THEME_DIR = "./theme";
const toBuffer = Canvas.prototype.toBuffer;
Canvas.prototype.toBuffer = async function (...args) {
  const engine = this.engine;
  if (engine.renderer !== "GPU" || engine.api !== "Vulkan" || !engine.device?.includes("RTX A4000")) throw Error("图未使用物理显卡");
  await Bun.write("./engine.json", JSON.stringify(engine));
  return toBuffer.call(this, ...args);
};
` : ""}
const base = globalThis.fetch;
const files = new Map(Object.entries(${JSON.stringify({ bad, valid, another })}));
globalThis.fetch = Object.assign((input, options) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (["127.0.0.1", "localhost"].includes(url.hostname)) return base(input, options);
  if (url.href.startsWith(${JSON.stringify(fileRoot)})) {
    const data = files.get(url.pathname.split("/").at(-1));
    if (data) return Promise.resolve(new Response(data, { headers: { "Content-Length": String(Buffer.byteLength(data)) } }));
  }
  throw new Error("隔离附件验收不访问外网");
}, { preconnect: base.preconnect });
`;

async function prepare(root: string) {
  for (const name of ["atlas", "genshin"]) {
    const source = await realpath(join(import.meta.dir, "../plugins", name)), target = join(root, "plugins", name);
    await cp(source, target, { recursive: true, filter: file => ![".git", "node_modules"].includes(basename(file)) });
    await symlink(join(source, "node_modules"), join(target, "node_modules"), "dir");
  }
  await linkHostPackages(root);
  if (gpuProof) await cp(join(gpuProof, "theme"), join(root, "theme"), { recursive: true });
  await mkdir(join(root, "config/config"), { recursive: true });
  await writeFile(join(root, "config/config/group.yaml"), "default: {groupCD: 0, singleCD: 0, onlyReplyAt: 0}\n");
  await mkdir(join(root, "profiles"));
  for (const [qq, slot, selected, owned] of [[42, 1, uid, true], [42, 2, alternate, true], [44, 1, uid, false]] as const) {
    const account = String(900000000 + qq + slot);
    await writeFile(join(root, "profiles", `${qq}${slot === 1 ? "" : "-" + slot}.yaml`), Bun.YAML.stringify({
      user: { qq: String(qq) }, profile: { id: slot }, account: {
        stuid: account, ltuid: account, stoken: "fixture", ltoken: "fixture",
        cookie: `account_id=${account};cookie_token=fixture;ltuid=${account};ltoken=fixture`,
        game_roles: owned ? { gs: [{ uid: selected, region: "cn_gf01", game_biz: "hk4e_cn" }] } : {},
        current_uid: { gs: selected },
      },
    }));
  }
  await mkdir(join(root, "catalog/items"), { recursive: true });
  const pageId = "achievement/achievement";
  await writeFile(join(root, "catalog/map.json"), JSON.stringify({ games: { gi: { locales: { zh: { pages: {
    [pageId]: { version: "1", recordCount: 1, records: { "6": { id: "6", path: "items/achievement.json", name: "尘世巡游" } } },
  } } } } } }));
  await writeFile(join(root, "catalog/items/achievement.json"), JSON.stringify({
    meta: { gameId: "gi", pageId, recordId: "6", version: "1" },
    content: { list: { id: 6, name: "尘世巡游", list: [{ id: 100, name: "固定验收", desc: "完成条件", reward: { item_count: 5 } }] } },
  }));
}

function imageData(params: unknown) {
  const data = /base64:\/\/([A-Za-z0-9+/]+=*)/u.exec(JSON.stringify(params))?.[1];
  if (!data) throw new Error(`未收到成就图卡：${JSON.stringify(params)}`);
  return Uint8Array.fromBase64(data);
}

test("真实双协议宿主接受成就待导入的带说明群附件，坏文件和错会话不会写入", async () => {
  await withDualGatewayFixture("achievement-file-fixture", "disablePrivate: false\n", async ({
    root, onebot, milky, sendOneBot, sendMilky, sendMilkyEvent,
  }) => {
    const group = { message_type: "group", sub_type: "normal", group_id: 77 };
    const mkGroup = { message_scene: "group", peer_id: 77, sender_id: actor };
    const archive = (selected: string) => Bun.file(join(root, "data/achievements/42", selected + ".json"));
    let fileSequence = 0;
    async function obText(command: string, expected: string, extra = {}) {
      sendOneBot(command, { ...group, ...extra });
      const call = await onebot.next("send_msg");
      expect(call.params.group_id).toBe(77);
      expect(JSON.stringify(call.params)).toContain(expected);
      call.respond({ message_id: 800 });
    }
    async function mkText(command: string, expected: string) {
      expect((await sendMilky(command, mkGroup)).status).toBe(200);
      const call = await milky.next("send_group_message");
      expect(call.params.group_id).toBe(77);
      expect(JSON.stringify(call.params)).toContain(expected);
      call.respond({ message_seq: 801 });
    }
    function obFile(contents: string, fields: object = {}, labelled = false) {
      const file = { file: "成就.json", file_id: `/achievements-${++fileSequence}`, file_size: String(Buffer.byteLength(contents)) };
      sendOneBot("", { ...group, message: [
        ...(labelled ? [caption] : []), { type: "file", data: file },
      ], ...fields });
      return file.file_id;
    }
    async function obRead(fileId: string, name: string) {
      const link = await onebot.next("get_group_file_url");
      expect(link.params).toMatchObject({ group_id: 77, file_id: fileId });
      link.respond({ url: fileRoot + name });
    }

    await obText("#成就导入", "5 分钟");
    obFile(valid, { group_id: 78 }, true);
    obFile(valid, { user_id: 43 }, true);
    obFile(valid, { message_type: "private", sub_type: "friend" }, true);
    expect((await sendMilky("", { ...mkGroup, segments: [caption, { type: "file", data: {
      file_name: "成就.json", file_id: "cross-protocol", file_hash: "sha-for-fixture", file_size: Buffer.byteLength(valid),
    } }] })).status).toBe(200);
    await Bun.sleep(100);
    expect(onebot.calls).toHaveLength(0);
    expect(milky.calls).toHaveLength(0);
    expect(await archive(uid).exists()).toBe(false);

    await obRead(obFile(bad, { message_id: 902 }, true), "bad");
    const malformed = await onebot.next("send_msg");
    expect(JSON.stringify(malformed.params)).toContain("不是有效的 UTF-8 JSON");
    malformed.respond({ message_id: 802 });
    obFile(bad, { message_id: 902 }, true);
    await Bun.sleep(100);
    expect(onebot.calls).toHaveLength(0);
    expect(await archive(uid).exists()).toBe(false);

    await writeFile(join(root, "elapsed"), "300001");
    obFile(valid, {}, true);
    const expired = await onebot.next("send_msg");
    expect(JSON.stringify(expired.params)).toContain("等待已超时");
    expired.respond({ message_id: 803 });
    expect(await archive(uid).exists()).toBe(false);

    await obText("#成就录入", "5 分钟");
    obFile(valid, { message: [
      { type: "text", data: { text: "#成就目录" } },
      { type: "file", data: { file: "成就.json", file_id: "/ordinary-command", file_size: String(Buffer.byteLength(valid)) } },
    ] });
    const directory = await onebot.next("send_msg");
    expect(directory.params.group_id).toBe(77);
    directory.respond({ message_id: 806 });
    expect(await archive(uid).exists()).toBe(false);
    await obRead(obFile(valid, {}, true), "valid");
    const first = await onebot.next("send_msg");
    expect(first.params.group_id).toBe(77);
    const firstImage = gpuProof ? imageData(first.params) : undefined;
    if (!gpuProof) expect(JSON.stringify(first.params)).toContain("新增 1 条");
    expect(await archive(uid).json()).toMatchObject({ uid, done: { "100": { id: 100 } } });
    first.respond({ message_id: 804 });
    await obText("#成就导入", "尚未同步", { user_id: 44 });
    expect(await Bun.file(join(root, "data/achievements/44", uid + ".json")).exists()).toBe(false);

    await mkText("#成就录入2", "5 分钟");
    expect((await sendMilkyEvent("group_file_upload", { group_id: 78, user_id: actor, file_id: "wrong-group",
      file_name: "成就.json", file_size: Buffer.byteLength(another) })).status).toBe(200);
    expect((await sendMilky("", { ...mkGroup, segments: [caption, { type: "file", data: {
      file_name: "成就.json", file_id: "correct-group", file_hash: "sha-for-fixture", file_size: Buffer.byteLength(another),
    } }] })).status).toBe(200);
    const secondLink = await milky.next("get_group_file_download_url");
    expect(secondLink.params).toEqual({ group_id: 77, file_id: "correct-group" });
    secondLink.respond({ download_url: fileRoot + "another" });
    const second = await milky.next("send_group_message");
    expect(second.params.group_id).toBe(77);
    const secondImage = gpuProof ? imageData(second.params) : undefined;
    if (!gpuProof) expect(JSON.stringify(second.params)).toContain("新增 1 条");
    second.respond({ message_seq: 805 });
    expect(await archive(alternate).json()).toMatchObject({ uid: alternate, done: { "100": { id: 100 } } });
    expect(await archive(uid).json()).toMatchObject({ uid });
    if (gpuProof && firstImage && secondImage) {
      expect(secondImage).not.toEqual(firstImage);
      await Bun.write(join(gpuProof, "engine.json"), await Bun.file(join(root, "engine.json")).text());
      await Bun.write(join(gpuProof, "onebot.png"), firstImage);
      await Bun.write(join(gpuProof, "milky.png"), secondImage);
    }
  }, 6_000, preload, prepare);
}, 25_000);

test("真实双协议分发旧成就分类别名和紧邻导入，公开成就查询保持独立", async () => {
  await withDualGatewayFixture("achievement-command-fixture", "disablePrivate: false\n", async ({
    root, onebot, milky, sendOneBot, sendMilky,
  }) => {
    const group = { message_type: "group", sub_type: "normal", group_id: 77 };
    const mkGroup = { message_scene: "group", peer_id: 77, sender_id: actor };
    async function receive(protocol: "onebot" | "milky", command: string) {
      if (protocol === "onebot") sendOneBot(command, group);
      else expect((await sendMilky(command, mkGroup)).status).toBe(200);
      const call = await (protocol === "onebot" ? onebot.next("send_msg") : milky.next("send_group_message"));
      if (protocol === "onebot") call.respond({ message_id: 906 });
      else call.respond({ message_seq: 907 });
      return call.params;
    }
    async function capture(protocol: "onebot" | "milky", name: string, command: string, text: string) {
      const reply = await receive(protocol, command);
      expect(reply.group_id).toBe(77);
      if (gpuProof) await Bun.write(join(gpuProof, name + ".png"), imageData(reply));
      else expect(JSON.stringify(reply)).toContain(text);
    }
    await capture("onebot", "bare-abbreviation", "#尘世", "尘世巡游");
    await capture("milky", "explicit-reserved", "#成就深境挑战者第一辑成就2", "深境挑战者");
    expect(JSON.stringify(await receive("onebot", "#成就分类 原神"))).toContain("成就分类");
    expect(JSON.stringify(await receive("milky", "#成就未知条目"))).toContain("未找到原神成就分类");
    const legacy = JSON.stringify({ source: "椰羊成就", value: { account: { uid }, achievements: [{ id: 100, status: "3" }] } });
    const fence = String.fromCharCode(96).repeat(3);
    await capture("onebot", "inline-legacy", `#成就录入${uid} ${fence}json\n${legacy}\n${fence}`, "新增 1 条");
    expect(await Bun.file(join(root, "data/achievements/42", uid + ".json")).json())
      .toMatchObject({ uid, done: { "100": { id: 100, source: "cocogoat" } } });
  }, 6_000, preload, async root => {
    await prepare(root);
    const index = Bun.file(join(root, "catalog/map.json"));
    const map = await index.json();
    const pageId = "achievement/achievement";
    const page = map.games.gi.locales.zh.pages[pageId];
    const name = "深境挑战者·第一辑";
    page.recordCount++;
    page.records["7"] = { id: "7", path: "items/abyss.json", name };
    await Bun.write(index, JSON.stringify(map));
    await Bun.write(join(root, "catalog/items/abyss.json"), JSON.stringify({
      meta: { gameId: "gi", pageId, recordId: "7", version: "1" },
      content: { list: { id: 7, name, list: [{ id: 101, name: "深境验收", desc: "完成挑战", reward: { item_count: 10 } }] } },
    }));
  });
}, 25_000);
