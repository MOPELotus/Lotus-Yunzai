import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

test("真实宿主按当前账号主人手动退群，核回执、延时和撤权", async () => {
  await withDualGatewayFixture("manual-group-leave-fixture", 'master: ["99:42", "100:43"]\ndisablePrivate: false\n',
    async ({ root, ws, milky, onebot, sendOneBot, sendMilky }) => {
      sendOneBot("#退群 701", {
        user_id: 43, message_type: "group", sub_type: "normal", group_id: 700, sender: { user_id: 43, role: "owner" },
      });
      const denied = await onebot.next("send_msg");
      expect(denied.params).toMatchObject({ group_id: 700, message: "❎ 该命令仅限主人可用" });
      denied.respond({ message_id: 17 });
      sendOneBot("#退群 701", { self_id: 100, user_id: 43 });
      sendOneBot("#退群 701", { sub_type: "group" });
      sendOneBot("#退群 701", { message_type: "group", sub_type: "anonymous", group_id: 700 });
      await sendMilky("#退群 910", { sender_id: 42, peer_id: 42 });
      const wrongOwner = await milky.next("send_private_message");
      expect(wrongOwner.params).toMatchObject({ user_id: 42, message: [{ data: { text: "❎ 该命令仅限主人可用" } }] });
      wrongOwner.respond({ message_seq: 17 });
      await Bun.sleep(70);
      expect(onebot.calls).toEqual([]);
      expect(milky.calls).toEqual([]);

      sendOneBot("#退群");
      const noTarget = await onebot.next("send_msg");
      expect(noTarget.params).toMatchObject({ user_id: 42, message: "❎ 群号不能为空" });
      noTarget.respond({ message_id: 18 });
      sendOneBot("#退群 0");
      const invalid = await onebot.next("send_msg");
      expect(invalid.params).toMatchObject({ user_id: 42, message: "❎ 群号不合法" });
      invalid.respond({ message_id: 19 });
      sendOneBot("#退群 702");
      (await onebot.next("get_group_list")).respond([{ group_id: 701 }]);
      const nonmember = await onebot.next("send_msg");
      expect(nonmember.params).toMatchObject({ user_id: 42, message: "❎ 群聊列表查无此群" });
      nonmember.respond({ message_id: 20 });

      sendOneBot("#退群701", { message_type: "group", sub_type: "normal", group_id: 701 });
      (await onebot.next("get_group_list")).respond([{ group_id: 701 }]);
      const warning = await onebot.next("send_msg");
      expect(warning.params).toMatchObject({ group_id: 701, message: "⚠️ 3秒后退出本群聊" });
      const warnedAt = performance.now();
      warning.respond({ message_id: 21 });
      (await onebot.next("get_group_list")).respond([{ group_id: 701 }]);
      const ob = await onebot.next("set_group_leave");
      expect(performance.now() - warnedAt).toBeGreaterThanOrEqual(2_950);
      expect(ob.params).toEqual({ group_id: 701, is_dismiss: false });
      ob.respond(null);
      const success = await onebot.next("send_msg");
      expect(success.params).toMatchObject({ group_id: 701, message: "✅ 已退出群聊" });
      success.respond({ message_id: 22 });

      for (const [target, status, msg] of [
        [801, "failed", "❎ 退出失败"], [802, "unknown", "退群结果未确认，请先在 QQ 核对。"],
      ] as const) {
        sendOneBot(`#退群 ${target}`);
        (await onebot.next("get_group_list")).respond([{ group_id: target }]);
        const action = await onebot.next("set_group_leave");
        expect(action.params).toEqual({ group_id: target, is_dismiss: false });
        if (status === "failed") action.respond(null, "failed");
        else ws.send(JSON.stringify({ echo: action.echo, status: "ok", retcode: 1, data: null }));
        const result = await onebot.next("send_msg");
        expect(result.params).toMatchObject({ user_id: 42, message: msg });
        result.respond({ message_id: target });
      }

      for (const [target, status, text] of [
        [910, "ok", "✅ 已退出群聊"], [912, "failed", "❎ 退出失败"], [913, "unknown", "退群结果未确认，请先在 QQ 核对。"],
      ] as const) {
        await sendMilky(`#退群 ${target}`);
        const groups = await milky.next("get_group_list");
        expect(groups.params).toEqual({ no_cache: true });
        groups.respond({ groups: [{ group_id: target }] });
        const action = await milky.next("quit_group");
        expect(action.params).toEqual({ group_id: target });
        if (status === "unknown") action.respond(null);
        else action.respond({}, status);
        const result = await milky.next("send_private_message");
        expect(result.params).toMatchObject({ user_id: 43, message: [{ data: { text } }] });
        result.respond({ message_seq: target });
      }

      await sendMilky("#退群 914", { message_scene: "group", peer_id: 914 });
      (await milky.next("get_group_list")).respond({ groups: [{ group_id: 914 }] });
      const rejectedWarning = await milky.next("send_group_message");
      expect(rejectedWarning.params).toMatchObject({ group_id: 914, message: [{ data: { text: "⚠️ 3秒后退出本群聊" } }] });
      rejectedWarning.respond({}, "failed");
      const notice = await milky.next("send_group_message");
      expect(notice.params).toMatchObject({ group_id: 914, message: [{ data: { text: "未确认退群提醒，本次未退出。可在好友私聊中再操作。" } }] });
      notice.respond({ message_seq: 914 });

      await sendMilky("#退群911", { message_scene: "group", peer_id: 911 });
      (await milky.next("get_group_list")).respond({ groups: [{ group_id: 911 }] });
      const milkyWarning = await milky.next("send_group_message");
      expect(milkyWarning.params).toMatchObject({ group_id: 911, message: [{ data: { text: "⚠️ 3秒后退出本群聊" } }] });
      milkyWarning.respond({ message_seq: 911 });
      await writeFile(join(root, "config", "other.yaml"), 'master: ["99:42"]\ndisablePrivate: false\n');
      await Bun.sleep(3_200);
      expect(milky.calls).toEqual([]);
      await sendMilky("#退群 911", { message_scene: "group", peer_id: 911 });
      const revoked = await milky.next("send_group_message");
      expect(revoked.params).toMatchObject({ group_id: 911, message: [{ data: { text: "❎ 该命令仅限主人可用" } }] });
      revoked.respond({ message_seq: 915 });
      expect(milky.calls).toEqual([]);
      expect(onebot.calls).toEqual([]);
    }, 4_000);
}, 16_000);
