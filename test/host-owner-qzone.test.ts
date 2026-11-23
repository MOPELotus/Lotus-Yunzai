import { expect, test } from "bun:test";
import { readQzonePage } from "../lib/adapters/qzone.ts";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII=";
const pngUrl = "https://gchat.qpic.cn/download?fixture=qzone";
const offline = `
  const fetchLocal = globalThis.fetch;
  globalThis.fetch = (input, options) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname === "127.0.0.1") return fetchLocal(input, options);
    if (url.href !== ${JSON.stringify(pngUrl)} || options?.redirect !== "error") throw Error("unexpected network read");
    return Promise.resolve(new Response(Buffer.from(${JSON.stringify(png)}, "base64"), { headers: { "content-type": "image/png" } }));
  };
`;
const post = (tid: string, content: string, time: number, is_private = false) => ({ tid, content, time, is_private, comment_num: 2 });
const posts = [post("first", "较早的内容", 1_700_000_000), post("second", "较新的内容", 1_700_001_000, true)];
const quoted = (id: number, text: string) => ({
  raw_message: `[CQ:reply,id=${id}]${text}`,
  message: [{ type: "reply", data: { id: String(id) } }, { type: "text", data: { text } }],
});

test("说说列表识别 NapCat 的未知总数与缺失动态标识，拒绝冲突标识", () => {
  const result = readQzonePage({ total: 1, total_known: false, msglist: [post("", "测试", 0)] }, 5, 5);
  expect(result).toEqual({ total: 1, totalKnown: false, posts: [{ tid: undefined, content: "测试", time: 0, private: false, comments: 2 }] });
  expect(readQzonePage({ total: 2, msglist: [posts[0], posts[0]] }, 0, 5)).toBeUndefined();
  expect(readQzonePage({ total: 2, msglist: posts }, 5, 5)).toBeUndefined();
});

test("真实宿主仅从绑定主人的好友私聊读写当前 NapCat 空间，删除锁定到送达页和动态标识", async () => {
  await withDualGatewayFixture("owner-qzone-fixture", 'master: ["99:42", "100:43"]\ndisablePrivate: false\n',
    async ({ onebot, milky, sendOneBot, sendMilky }) => {
      const version = async (app = "NapCat.Onebot") => (await onebot.next("get_version_info")).respond({ app_name: app });
      const friends = async (ids = [42]) => (await onebot.next("get_friend_list")).respond(ids.map(user_id => ({ user_id })));
      const auth = async () => { await version(); await friends(); };
      const list = async (offset: number, rows = posts) => {
        const list = await onebot.next("get_qzone_msg_list");
        expect(list.params).toEqual({ target_uin: "99", pos: offset, num: 5 });
        list.respond({ total: 12, msglist: rows });
      };
      async function reply(contains: string, id?: number, target = 42) {
        const message = await onebot.next("send_msg");
        expect(message.params.user_id ?? message.params.group_id).toBe(target);
        expect(message.params.message).toContain(contains);
        if (id !== undefined) message.respond({ message_id: id });
        return message;
      }

      sendOneBot("#取说说列表", { user_id: 43 });
      await reply("只有当前机器人已绑定的主人", undefined, 43);
      sendOneBot("#取说说列表", { message_type: "group", sub_type: "normal", group_id: 701 });
      await reply("好友私聊", undefined, 701);
      await sendMilky("#取说说列表");
      const milkyReply = await milky.next("send_private_message");
      expect(milkyReply.params).toMatchObject({ user_id: 43, message: [{ data: { text: expect.stringContaining("需要支持空间说说的 NapCat") } }] });
      milkyReply.respond({ message_seq: 501 });
      sendOneBot("#取说说列表");
      await version("other implementation");
      await reply("需要支持空间说说的 NapCat");
      sendOneBot("#获取说说列表");
      await version();
      await friends([43]);
      await reply("无法确认当前机器人的好友关系");

      sendOneBot("#删除说说6");
      await auth();
      await reply("请先获取包含该序号");
      sendOneBot("#获取说说列表 2");
      await auth();
      await list(5);
      const numbered = await reply("6. 较新的内容\n- [私密]", 601);
      expect(numbered.params.message).toContain("7. 较早的内容\n- [公开]");
      expect(numbered.params.message).toContain("页数：2/3");

      sendOneBot("", quoted(600, "#删除说说6"));
      await auth();
      await reply("请先获取包含该序号");
      sendOneBot("", quoted(601, "#删除说说6"));
      await auth();
      await list(5, [posts[0]!, post("new", "刚发布的新说说", 1_700_002_000)]);
      await reply("说说列表位置发生变化");

      sendOneBot("#取说说列表2");
      await auth();
      await list(5);
      await reply("页数：2/3", 602);
      sendOneBot("", { message_id: 902, ...quoted(602, "#删说说6") });
      await auth();
      await list(5);
      await friends();
      const deletion = await onebot.next("delete_qzone_msg");
      expect(deletion.params).toEqual({ tid: "second" });
      deletion.respond(null);
      await reply("删除说说成功");
      await Bun.sleep(1_050);
      sendOneBot("", { message_id: 902, ...quoted(602, "#删说说6") });
      await Bun.sleep(60);
      expect(onebot.calls).toEqual([]);

      sendOneBot("#取说说列表 2");
      await auth();
      await list(5);
      (await reply("页数：2/3")).respond({});
      sendOneBot("#删除说说 6");
      await auth();
      await reply("请先获取包含该序号");

      sendOneBot("#发说说一般文本#标签");
      await auth();
      const publication = await onebot.next("send_qzone_msg");
      expect(publication.params).toEqual({ content: "一般文本#标签", ugc_right: 1 });
      publication.respond({ tid: "", time: 0 });
      await reply("发表结果未确认");

      sendOneBot("", { message: [
        { type: "text", data: { text: "#发说说" } }, { type: "image", data: { url: pngUrl } },
      ] });
      await auth();
      await friends();
      const withImage = await onebot.next("send_qzone_msg");
      expect(withImage.params).toEqual({ content: "", images: [`base64://${png}`], ugc_right: 1 });
      withImage.respond({ tid: "post-with-image", time: 0 });
      const sent = await onebot.next("send_msg");
      expect(sent.params).toMatchObject({ user_id: 42, message: [
        { type: "text", data: { text: expect.stringContaining("发表说说成功") } },
        { type: "image", data: { file: `base64://${png}` } },
        { type: "text", data: { text: expect.stringContaining("时间未知") } },
      ] });

      sendOneBot("", quoted(700, "#发说说 引用图片"));
      await auth();
      const quote = await onebot.next("get_msg");
      expect(quote.params).toEqual({ message_id: 700 });
      quote.respond({ message_id: 700, message_type: "private", sub_type: "friend", self_id: 99,
        sender: { user_id: 42 }, target_id: 99, message: [{ type: "image", data: { url: pngUrl } }] });
      await friends();
      const quotedImage = await onebot.next("send_qzone_msg");
      expect(quotedImage.params).toEqual({ content: "引用图片", images: [`base64://${png}`], ugc_right: 1 });
      quotedImage.respond(undefined, "failed");
      await reply("发表结果未确认");
      expect(onebot.calls).toEqual([]);
      expect(milky.calls).toEqual([]);
    }, 4_000, offline);
}, 15_000);
