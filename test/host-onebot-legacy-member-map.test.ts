import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

test("V3 群成员名单只读取当前群并保留旧 QQ、名片和昵称字段", async () => {
  await withDualGatewayFixture("legacy-member-map-fixture", "disablePrivate: false\n",
    async ({ onebot, sendOneBot }) => {
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
