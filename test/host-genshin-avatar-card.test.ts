import { expect, test } from "bun:test";
import { renderPng } from "@lotus-yunzai/skia";
import { cp, mkdir, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { normalizeOriginalPictureCommand } from "../lib/command-prefix.ts";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

async function prepare(root: string) {
  const source = join(import.meta.dir, "../plugins/genshin");
  const destination = join(root, "plugins", "genshin");
  await cp(source, destination, { recursive: true, filter: path => ![".git", "node_modules"].includes(basename(path)) });
  await symlink(join(source, "node_modules"), join(destination, "node_modules"), "dir");
  await symlink(join(import.meta.dir, "../packages"), join(root, "packages"), "dir");
  await mkdir(join(root, "profiles"), { recursive: true });
  for (const qq of [42, 43]) {
    const id = String(900_000_000 + qq);
    const uid = String(100_004_000 + qq);
    await writeFile(join(root, "profiles", `${qq}.yaml`), Bun.YAML.stringify({
      user: { qq: String(qq) }, profile: { id: 1 }, account: {
        stuid: id, ltuid: id, stoken: `token-${qq}`, ltoken: `login-${qq}`, updated_at: "2026-10-01",
        cookie: `account_id=${id}; cookie_token=fixture; ltuid=${id}; ltoken=login-${qq}`,
        game_roles: { gs: [{ uid, region: "cn_gf01", game_biz: "hk4e_cn" }] }, current_uid: { gs: uid },
      },
    }));
    const folder = join(root, "data", "genshin", "panels", String(qq));
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, `${uid}.json`), JSON.stringify({
      uid, avatars: { 10000046: { id: 10000046, name: "胡桃", level: 90, elem: "pyro", _source: "enka" } },
    }));
  }
}

const preload = `
Bun.env.LOTUS_PROFILE_DIR = "./profiles";
const fetchBase = globalThis.fetch;
globalThis.fetch = (value, options) => {
  const address = new URL(value instanceof Request ? value.url : value);
  if (address.hostname !== "127.0.0.1" && address.hostname !== "localhost") throw new Error("隔离验收禁止外部请求");
  return fetchBase(value, options);
};
`;

function assertImage(params: unknown) {
  const match = /base64:\/\/([A-Za-z0-9+/=]+)/u.exec(JSON.stringify(params));
  expect(match).not.toBeNull();
  const bytes = Buffer.from(match![1]!, "base64");
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return bytes;
}

test("旧原图口语只归一整条指令，保留游戏前缀", () => {
  for (const prefix of ["", "#", "#原神", "#星铁", "*", "#绝区零", "%", "％"]) {
    for (const verb of ["", "获取", "给我", "我要", "求", "发", "发下", "发个", "发一下"]) {
      for (const ending of ["", "吧", "呗"]) {
        expect(normalizeOriginalPictureCommand(`${prefix}${verb}原图${ending}`)).toBe(`${prefix}原图`);
      }
    }
  }
  for (const input of ["#求原图2", "#给我原图吧！", "#帮我发原图", "#发 原图", "#某人的原图", "#发一下原图吧 附言"]) {
    expect(normalizeOriginalPictureCommand(input)).toBe(input);
  }
});

test("本机两协议可使用原神角色卡命令，戳一戳不触发原神出图", async () => {
  await withDualGatewayFixture("genshin-avatar-fixture", "disablePrivate: false\n",
    async ({ ws, milky, onebot, sendOneBot, sendMilky, sendMilkyEvent }) => {
      sendOneBot("#胡桃卡片");
      const card = await onebot.next("send_msg");
      expect(card.params).toMatchObject({ user_id: 42 });
      assertImage(card.params);
      card.respond({ message_id: 101 });
      const poke = { post_type: "notice", notice_type: "notify", sub_type: "poke", user_id: 42, target_id: 99, self_id: 99 };
      ws.send(JSON.stringify(poke));
      await sendMilky("#老婆设置胡桃");
      const set = await milky.next("send_private_message");
      expect(JSON.stringify(set.params)).toContain("老婆已经设置");
      set.respond({ message_seq: 102 });
      expect((await sendMilkyEvent("friend_nudge", { user_id: 43, is_self_send: false, is_self_receive: true })).status).toBe(200);
      await sendMilky("#胡桃卡片");
      const second = await milky.next("send_private_message");
      expect(second.params).toMatchObject({ user_id: 43 });
      assertImage(second.params);
      second.respond({ message_seq: 103 });
      await Bun.sleep(100);
      expect(onebot.calls).toEqual([]);
      expect(milky.calls).toEqual([]);
    }, 8000, preload, prepare);
}, 20_000);

test("群 OneBot 和私聊 Milky 能用旧口语引用实际角色卡并取回原图", async () => {
  const image = (color: string) => renderPng(24, 17, context => {
    context.fillStyle = color;
    context.fillRect(0, 0, 24, 17);
  }).then(({ png }) => Buffer.from(png));
  const [original, replacement] = await Promise.all([image("#ff4466"), image("#65ffc0")]);
  const gallery = "./avatar-gallery/gs-character/胡桃";
  const key = (type: string, data: object) => ({ type, data });
  await withDualGatewayFixture("genshin-avatar-original-fixture", "disablePrivate: false\n",
    async ({ root, milky, onebot, sendOneBot, sendMilky }) => {
      const group = { message_type: "group", sub_type: "normal", group_id: 81 };
      sendOneBot("#胡桃卡片", group);
      const card = await onebot.next("send_msg");
      expect(card.params).toMatchObject({ group_id: 81 });
      const generated = assertImage(card.params);
      expect(generated).not.toEqual(original);
      card.respond({ message_id: -871 });

      await sendMilky("#胡桃卡片");
      const privateCard = await milky.next("send_private_message");
      assertImage(privateCard.params);
      privateCard.respond({ message_seq: 0 });
      sendOneBot("#胡桃卡片");
      (await onebot.next("send_msg")).respond({ message_id: 881 });
      await Bun.sleep(60);
      await writeFile(join(root, gallery, "另一张.png"), replacement);

      const phrase = "#给我原图吧";
      const quotedText = (text: string) => [key("reply", { id: "-871" }), key("text", { text })];
      sendOneBot(phrase, group);
      sendOneBot("#给我原图2", { ...group, message: quotedText("#给我原图2") });
      sendOneBot(phrase, { ...group, message: quotedText(phrase), user_id: 43 });
      sendOneBot(phrase, { ...group, message: quotedText(phrase) });
      const groupQuote = await onebot.next("get_msg");
      expect(groupQuote.params).toMatchObject({ message_id: -871 });
      groupQuote.respond({ message_type: "group", message_id: -871, group_id: 81, sender: { user_id: 99 },
        message: [key("image", { file: "verified.png" })] });
      const recovered = await onebot.next("send_msg");
      expect(recovered.params).toMatchObject({ group_id: 81 });
      expect(assertImage(recovered.params)).toEqual(original);
      recovered.respond({ message_id: 872 });

      const milkyPhrase = "#原神发一下原图呗";
      await sendMilky(milkyPhrase, { segments: [key("reply", { message_seq: 0 }), key("text", { text: milkyPhrase })] });
      const myQuote = await milky.next("get_message");
      expect(myQuote.params).toMatchObject({ message_scene: "friend", peer_id: 43, message_seq: 0 });
      myQuote.respond({ message: { message_scene: "friend", peer_id: 43, sender_id: 100, message_seq: 0,
        segments: [key("image", { resource_id: "verified", temp_url: "https://example.invalid/art.png" })] } });
      const privateOriginal = await milky.next("send_private_message");
      expect(assertImage(privateOriginal.params)).toEqual(original);
      privateOriginal.respond({ message_seq: 873 });

      const privateSource = [key("reply", { id: "881" }), key("text", { text: "求原图" })];
      sendOneBot("求原图", { message: privateSource });
      const info = { message_type: "private", sub_type: "friend", message_id: 881, sender: { user_id: 99 },
        message: [key("image", { file: "verified.png" })] };
      (await onebot.next("get_msg")).respond(info);
      const history = await onebot.next("get_friend_msg_history");
      expect(history.params).toMatchObject({ user_id: 42, message_seq: 881 });
      history.respond({ messages: [info] });
      const napcat = await onebot.next("send_msg");
      expect(assertImage(napcat.params)).toEqual(original);
      napcat.respond({ message_id: 882 });

      await writeFile(join(root, gallery, "当时所用.png"), replacement);
      sendOneBot("#原图", { ...group, message: quotedText("#原图") });
      (await onebot.next("get_msg")).respond({ message_type: "group", message_id: -871, group_id: 81, sender: { user_id: 99 },
        message: [key("image", { file: "verified.png" })] });
      await Bun.sleep(100);
      expect(onebot.calls).toEqual([]);
      expect(milky.calls).toEqual([]);
    }, 7500, preload + '\nBun.env.LOTUS_CHARACTER_GALLERY_DIR = "./avatar-gallery";\nBun.env.LOTUS_GENSHIN_PANEL_THEME_DIR = "./avatar-theme";\n', async root => {
      await prepare(root);
      await mkdir(join(root, gallery), { recursive: true });
      await writeFile(join(root, gallery, "当时所用.png"), original);
      await mkdir(join(root, "avatar-theme", "meta-gs", "character"), { recursive: true });
      await writeFile(join(root, "avatar-theme", "meta-gs", "character", "data.json"), JSON.stringify({
        10000046: { id: 10000046, name: "胡桃", elem: "pyro" },
      }));
    });
}, 20_000);
