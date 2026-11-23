import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

function book(rows: Record<string, readonly string[]>) {
  return JSON.stringify(Object.fromEntries(Object.entries(rows)
    .map(([name, variants]) => [name, variants.map(text => [{ type: "text", text }])])));
}

test("旧合并及全局表情目录走 OneBot 和 Milky 的当前会话并保留现有词条回放", async () => {
  const global = book({ 同名: ["全局一", "全局二"], 全局独有: ["全局内容"] });
  const local = book({ 同名: ["群版本"], 本群独有: ["群内容"] });
  const other = book({ 别群独有: ["不得出现在其他群"] });
  const combined = "3. 本群独有(1)\n2. 全局独有(1)\n1. 同名(1)";
  const globalOnly = "2. 全局独有(1)\n1. 同名(2)";
  await withDualGatewayFixture("mora-keyword-fixture", 'master: ["99:42", "100:43"]\ndisablePrivate: false\n',
    async ({ root, onebot, milky, sendOneBot, sendMilky }) => {
      const onebotGroup = { message_type: "group", sub_type: "normal", group_id: 77, sender: { role: "member" } };
      const milkyGroup = { message_scene: "group", peer_id: 77 };
      const wire = (data: unknown) => JSON.stringify(data).replaceAll("\\n", "\n");
      sendOneBot("#合并词条列表", onebotGroup);
      const onebotCombined = await onebot.next("send_group_forward_msg");
      expect(onebotCombined.params.group_id).toBe(77);
      expect(wire(onebotCombined.params)).toContain(combined);
      expect(wire(onebotCombined.params)).not.toContain("别群独有");
      onebotCombined.respond({ message_id: 130 });

      sendOneBot("#全局表情列表");
      const onebotGlobal = await onebot.next("send_private_forward_msg");
      expect(onebotGlobal.params.user_id).toBe(42);
      expect(wire(onebotGlobal.params)).toContain(globalOnly);
      expect(wire(onebotGlobal.params)).not.toContain("本群独有");
      onebotGlobal.respond({ message_id: 131 });

      expect((await sendMilky("#合并词条列表", milkyGroup)).status).toBe(200);
      const milkyCombined = await milky.next("send_group_message");
      expect(milkyCombined.params.group_id).toBe(77);
      expect(milkyCombined.params.message).toMatchObject([{ type: "forward" }]);
      expect(wire(milkyCombined.params)).toContain(combined);
      expect(wire(milkyCombined.params)).not.toContain("别群独有");
      milkyCombined.respond({ message_seq: 132 });

      expect((await sendMilky("#全局表情列表")).status).toBe(200);
      const milkyGlobal = await milky.next("send_private_message");
      expect(milkyGlobal.params.user_id).toBe(43);
      expect(wire(milkyGlobal.params)).toContain(globalOnly);
      expect(wire(milkyGlobal.params)).not.toContain("本群独有");
      milkyGlobal.respond({ message_seq: 133 });

      sendOneBot("#合并词条 列表1");
      const check = await onebot.next("get_group_member_info");
      expect(check.params).toEqual({ user_id: 42, group_id: 77, no_cache: true });
      check.respond({ user_id: 42, group_id: 88, role: "member" });
      const denied = await onebot.next("send_msg");
      expect(wire(denied.params)).toContain("请在所属群");
      expect(wire(denied.params)).not.toContain("别群独有");
      denied.respond({ message_id: 134 });

      expect((await sendMilky("#合并词条 列表1")).status).toBe(200);
      const member = await milky.next("get_group_member_info");
      expect(member.params).toEqual({ user_id: 43, group_id: 77, no_cache: true });
      member.respond({ member: { user_id: 43, group_id: 77, role: "member" } });
      const confirmed = await milky.next("send_private_message");
      expect(confirmed.params.user_id).toBe(43);
      expect(wire(confirmed.params)).toContain(combined);
      confirmed.respond({ message_seq: 135 });

      expect((await sendMilky("#合并词条 别群独有", milkyGroup)).status).toBe(200);
      const foreign = await milky.next("send_group_message");
      expect(wire(foreign.params)).toContain("暂无消息");
      foreign.respond({ message_seq: 136 });

      sendOneBot("同名2", onebotGroup);
      const replay = await onebot.next("send_msg");
      expect(wire(replay.params)).toContain("全局一");
      replay.respond({ message_id: 137 });

      const data = join(root, "data", "messageJson");
      expect(await readFile(join(data, "global.json"), "utf8")).toBe(global);
      expect(await readFile(join(data, "77.json"), "utf8")).toBe(local);
      expect(await readFile(join(data, "88.json"), "utf8")).toBe(other);
    }, 5_000, undefined, async root => {
      const data = join(root, "data", "messageJson");
      await mkdir(data, { recursive: true });
      await writeFile(join(data, "global.json"), global);
      await writeFile(join(data, "77.json"), local);
      await writeFile(join(data, "88.json"), other);
      await writeFile(join(root, "config", "group.yaml"), "default: {groupCD: 0, singleCD: 0, addReply: false, addRecall: 0}\n");
    });
}, 18_000);

test("Mora 合并词条预览经双协议发送图片和 QQ 表情、群名片为纯文本", async () => {
  const image = "a".repeat(32);
  const unavailable = "b".repeat(32);
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
  const name = `预览{image_${image}}{face:14}{face_7} {at:12345} {at:23456} {image:${unavailable}} {image:https://router.invalid/}`;
  const preload = `
    import { appendFileSync } from "node:fs";
    const actualFetch = globalThis.fetch;
    globalThis.fetch = async (input, options) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.hostname === "gchat.qpic.cn" || url.hostname === "router.invalid") appendFileSync("preview-fetch.log", url.href + "\\n");
      if (url.hostname === "router.invalid") throw new Error("无关链接被读取");
      if (url.hostname !== "gchat.qpic.cn") return actualFetch(input, options);
      if (url.protocol !== "https:" || options.credentials !== "omit" || options.redirect !== "error" ||
          !/^\\/gchatpic_new\\/0\\/0-0-[A-F0-9]{32}\\/0$/.test(url.pathname)) throw new Error("QQ 预览链接校验失败");
      if (url.pathname.includes(${JSON.stringify(image.toUpperCase())})) {
        return new Response(Buffer.from(${JSON.stringify(png)}, "base64"), {headers: {"content-type": "image/png"}});
      }
      return Response.json({message: "旧图不可读"}, {status: 404});
    };
  `;
  await withDualGatewayFixture("mora-keyword-preview", 'master: ["99:42", "100:43"]\ndisablePrivate: false\n',
    async ({ root, onebot, milky, sendOneBot, sendMilky, ws }) => {
      const onebotGroup = { message_type: "group", sub_type: "normal", group_id: 77, sender: { role: "member" } };
      const milkyGroup = { message_scene: "group", peer_id: 77 };
      sendOneBot("#合并词条列表", onebotGroup);
      for (const member of [12345, 23456]) {
        const query = await onebot.next("get_group_member_info");
        expect(query.params).toEqual({ group_id: 77, user_id: member, no_cache: true });
        query.respond({ group_id: member === 12345 ? 77 : 88, user_id: member, role: "member",
          card: member === 12345 ? "本群名片" : "其他群名片", nickname: "旧昵称" });
      }
      const onebotList = await onebot.next("send_group_forward_msg");
      expect(onebotList.params.messages).toMatchObject([
        { type: "node" },
        { type: "node", data: { content: expect.arrayContaining([
          { type: "image", data: { file: `base64://${png}` } },
          { type: "face", data: { id: "14" } },
          { type: "face", data: { id: "7" } },
          { type: "text", data: { text: "@本群名片" } },
          { type: "text", data: { text: "{at:23456}" } },
          { type: "text", data: { text: `{image:${unavailable}}` } },
        ]) } },
      ]);
      expect(JSON.stringify(onebotList.params)).not.toMatch(/"type":"at"|其他群名片/u);
      onebotList.respond(undefined, "failed");
      const plain = await onebot.next("send_msg");
      expect(plain.params.message).toBe(`消息列表：第1页，共1条\n1. ${name}(1)`);
      plain.respond({ message_id: 142 });

      expect((await sendMilky("#合并词条列表", milkyGroup)).status).toBe(200);
      for (const member of [12345, 23456]) {
        const query = await milky.next("get_group_member_info");
        expect(query.params).toEqual({ group_id: 77, user_id: member, no_cache: true });
        query.respond({ member: { group_id: 77, user_id: member === 12345 ? 12345 : 99999,
          role: "member", nickname: member === 12345 ? "可用昵称" : "错误成员" } });
      }
      const milkyList = await milky.next("send_group_message");
      expect(milkyList.params.message).toMatchObject([{ type: "forward", data: { messages: [
        { segments: [{ type: "text" }] },
        { segments: expect.arrayContaining([
          { type: "image", data: { uri: `base64://${png}`, sub_type: "normal" } },
          { type: "face", data: { face_id: "14" } },
          { type: "face", data: { face_id: "7" } },
          { type: "text", data: { text: "@可用昵称" } },
          { type: "text", data: { text: "{at:23456}" } },
        ]) },
      ] } }]);
      expect(JSON.stringify(milkyList.params)).not.toMatch(/"type":"mention"|错误成员/u);
      milkyList.respond({ message_seq: 143 });

      sendOneBot("#合并词条 预览", onebotGroup);
      (await onebot.next("get_group_member_info")).respond({ group_id: 77, user_id: 12345, role: "member", card: "本群名片" });
      const pending = await onebot.next("get_group_member_info");
      expect(pending.params.user_id).toBe(23456);
      ws.close();
      await Bun.sleep(100);
      expect(onebot.calls).toEqual([]);
      const requests = (await readFile(join(root, "preview-fetch.log"), "utf8")).trim().split("\n");
      expect([...new Set(requests)].sort()).toEqual([image, unavailable]
        .map(id => `https://gchat.qpic.cn/gchatpic_new/0/0-0-${id.toUpperCase()}/0`));
    }, 5_000, preload, async root => {
      const data = join(root, "data", "messageJson");
      await mkdir(data, { recursive: true });
      await writeFile(join(data, "77.json"), book({ [name]: ["旧词条"] }));
      await writeFile(join(root, "config", "group.yaml"), "default: {groupCD: 0, singleCD: 0}\n");
    });
}, 18_000);
