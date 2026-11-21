import { expect, test } from "bun:test";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

test("真实宿主从已绑定主人私聊接两协议联系人，分页、空列表和回执不泄漏", async () => {
  await withDualGatewayFixture("owner-contact-fixture", 'master: ["99:42", "100:43"]\ndisablePrivate: true\n',
    async ({ milky, onebot, sendOneBot, sendMilky }) => {
      sendOneBot("#好友列表 3", { user_id: 43 });
      sendOneBot("#好友列表 4", { message_type: "group", group_id: 77 });
      sendOneBot("#好友列表 5", { sub_type: "group" });
      sendOneBot("#好友列表 6", { self_id: 100, user_id: 43 });
      sendOneBot("#好友列表 7", { sender: { user_id: 44 } });
      sendOneBot("#好友列表 8", { group_id: 77 });
      await sendMilky("#群列表 3", { sender_id: 42, peer_id: 42 });
      await sendMilky("#群列表 4", { message_scene: "group", peer_id: 77 });
      await sendMilky("#群列表 5", { peer_id: 42 });
      await sendMilky("#群列表 6", {}, 99);
      await Bun.sleep(100);
      const blocked = await onebot.next("send_msg");
      expect(blocked.params).toMatchObject({ user_id: 43, message: expect.stringContaining("私聊功能已禁用") });
      const milkyBlocked = await milky.next("send_private_message");
      expect(milkyBlocked.params).toMatchObject({ user_id: 42,
        message: [{ type: "text", data: { text: expect.stringContaining("私聊功能已禁用") } }],
      });
      milkyBlocked.respond({ message_seq: 200 });
      expect(onebot.calls).toEqual([]);
      expect(milky.calls).toEqual([]);

      sendOneBot("#获取群列表 2");
      (await onebot.next("get_group_list")).respond(Array.from({ length: 43 }, (_, i) => ({
        group_id: 700 + i, group_name: i === 41 ? "伪造\n名单" : `群名${i + 1}`,
      })));
      const ob = await onebot.next("send_private_forward_msg");
      expect(ob.params).toMatchObject({ user_id: 42, messages: [
        { type: "node", data: { content: [{ type: "text", data: { text: "群列表如下，共 43 条（第 2/2 页）" } }] } },
        { type: "node", data: { content: [{ type: "text", data: { text: "41、群名41(740)\n42、未知名称(741)\n43、群名43(742)" } }] } },
      ] });
      ob.respond({ message_id: -77 });

      sendOneBot("#好友列表");
      (await onebot.next("get_friend_list")).respond([]);
      const empty = await onebot.next("send_msg");
      expect(empty.params).toMatchObject({ user_id: 42, message: "当前账号没有好友。" });
      empty.respond({ message_id: 19 });

      sendOneBot("#群列表");
      (await onebot.next("get_group_list")).respond({}, "failed");
      const missing = await onebot.next("send_msg");
      expect(missing.params).toMatchObject({ user_id: 42, message: "群列表读取失败，请稍后再试。" });
      missing.respond({ message_id: 20 });

      sendOneBot("#获取好友列表");
      (await onebot.next("get_friend_list")).respond([{ user_id: "901", nickname: "好友乙" }]);
      const unknownOb = await onebot.next("send_private_forward_msg");
      expect(unknownOb.params).toMatchObject({ user_id: 42, messages: [
        { type: "node" },
        { type: "node", data: { content: [{ data: { text: "1、好友乙(901)" } }] } },
      ] });
      unknownOb.respond({});
      const unknownObReply = await onebot.next("send_msg");
      expect(unknownObReply.params).toMatchObject({ user_id: 42, message: "好友列表发送结果未确认，请先检查私聊。" });
      unknownObReply.respond({ message_id: 21 });

      sendOneBot("#好友列表 1");
      (await onebot.next("get_friend_list")).respond([{ user_id: 902, nickname: "拒绝样本好友" }]);
      (await onebot.next("send_private_forward_msg")).respond({}, "failed");
      const refusedOb = await onebot.next("send_msg");
      expect(refusedOb.params).toMatchObject({ user_id: 42, message: "好友列表未能发送，请稍后再试。" });
      refusedOb.respond({ message_id: 22 });

      await sendMilky("#获取好友列表");
      const friends = await milky.next("get_friend_list");
      expect(friends.params).toEqual({ no_cache: true });
      friends.respond({ friends: [{ user_id: 910, nickname: "好友甲" }] });
      const forward = await milky.next("send_private_message");
      expect(forward.params).toEqual({ user_id: 43, message: [{ type: "forward", data: { messages: [
        { user_id: 100, sender_name: "Lotus-Yunzai", segments: [{ type: "text", data: { text: "好友列表如下，共 1 条（第 1/1 页）" } }] },
        { user_id: 100, sender_name: "Lotus-Yunzai", segments: [{ type: "text", data: { text: "1、好友甲(910)" } }] },
      ] } }] });
      forward.respond({});
      const unknown = await milky.next("send_private_message");
      expect(unknown.params).toEqual({ user_id: 43, message: [{ type: "text", data: { text: "好友列表发送结果未确认，请先检查私聊。" } }] });
      unknown.respond({ message_seq: 201 });

      await sendMilky("#群列表 0");
      const invalid = await milky.next("send_private_message");
      expect(invalid.params).toMatchObject({ user_id: 43, message: [{ type: "text", data: { text: "用法 #群列表 [页码]" } }] });
      invalid.respond({ message_seq: 202 });

      await sendMilky("#群列表 2");
      (await milky.next("get_group_list")).respond({ groups: [{ group_id: 900, group_name: "群甲" }] });
      const outside = await milky.next("send_private_message");
      expect(outside.params).toMatchObject({ user_id: 43, message: [{ type: "text", data: { text: "群列表只有 1 页，请输入 1-1。" } }] });
      outside.respond({ message_seq: 203 });

      await sendMilky("#群列表");
      (await milky.next("get_group_list")).respond({ groups: [{ group_id: 999, group_name: "拒绝样本群" }] });
      (await milky.next("send_private_message")).respond({}, "failed");
      const rejected = await milky.next("send_private_message");
      expect(rejected.params).toEqual({ user_id: 43, message: [{ type: "text", data: { text: "群列表未能发送，请稍后再试。" } }] });
      rejected.respond({ message_seq: 204 });

      await sendMilky("#获取群列表 2");
      (await milky.next("get_group_list")).respond({ groups: Array.from({ length: 41 }, (_, i) => ({
        group_id: 1_100 + i, group_name: `Milky群${i + 1}`,
      })) });
      const second = await milky.next("send_private_message");
      expect(second.params).toMatchObject({ user_id: 43, message: [{ type: "forward", data: { messages: [
        { segments: [{ data: { text: "群列表如下，共 41 条（第 2/2 页）" } }] },
        { segments: [{ data: { text: "41、Milky群41(1140)" } }] },
      ] } }] });
      second.respond({ message_seq: 205 });

      await sendMilky("#好友列表");
      (await milky.next("get_friend_list")).respond({ friends: [] });
      const emptyMilky = await milky.next("send_private_message");
      expect(emptyMilky.params).toMatchObject({ user_id: 43, message: [{ data: { text: "当前账号没有好友。" } }] });
      emptyMilky.respond({ message_seq: 206 });

      await sendMilky("#好友列表 1");
      (await milky.next("get_friend_list")).respond({ friends: [null] });
      const malformedMilky = await milky.next("send_private_message");
      expect(malformedMilky.params).toMatchObject({ user_id: 43, message: [{ data: { text: "好友列表读取失败，请稍后再试。" } }] });
      malformedMilky.respond({ message_seq: 207 });

      await Bun.sleep(100);
      expect(onebot.calls).toEqual([]);
      expect(milky.calls).toEqual([]);
    });
}, 12_000);
