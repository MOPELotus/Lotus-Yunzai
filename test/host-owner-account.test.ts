import { expect, test } from "bun:test";
import { bindOwnerAccount } from "../lib/adapters/owner-account.ts";
import { OneBotCalls, type OneBotAction } from "../lib/adapters/onebot-calls.ts";
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

    sendOneBot("#设置机型示例机型");
    await oneReply("当前协议端未确认支持修改机型显示。");
    await sendMilky("#设置机型");
    await milkyReply("当前协议端未确认支持修改机型显示。");

    sendOneBot("#换名称新名字", { ...group, message_id: 901 });
    await oneVersion();
    const nickname = await onebot.next("set_qq_profile");
    expect(nickname.params).toEqual({ nickname: "新名字" });
    nickname.respond({ result: 0, errMsg: "" });
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
    deletion.respond({ valid: false, message: "已不是好友" });
    await oneReply("删除好友失败。", 701);

    sendOneBot("#删好友112");
    await oneVersion();
    await oneFriends([42, 112]);
    (await onebot.next("delete_friend")).respond(undefined);
    await oneReply("删除好友结果未确认，请在 QQ 中核对。");
    sendOneBot("#删好友113");
    await oneVersion();
    await oneFriends([42, 113]);
    (await onebot.next("delete_friend")).respond({ result: 0, errMsg: "" });
    await oneReply("删除好友成功。");

    sendOneBot("#改状态九成睡着");
    await oneReply("可选在线状态为我在线上、离开、隐身、忙碌、Q我吧、请勿打扰。");
    sendOneBot("#改状态请勿打扰");
    await oneVersion();
    await oneFriends([42]);
    const state = await onebot.next("set_online_status");
    expect(state.params).toEqual({ status: 70, ext_status: 0, battery_status: 0 });
    state.respond(null);
    await oneReply("修改在线状态成功。");

    await sendMilky("#改状态隐身");
    await milkyReply("当前协议端未确认支持修改在线状态。");
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

test("修改性别只接受旧命令选项并保留当前同账号昵称", async () => {
  const config = 'master: ["99:42", "100:43"]\ndisablePrivate: false\n';
  await withDualGatewayFixture("owner-gender-fixture", config, async ({ onebot, milky, sendOneBot, sendMilky }) => {
    const group = { message_type: "group", sub_type: "normal", group_id: 701 };
    async function oneReply(message: string) {
      const reply = await onebot.next("send_msg");
      expect(reply.params).toMatchObject({ message });
      reply.respond({ message_id: 801 });
    }
    async function napcatProfile(data: unknown) {
      (await onebot.next("get_version_info")).respond({ app_name: "NapCat.Onebot" });
      const lookup = await onebot.next("get_stranger_info");
      expect(lookup.params).toEqual({ user_id: "99", no_cache: true });
      lookup.respond(data);
    }

    sendOneBot("#改性别 男", { ...group, user_id: 43, sender: { user_id: 43, role: "owner" } });
    await oneReply("只有当前机器人的主人可在群聊或好友私聊使用此功能。");
    sendOneBot("#改性别 0", group);
    await oneReply("可选性别为男、女、无。");

    const nickname = "原昵称 ";
    for (const [label, sex, data, verdict] of [
      ["无", "0", { result: 0 }, "修改性别成功。"],
      ["男", "1", { result: 1 }, "修改性别失败。"],
      ["女", "2", {}, "修改性别结果未确认，请在 QQ 中核对。"],
    ] as const) {
      sendOneBot("#改性别 " + label, group);
      await napcatProfile({ user_id: 99, nickname });
      const write = await onebot.next("set_qq_profile");
      expect(write.params).toEqual({ nickname, sex });
      write.respond(data);
      await oneReply(verdict);
    }
    sendOneBot("#改性别无", group);
    await napcatProfile({ user_id: 100, nickname });
    await oneReply("无法确认当前会话的权限或好友关系。");

    await sendMilky("#改性别无");
    const unsupported = await milky.next("send_private_message");
    expect(unsupported.params).toMatchObject({ user_id: 43, message: [{ data: { text: "当前协议端未确认支持修改性别。" } }] });
    unsupported.respond({ message_seq: 802 });
    expect(onebot.calls).toEqual([]);
    expect(milky.calls).toEqual([]);
  });
}, 10_000);

test("同一 OneBot 会话先提交昵称，再读新昵称写性别，资料读取后撤权不提交", async () => {
  const calls = new OneBotCalls();
  const frames: OneBotAction[] = [];
  const send = (frame: OneBotAction) => { frames.push(frame); return true; };
  const signal = new AbortController().signal;
  let canWrite = true;
  const current = () => canWrite;
  const confirm = (index: number, data: unknown) => calls.receive({ echo: frames[index]!.echo, status: "ok", retcode: 0, data });

  const rename = calls.updateOwnerAccount(send, 99, { kind: "nickname", text: "新昵称" }, signal, current);
  const gender = calls.updateOwnerAccount(send, 99, { kind: "gender", gender: 2 }, signal, current);
  await Bun.sleep(0);
  expect(frames).toHaveLength(1);
  expect(frames[0]).toMatchObject({ action: "set_qq_profile", params: { nickname: "新昵称" } });
  confirm(0, { result: 0 });
  expect(await rename).toBe("confirmed");
  await Bun.sleep(0);
  expect(frames[1]).toMatchObject({ action: "get_stranger_info", params: { user_id: "99", no_cache: true } });
  confirm(1, { user_id: 99, nickname: "新昵称" });
  await Bun.sleep(0);
  expect(frames[2]).toMatchObject({ action: "set_qq_profile", params: { nickname: "新昵称", sex: "2" } });
  confirm(2, { result: 0 });
  expect(await gender).toBe("confirmed");

  const revoked = calls.updateOwnerAccount(send, 99, { kind: "gender", gender: 1 }, signal, current);
  await Bun.sleep(0);
  expect(frames[3]?.action).toBe("get_stranger_info");
  canWrite = false;
  confirm(3, { user_id: 99, nickname: "新昵称" });
  expect(await revoked).toBe("unavailable");
  expect(frames).toHaveLength(4);
});

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
