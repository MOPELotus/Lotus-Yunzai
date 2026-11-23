import { expect, test } from "bun:test";
import { cp, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { bindGroupName } from "../lib/adapters/group-name.ts";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

test("群改名使用两个协议各自的字段、实时群角色和原会话", async () => {
  await withDualGatewayFixture("group-name-fixture", 'master: ["99:42", "100:43"]\ndisablePrivate: false\n',
    async ({ ws, milky, onebot, sendOneBot, sendMilky }) => {
      const groupEvent = {
        message_type: "group", sub_type: "normal", group_id: 701, user_id: 44, sender: { user_id: 44, role: "owner" },
      };
      for (const role of ["member", "admin"] as const) {
        sendOneBot(role === "admin" ? "#改群名称春日 会场" : "#改群名称越权测试", groupEvent);
        for (let i = 0; i < 2; ++i) {
          const member = await onebot.next("get_group_member_info");
          expect(member.params).toEqual({ group_id: 701, user_id: expect.any(Number), no_cache: true });
          member.respond({ group_id: 701, user_id: member.params.user_id, role: member.params.user_id === 44 ? role : "admin" });
        }
        if (role === "admin") {
          const write = await onebot.next("set_group_name");
          expect(write.params).toEqual({ group_id: 701, group_name: "春日 会场" });
          ws.send(JSON.stringify({ echo: write.echo, status: "ok", retcode: 1, data: null }));
        }
        const reply = await onebot.next("send_msg");
        expect(reply.params).toMatchObject({ group_id: 701, message: role === "member"
          ? "当前账号或操作者没有修改该群名称的权限。" : "群名称修改结果未确认，请先查看群信息。" });
        reply.respond({ message_id: 102 });
      }
      sendOneBot("#改群名片");
      const cardCheck = await onebot.next("send_msg");
      expect(cardCheck.params).toMatchObject({ user_id: 42, message: "❎ 群号不能为空" });
      cardCheck.respond({ message_id: 103 });

      sendOneBot("#改群名片测试名片", { ...groupEvent, group_id: 703 });
      await Bun.sleep(60);
      expect(onebot.calls).toEqual([]);

      for (const [alias, name] of [["#改群昵称", "夏日 会场"], ["#改群名字", "冬日 会场"]]) {
        await sendMilky(`${alias} 702 ${name}`);
        const who = await milky.next("get_group_member_info");
        expect(who.params).toEqual({ group_id: 702, user_id: 100, no_cache: true });
        who.respond({ member: { group_id: 702, user_id: 100, role: "owner" } });
        const write = await milky.next("set_group_name");
        expect(write.params).toEqual({ group_id: 702, new_group_name: name });
        write.respond({});
        const reply = await milky.next("send_private_message");
        expect(reply.params).toMatchObject({ user_id: 43, message: [{ data: { text: "✅ 群昵称修改成功" } }] });
        reply.respond({ message_seq: 104 });
      }

      await sendMilky("#改群名 702 他人会话", { sender_id: 42, peer_id: 42 });
      await Bun.sleep(60);
      expect(onebot.calls).toEqual([]);
      expect(milky.calls).toEqual([]);
    }, 4_000, undefined, async root => {
      await cp(new URL("../plugins/group", import.meta.url), join(root, "plugins/group"), {
        recursive: true, filter: source => basename(source) !== ".git" && basename(source) !== "node_modules",
      });
      await writeFile(join(root, "config/group.yaml"), 'default: { groupCD: 0, singleCD: 0 }\n703: { disable: ["[group] 群名片"] }\n');
    });
}, 13_000);

test("私聊群改名在查询期间失去主人权限即停止，且不能跨群或重试未知提交", async () => {
  let master = true;
  let writes = 0;
  const requested = Promise.withResolvers<void>();
  const role = Promise.withResolvers<"admin">();
  const privateRename = bindGroupName({
    bot: 99, actor: 42, signal: new AbortController().signal, isMaster: () => master, groupAllowed: group => group === 701,
    async role() { requested.resolve(); return role.promise; },
    async write() { writes++; return "confirmed"; },
  });
  expect(await privateRename("无授权的群", 702)).toBe("unavailable");
  const changing = privateRename("已撤权", 701);
  await requested.promise;
  master = false;
  role.resolve("admin");
  expect(await changing).toBe("unavailable");
  expect(writes).toBe(0);

  const inGroup = bindGroupName({
    bot: 99, actor: 42, group: 701, signal: new AbortController().signal, isMaster: () => false, groupAllowed: () => true,
    async role() { return "admin"; },
    async write() { writes++; throw new Error("transport failed after submission"); },
  });
  expect(await inGroup("跨群", 702)).toBe("rejected");
  expect(await inGroup("新名称")).toBe("unknown");
  expect(writes).toBe(1);
});
