import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

test("V3 群成员名单在 OneBot 和 Milky 只读取当前群并保留 QQ、名片和昵称", async () => {
  await withDualGatewayFixture("legacy-member-map-fixture", "disablePrivate: false\n",
    async ({ onebot, sendOneBot, milky, sendMilky }) => {
      const group = { message_type: "group", sub_type: "normal", group_id: 701, sender: { user_id: 42, role: "member" } };
      sendOneBot("#旧群成员", group);
      const roster = await onebot.next("get_group_member_list");
      expect(roster.params).toEqual({ group_id: 701, no_cache: true });
      roster.respond([
        { group_id: 701, user_id: 42, nickname: "QQ 昵称", card: "群名片" },
        { group_id: 701, user_id: 43, nickname: "备用昵称" },
      ]);
      expect((await onebot.next("send_msg")).params).toMatchObject({
        group_id: 701,
        message: '[701,{"user_id":42,"card":"群名片","nickname":"QQ 昵称"},{"user_id":43,"card":"","nickname":"备用昵称"}]',
      });

      sendOneBot("#旧群成员", group);
      const malformed = await onebot.next("get_group_member_list");
      malformed.respond([{ group_id: 702, user_id: 42, nickname: "另一群" }]);
      expect((await onebot.next("send_msg")).params).toMatchObject({ group_id: 701, message: "名单不可用" });

      sendOneBot("#旧群成员");
      expect((await onebot.next("send_msg")).params).toMatchObject({ user_id: 42, message: "当前会话无群" });
      expect(onebot.calls).toEqual([]);

      const milkyGroup = { message_scene: "group", peer_id: 701 };
      expect((await sendMilky("#旧群成员", milkyGroup)).status).toBe(200);
      const milkyRoster = await milky.next("get_group_member_list");
      expect(milkyRoster.params).toEqual({ group_id: 701, no_cache: true });
      milkyRoster.respond({ members: [
        { group_id: 701, user_id: 42, nickname: "QQ 昵称", card: "群名片" },
        { group_id: 701, user_id: 43, nickname: "备用昵称" },
      ] });
      const groupReply = await milky.next("send_group_message");
      expect(groupReply.params.group_id).toBe(701);
      expect(JSON.stringify(groupReply.params.message)).toContain("群名片");
      expect(JSON.stringify(groupReply.params.message)).toContain("备用昵称");
      groupReply.respond({ message_seq: 8 });

      expect((await sendMilky("#旧群成员", milkyGroup)).status).toBe(200);
      const wrongGroup = await milky.next("get_group_member_list");
      wrongGroup.respond({ members: [{ group_id: 702, user_id: 42, nickname: "另一群" }] });
      const rejected = await milky.next("send_group_message");
      expect(JSON.stringify(rejected.params.message)).toContain("名单不可用");
      rejected.respond({ message_seq: 9 });

      expect((await sendMilky("#旧群成员")).status).toBe(200);
      const privateReply = await milky.next("send_private_message");
      expect(JSON.stringify(privateReply.params.message)).toContain("当前会话无群");
      privateReply.respond({ message_seq: 10 });
      expect(milky.calls).toEqual([]);
    }, 4_000, undefined, root => writeFile(join(root, "plugins", "member-map-fixture.js"), `
      export default class extends plugin {
        constructor() { super({ rule: [{ reg: /^#旧群成员$/, fnc: "members" }] }); }
        async members(e) {
          if (!e.group || !e.group.getMemberMap) return e.reply("当前会话无群");
          const map = await e.group.getMemberMap(702).catch(() => undefined);
          return e.reply(map ? JSON.stringify([e.group.group_id, map.get(42), map.get(43)]) : "名单不可用");
        }
      }
    `));
}, 10_000);
