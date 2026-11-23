import { expect, test } from "bun:test";
import { cp, readFile, symlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

test("绝区零旧刷新间隔指令从 OneBot 群聊和 Milky 私聊接入同一份配置", async () => {
  await withDualGatewayFixture("zzz-panel-interval-fixture", 'master: ["99:42", "100:43"]\ndisablePrivate: false\n',
    async ({ root, onebot, milky, sendOneBot, sendMilky }) => {
      sendOneBot("%刷新面板间隔23", { message_type: "group", sub_type: "normal", group_id: 600 });
      const members = await onebot.next("get_group_member_list");
      expect(members.params).toMatchObject({ group_id: 600 });
      members.respond([{ group_id: 600, user_id: 42, nickname: "样本主人" }]);
      const groupReply = await onebot.next("send_msg");
      expect(JSON.stringify(groupReply.params)).toContain("绝区零刷新面板间隔已设置为 23 秒");
      groupReply.respond({ message_id: 151 });

      await sendMilky("#绝区零刷新角色间隔700");
      const friendReply = await milky.next("send_private_message");
      expect(JSON.stringify(friendReply.params)).toContain("绝区零刷新角色间隔已设置为 700 毫秒");
      friendReply.respond({ message_seq: 152 });

      sendOneBot("%刷新面板间隔21", { user_id: 43 });
      const denied = await onebot.next("send_msg");
      expect(JSON.stringify(denied.params)).toContain("仅限当前机器人的主人");
      denied.respond({ message_id: 153 });
      expect(Bun.YAML.parse(await readFile(join(root, "config", "zzz-panel.yaml"), "utf8")))
        .toEqual({ interval: 23, roleInterval: 700 });
    }, 6_000, undefined, async root => {
      const source = join(import.meta.dir, "..", "plugins", "zzz");
      const destination = join(root, "plugins", "zzz");
      await cp(source, destination, { recursive: true, filter: file => ![".git", "node_modules"].includes(basename(file)) });
      await symlink(join(source, "node_modules"), join(destination, "node_modules"), "dir");
    });
}, 14_000);
