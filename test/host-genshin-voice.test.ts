import { expect, test } from "bun:test";
import { cp, symlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const fixtureMedia = "https://uploadstatic.mihoyo.com/ys-obc/2022/05/12/1234/";
const prefix = "ID3";
const fakeAudio = (language: string) => Buffer.from(prefix + language.padEnd(60, "0"));
const preload = `
const transport = globalThis.fetch;
const audio = ${JSON.stringify(fixtureMedia)};
globalThis.fetch = async (value, options) => {
  const address = new URL(value instanceof Request ? value.url : value);
  if (address.hostname === "127.0.0.1" || address.hostname === "localhost") return transport(value, options);
  if (options?.credentials !== "omit" || options?.redirect !== "error") throw new Error("测试仅允许官方匿名语音读请求");
  if (address.host === "api-static.mihoyo.com" && address.searchParams.get("channel_id") === "189") {
    return Response.json({ retcode: 0, data: { list: [{ children: [{ name: "角色", list: [{ title: "可莉", content_id: 55 }] }] }] } });
  }
  if (address.host === "api-takumi-static.mihoyo.com" && address.searchParams.get("entry_page_id") === "55") {
    const list = [["汉语", "cn"], ["日语", "jp"], ["英语", "en"], ["韩语", "kr"]].map(([tab_name, tag]) => ({
      tab_name, table: [{ name: "初次见面…", content: "火花骑士，前来报到！", audio_url: audio + tag + ".mp3" }],
    }));
    return Response.json({ retcode: 0, data: { page: { id: "55", name: "可莉", modules: [
      { components: [{ component_id: "role_voice", data: JSON.stringify({ list }) }] },
    ] } } });
  }
  if (address.href.startsWith(audio)) {
    const lang = address.pathname.split("/").pop().split(".")[0];
    return new Response(Buffer.from(${JSON.stringify(prefix)} + lang.padEnd(60, "0")), {
      headers: { "content-type": "audio/mpeg" },
    });
  }
  throw new Error("隔离测试拒绝额外出站");
};
`;

function mediaBytes(params: unknown) {
  const encoded = /base64:\/\/([A-Za-z0-9+/=]+)/u.exec(JSON.stringify(params))?.[1];
  expect(encoded).toBeDefined();
  return Buffer.from(encoded!, "base64");
}

const segment = (type: string, data: object) => ({ type, data });

test("原神角色语音经 OneBot 群与 Milky 好友真实分发、确认列表、引用后按语言发单独语音", async () => {
  await withDualGatewayFixture("genshin-voice-fixture", "disablePrivate: false\n",
    async ({ onebot, milky, sendOneBot, sendMilky }) => {
      const group = { message_type: "group", sub_type: "normal", group_id: 81 };
      sendOneBot("#可莉语音列表", group);
      const groupList = await onebot.next("send_msg");
      expect(groupList.params).toMatchObject({ group_id: 81 });
      expect(mediaBytes(groupList.params).subarray(1, 4).toString()).toBe("PNG");
      groupList.respond({ message_id: -101 });

      await sendMilky("可莉语音列表");
      const privateList = await milky.next("send_private_message");
      expect(mediaBytes(privateList.params).subarray(1, 4).toString()).toBe("PNG");
      privateList.respond({ message_seq: 0 });

      const quotedOneBot = [segment("reply", { id: "-101" }), segment("text", { text: "日语1" })];
      sendOneBot("日语1", { ...group, group_id: 82, message: quotedOneBot });
      sendOneBot("日语1", { ...group, message: quotedOneBot, user_id: 55 });
      const groupQuote = await onebot.next("get_msg");
      expect(groupQuote.params).toMatchObject({ message_id: -101 });
      groupQuote.respond({ message_type: "group", group_id: 81, message_id: -101,
        sender: { user_id: 99 }, message: [segment("image", { file: "verified.png" })] });
      const groupTitle = await onebot.next("send_msg");
      expect(JSON.stringify(groupTitle.params)).toContain("可莉 · 1. 初次见面… · 日语");
      groupTitle.respond({ message_id: -102 });
      const groupAudio = await onebot.next("send_msg");
      expect(mediaBytes(groupAudio.params)).toEqual(fakeAudio("jp"));
      expect(JSON.stringify(groupAudio.params)).toContain('"type":"record"');
      groupAudio.respond({ message_id: -103 });

      await sendMilky("1韩语", { segments: [segment("reply", { message_seq: 0 }), segment("text", { text: "1韩语" })] });
      const privateQuote = await milky.next("get_message");
      expect(privateQuote.params).toMatchObject({ message_scene: "friend", peer_id: 43, message_seq: 0 });
      privateQuote.respond({ message: { message_scene: "friend", peer_id: 43, sender_id: 100, message_seq: 0,
        segments: [segment("image", { resource_id: "verified", temp_url: "https://example.invalid/verified.png" })] } });
      const privateTitle = await milky.next("send_private_message");
      expect(JSON.stringify(privateTitle.params)).toContain("可莉 · 1. 初次见面… · 韩语");
      privateTitle.respond({ message_seq: 1 });
      const privateAudio = await milky.next("send_private_message");
      expect(mediaBytes(privateAudio.params)).toEqual(fakeAudio("kr"));
      expect(JSON.stringify(privateAudio.params)).toContain('"type":"record"');
      privateAudio.respond({ message_seq: 2 });
      expect(onebot.calls).toEqual([]);
      expect(milky.calls).toEqual([]);
    }, 12_000, preload, async root => {
      const source = join(import.meta.dir, "../plugins/genshin");
      const target = join(root, "plugins", "genshin");
      await cp(source, target, { recursive: true, filter: path => ![".git", "node_modules"].includes(basename(path)) });
      await symlink(join(source, "node_modules"), join(target, "node_modules"), "dir");
      await symlink(join(import.meta.dir, "../packages"), join(root, "packages"), "dir");
    });
}, 35_000);
