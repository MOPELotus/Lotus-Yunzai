import { expect, test } from "bun:test";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

test("隔离双协议承接旧屏蔽词开关、两种范围、真实文本和处罚回执", async () => {
  await withDualGatewayFixture("screened-words-fixture", 'master: ["99:52", "100:51"]\ndisablePrivate: false\n',
    async ({ root, onebot, milky, sendOneBot, sendMilky }) => {
      const group = (group_id: number, user_id = 42) => ({ message_type: "group", sub_type: "normal", group_id, user_id });
      const milkyGroup = { message_scene: "group", peer_id: 701, sender_id: 42,
        group_member: { group_id: 701, user_id: 42, role: "member" } };
      const text = (value: string) => ({ type: "text", data: { text: value } });
      async function oneBotRoles(groupId: number, role: "member" | "admin", calls = 2) {
        for (let i = 0; i < calls; i++) {
          const member = await onebot.next("get_group_member_info");
          expect(member.params).toMatchObject({ group_id: groupId, no_cache: true });
          member.respond({ group_id: groupId, user_id: member.params.user_id, role: member.params.user_id === 99 ? "admin" : role });
        }
      }

      sendOneBot("#屏蔽词列表", group(701));
      const disabled = await onebot.next("send_msg");
      expect(disabled.params).toMatchObject({ group_id: 701, message: "屏蔽词监听当前关闭。" });
      disabled.respond({ message_id: 1001 });
      sendOneBot("#抽卡设置 屏蔽词 开启", { user_id: 52 });
      const toggle = await onebot.next("send_msg");
      expect(toggle.params).toMatchObject({ user_id: 52, message: "已开启屏蔽词监听。" });
      toggle.respond({ message_id: 1002 });

      sendOneBot("屏蔽词列表", group(701));
      const lists = await onebot.next("send_group_forward_msg");
      expect(JSON.stringify(lists.params)).toContain("全局旧词");
      expect(JSON.stringify(lists.params)).toContain("本群旧词");
      lists.respond({ message_id: 1003 });

      sendOneBot("#屏蔽全局 新的本群词", group(701));
      await oneBotRoles(701, "admin", 4);
      const edit = await onebot.next("send_msg");
      expect(edit.params).toMatchObject({ group_id: 701, message: "新增本群屏蔽词：【新的本群词】" });
      edit.respond({ message_id: 1004 });

      sendOneBot("当前全球用例", { ...group(701), message_id: 601,
        message: [text("前缀全局"), { type: "face", data: { id: "14" } }, text("旧词后缀")] });
      await oneBotRoles(701, "member");
      const recalled = await onebot.next("delete_msg");
      expect(recalled.params).toEqual({ message_id: 601 });
      recalled.respond({});
      const muted = await onebot.next("set_group_ban");
      expect(muted.params).toEqual({ group_id: 701, user_id: 42, duration: 73 });
      muted.respond({});
      const reply = await onebot.next("send_msg");
      expect(reply.params).toMatchObject({ group_id: 701, message: "已处理该条屏蔽词" });
      reply.respond({ message_id: 1005 });

      await sendMilky("本群旧词触发", milkyGroup);
      for (let i = 0; i < 2; i++) {
        const member = await milky.next("get_group_member_info");
        expect(member.params).toMatchObject({ group_id: 701, no_cache: true });
        member.respond({ member: { group_id: 701, user_id: member.params.user_id, role: member.params.user_id === 100 ? "admin" : "member" } });
      }
      const milkyRecall = await milky.next("recall_group_message");
      expect(milkyRecall.params).toMatchObject({ group_id: 701, message_seq: expect.any(Number) });
      milkyRecall.respond({}, "failed");
      const milkyMute = await milky.next("set_group_member_mute");
      expect(milkyMute.params).toEqual({ group_id: 701, user_id: 42, duration: 73 });
      milkyMute.respond({});
      const partial = await milky.next("send_group_message");
      expect(JSON.stringify(partial.params)).toContain("撤回消息未执行");
      expect(JSON.stringify(partial.params)).not.toContain("已处理该条屏蔽词");
      partial.respond({ message_seq: 1006 });

      sendOneBot("本群旧词", group(702));
      sendOneBot("全局旧词", group(703));
      sendOneBot("全局旧词", group(701, 52));
      await Bun.sleep(80);
      expect(onebot.calls).toEqual([]);
      expect(milky.calls).toEqual([]);
      expect(await readFile(join(root, "plugins/flower-plugin/resources/blackword/701/original.yaml"), "utf8")).toBe("- 本群旧词\n");
    }, 3_000, undefined, async root => {
      await cp(new URL("../plugins/group", import.meta.url), join(root, "plugins/group"), {
        recursive: true, filter: source => basename(source) !== ".git" && basename(source) !== "node_modules",
      });
      const flower = join(root, "plugins/flower-plugin");
      const oldGroup = join(flower, "resources/blackword/701");
      const oldGlobal = join(flower, "resources/blackword/global");
      const oldRules = join(root, "plugins/yenai-plugin/config/group");
      await Promise.all([oldGroup, oldGlobal, oldRules, join(flower, "config")].map(path => mkdir(path, { recursive: true })));
      await writeFile(join(flower, "config/wordListener.yaml"), "enable: false\ntime: 73\nreplyText: 已处理该条屏蔽词\n");
      await writeFile(join(oldGroup, "original.yaml"), "- 本群旧词\n");
      await writeFile(join(oldGlobal, "original.yaml"), "- 全局旧词\n");
      await writeFile(join(oldRules, "701.json"), JSON.stringify({ bannedWords: { 本群旧词: { matchType: 2, penaltyType: 1 } } }));
      await writeFile(join(root, "config/group.yaml"), 'default: { groupCD: 0, singleCD: 0 }\n703: { disable: ["[group] 屏蔽词"] }\n');
    });
}, 12_000);
