import { expect, test } from "bun:test";
import { bindOwnerAccount } from "../lib/adapters/owner-account.ts";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

test("机器人资料和删好友走当前主人所属的隔离协议账号", async () => {
  const config = 'master: ["99:42", "100:43"]\ndisablePrivate: false\n';
  await withDualGatewayFixture("owner-account-fixture", config, async ({ onebot, milky, sendOneBot, sendMilky }) => {
    const group = { message_type: "group", sub_type: "normal", group_id: 701 };
    async function oneReply(message: string, groupId?: number) {
      const reply = await onebot.next("send_msg");
      expect(reply.params).toMatchObject({ ...groupId ? { group_id: groupId } : { user_id: 42 }, message });
      reply.respond({ message_id: 801 });
    }
    async function milkyReply(text: string) {
      const reply = await milky.next("send_private_message");
      expect(reply.params).toMatchObject({ user_id: 43, message: [{ data: { text } }] });
      reply.respond({ message_seq: 802 });
    }
    const oneVersion = async () => (await onebot.next("get_version_info")).respond({ app_name: "NapCat.Onebot" });
    const oneFriends = async (ids: number[]) => (await onebot.next("get_friend_list")).respond(ids.map(user_id => ({ user_id })));
    const milkyVersion = async (milky_version: string) => (await milky.next("get_impl_info")).respond({ milky_version });
    const milkyFriends = async (ids: number[]) => {
      const read = await milky.next("get_friend_list");
      expect(read.params).toEqual({ no_cache: true });
      read.respond({ friends: ids.map(user_id => ({ user_id })) });
    };

    sendOneBot("#改昵称假主人", { ...group, user_id: 43, sender: { user_id: 43, role: "owner" } });
    await oneReply("只有当前机器人的主人可在群聊或好友私聊使用此功能。", 701);

    sendOneBot("#换名称新名字", { ...group, message_id: 901 });
    await oneVersion();
    const nickname = await onebot.next("set_qq_profile");
    expect(nickname.params).toEqual({ nickname: "新名字" });
    nickname.respond({});
    await oneReply("修改昵称成功。", 701);
    sendOneBot("#换名称新名字", { ...group, message_id: 901 });
    await Bun.sleep(60);
    expect(onebot.calls).toEqual([]);

    sendOneBot("#删好友1234");
    await oneVersion();
    await oneFriends([42, 111]);
    await oneReply("当前机器人的好友列表中没有这个 QQ 号。");
    sendOneBot("#删好友", { ...group, message: [
      { type: "text", data: { text: "#删好友" } }, { type: "at", data: { qq: "111" } },
    ] });
    await oneVersion();
    await oneFriends([42, 111]);
    const deletion = await onebot.next("delete_friend");
    expect(deletion.params).toEqual({ user_id: 111 });
    deletion.respond(null, "failed");
    await oneReply("删除好友失败。", 701);

    await sendMilky("#改签名旧版不可用");
    await milkyVersion("1.0.0");
    await milkyReply("当前协议端未确认支持修改签名。");
    await sendMilky("#改签名");
    await milkyVersion("1.3");
    await milkyFriends([43, 112]);
    const signature = await milky.next("set_bio");
    expect(signature.params).toEqual({ new_bio: "" });
    signature.respond({});
    await milkyReply("修改签名成功。");

    await sendMilky("#删好友112");
    await milkyVersion("1.3");
    await milkyFriends([43, 112]);
    const deleteMilky = await milky.next("delete_friend");
    expect(deleteMilky.params).toEqual({ user_id: 112 });
    deleteMilky.respond({});
    await milkyReply("删除好友成功。");
    expect(onebot.calls).toEqual([]);
    expect(milky.calls).toEqual([]);
  });
}, 10_000);

test("好友查询等待期间撤销当前主人或会话时禁止发送资料写入", async () => {
  for (const revoke of ["owner", "connection"] as const) {
    let owner = true;
    let writes = 0;
    const connection = new AbortController();
    const scope = bindOwnerAccount({
      signal: connection.signal, actor: 42, privateChat: true, isOwner: () => owner,
      supported: async () => true,
      async friends() {
        if (revoke === "owner") owner = false;
        else connection.abort();
        return new Set([42, 43]);
      },
      async write() { writes++; return "confirmed"; },
    });
    expect(await scope.perform({ kind: "deleteFriend", userId: 43 }, new AbortController().signal, () => true)).toBe("unavailable");
    expect(writes).toBe(0);
  }
});
