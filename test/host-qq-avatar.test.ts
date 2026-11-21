import { expect, test } from "bun:test";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

test("普通用户在当前 OneBot 和 Milky 会话查看或提取 QQ 头像", async () => {
  await withDualGatewayFixture("qq-avatar-fixture", "disablePrivate: false\n",
    async ({ ws, milky, onebot, sendOneBot, sendMilky }) => {
      sendOneBot("看头像");
      const own = await onebot.next("send_msg");
      expect(own.params).toMatchObject({ user_id: 42, message: [
        { type: "reply" }, { type: "image", data: { file: "https://q.qlogo.cn/g?b=qq&s=0&nk=42" } },
      ] });

      ws.send(JSON.stringify({
        self_id: 99, user_id: 42, message_type: "group", sub_type: "normal", group_id: 800, message_id: 101,
        post_type: "message", message: [{ type: "at", data: { qq: "61" } }, { type: "text", data: { text: "#取头像" } }],
      }));
      const mention = await onebot.next("send_msg");
      expect(mention.params).toMatchObject({ group_id: 800, message: [
        { type: "reply", data: { id: "101" } }, { type: "text", data: { text: "https://q.qlogo.cn/g?b=qq&s=0&nk=61" } },
      ] });

      sendOneBot("#查看群头像", { message_type: "group", sub_type: "normal", group_id: 800 });
      const current = await onebot.next("send_msg");
      expect(current.params).toMatchObject({ group_id: 800, message: [
        { type: "reply" }, { type: "image", data: { file: "https://p.qlogo.cn/gh/800/800/0" } },
      ] });

      sendOneBot("#查看头像", { message: [
        { type: "reply", data: { id: 98 } }, { type: "text", data: { text: "#查看头像" } },
      ] });
      const quoted = await onebot.next("send_msg");
      expect(quoted.params).toMatchObject({ user_id: 42, message: [
        { type: "reply" }, { type: "image", data: { file: "https://q.qlogo.cn/g?b=qq&s=0&nk=42" } },
      ] });

      sendOneBot("#取群头像 777");
      const explicit = await onebot.next("send_msg");
      expect(explicit.params).toMatchObject({ user_id: 42, message: [
        { type: "reply" }, { type: "text", data: { text: "https://p.qlogo.cn/gh/777/777/0" } },
      ] });

      await sendMilky("查看头像81");
      const image = await milky.next("send_private_message");
      expect(image.params).toMatchObject({ user_id: 43, message: [
        { type: "reply" },
        { type: "image", data: { uri: "https://q.qlogo.cn/g?b=qq&s=0&nk=81", sub_type: "normal" } },
      ] });
      image.respond({ message_seq: 201 });

      await sendMilky("取群头像", { message_scene: "group", peer_id: 700 });
      const group = await milky.next("send_group_message");
      expect(group.params).toMatchObject({ group_id: 700, message: [
        { type: "reply" }, { type: "text", data: { text: "https://p.qlogo.cn/gh/700/700/0" } },
      ] });
      group.respond({ message_seq: 202 });

      await sendMilky("取群头像");
      const missing = await milky.next("send_private_message");
      expect(missing.params).toMatchObject({ user_id: 43, message: [
        { type: "reply" }, { type: "text", data: { text: "❎ 获取头像错误" } },
      ] });
      missing.respond({ message_seq: 203 });

      await sendMilky("取头像 https://example.invalid/private");
      const invalid = await milky.next("send_private_message");
      expect(invalid.params).toMatchObject({ user_id: 43, message: [
        { type: "reply" }, { type: "text", data: { text: "❎ 获取头像错误" } },
      ] });
      invalid.respond({ message_seq: 204 });

      sendOneBot("#取头像 910", { self_id: 100 });
      sendOneBot("#取头像 912", { sub_type: "group" });
      await sendMilky("#取头像 913", { peer_id: 42 });
      await Bun.sleep(80);
      expect(onebot.calls).toEqual([]);
      expect(milky.calls).toEqual([]);
    });
}, 9_000);
