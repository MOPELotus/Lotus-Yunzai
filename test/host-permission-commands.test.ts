import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

test("旧权限只读命令在绑定主人会话出图，普通群主不能查看或写入", async () => {
  const config = "permissions: {default_policy: deny, users: {allow: [42], deny: [77]}, scopes: {checkin.refresh: {policy: inherit}}}\n";
  await withDualGatewayFixture("permission-chat-fixture", 'master: ["99:42", "100:43"]\ndisablePrivate: false\n',
    async ({ root, sendOneBot, sendMilky, onebot, milky }) => {
      const group = { message_type: "group", sub_type: "normal", group_id: 701, sender: { role: "owner" } };
      sendOneBot("#权限名单", { ...group, user_id: 44 });
      const rejected = await onebot.next("send_msg");
      expect(rejected.params).toMatchObject({ group_id: 701, message: "只有机器人主人可以查看或修改业务权限。" });
      rejected.respond({ message_id: 1 });

      sendOneBot("#权限配置", group);
      const owner = await onebot.next("send_msg");
      expect(owner.params).toMatchObject({ group_id: 701, message: [expect.objectContaining({ type: "image" })] });
      owner.respond({ message_id: 2 });

      await sendMilky("#签到白名单列表");
      const privateOwner = await milky.next("send_private_message");
      expect(privateOwner.params).toMatchObject({ user_id: 43, message: [expect.objectContaining({ type: "image" })] });
      privateOwner.respond({ message_seq: 3 });

      expect(await readFile(join(root, "config/global.yaml"), "utf8")).toBe(config);
      expect(await Bun.file(join(root, "data/audit/permissions.jsonl")).exists()).toBe(false);
      expect(onebot.calls).toEqual([]);
      expect(milky.calls).toEqual([]);
    }, 6_000, undefined, async (root) => {
      await mkdir(join(root, "config"), { recursive: true });
      await writeFile(join(root, "config/global.yaml"), config);
      await writeFile(join(root, "config/group.yaml"), "default: {groupCD: 0, singleCD: 0}\n");
    });
}, 18_000);
