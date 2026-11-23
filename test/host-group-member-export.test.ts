import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const memberRows = (groupId: number, bot: number, user: number) => [
  { group_id: groupId, user_id: bot, card: "本机机器人", role: "admin", nickname: "机器人", sex: "male" },
  { group_id: groupId, user_id: user, card: '会场,"群主"', role: "owner", sex: "female", title: "值班" },
  { group_id: groupId, user_id: 44, nickname: " =公式", role: "member", special_title: "会场" },
];

function csv(input: unknown) {
  expect(typeof input).toBe("string");
  const uri = String(input);
  expect(uri.startsWith("base64://")).toBe(true);
  return Buffer.from(uri.slice("base64://".length), "base64").toString("utf8");
}

test("旧群成员命令经两协议查完整群成员，按原会话送 CSV 并解释不确定回执", async () => {
  await withDualGatewayFixture("member-export-fixture", 'master: ["99:42", "100:43"]\ndisablePrivate: false\n',
    async ({ onebot, milky, sendOneBot, sendMilky }) => {
      const group = { message_type: "group", sub_type: "normal", group_id: 701 };
      sendOneBot("#群成员", { ...group, user_id: 44, sender: { role: "owner" } });
      const denied = await onebot.next("send_msg");
      expect(denied.params).toMatchObject({ group_id: 701, message: "当前会话没有群成员导出权限。" });
      denied.respond({ message_id: 1 });

      sendOneBot("#群成员702", group);
      const wrongGroup = await onebot.next("send_msg");
      expect(wrongGroup.params).toMatchObject({ group_id: 701, message: "请在目标群发送 #群成员，或在好友私聊中指定群号。" });
      wrongGroup.respond({ message_id: 2 });

      sendOneBot("#群成员", group);
      const info = await onebot.next("get_group_info");
      expect(info.params).toEqual({ group_id: 701, no_cache: true });
      info.respond({ group_id: 701, member_count: 3 });
      const list = await onebot.next("get_group_member_list");
      expect(list.params).toEqual({ group_id: 701, no_cache: true });
      list.respond(memberRows(701, 99, 42));
      (await onebot.next("get_group_info")).respond({ group_id: 701, member_count: 3 });
      const upload = await onebot.next("upload_group_file");
      expect(upload.params).toMatchObject({ group_id: 701, name: "701.csv" });
      expect(csv(upload.params.file)).toBe("\ufeffQQ号,昵称/群名片,性别,头衔,是否管理员,是否群主\r\n99,本机机器人,男,无,是,否\r\n42,\"会场,\"\"群主\"\"\",女,值班,否,是\r\n44,' =公式,未知,会场,否,否");
      upload.respond({ file_id: "isolated-file" });
      const done = await onebot.next("send_msg");
      expect(done.params.group_id).toBe(701);
      expect(done.params.message).toEqual([expect.objectContaining({ type: "image" })]);
      done.respond({ message_id: 3 });

      await sendMilky("#群成员 702");
      (await milky.next("get_group_info")).respond({ group: { group_id: 702, member_count: 3 } });
      const milkyList = await milky.next("get_group_member_list");
      expect(milkyList.params).toEqual({ group_id: 702, no_cache: true });
      milkyList.respond({ members: memberRows(702, 100, 43) });
      (await milky.next("get_group_info")).respond({ group: { group_id: 702, member_count: 3 } });
      const milkyUpload = await milky.next("upload_private_file");
      expect(milkyUpload.params).toMatchObject({ user_id: 43, file_name: "702.csv" });
      expect(csv(milkyUpload.params.file_uri)).toContain("43,\"会场,\"\"群主\"\"\",女,值班,否,是");
      milkyUpload.respond({});
      const unknown = await milky.next("send_private_message");
      expect(unknown.params).toMatchObject({ user_id: 43, message: [{ data: { text: "群成员 CSV 发送结果未确认，请在当前会话核对。" } }] });
      unknown.respond({ message_seq: 4 });
      await Bun.sleep(60);
      expect(onebot.calls).toEqual([]);
      expect(milky.calls).toEqual([]);
    }, 5_000, undefined, async root => {
      await writeFile(join(root, "config/group.yaml"), "default: {groupCD: 0, singleCD: 0}\n");
    });
}, 18_000);

test("非主人须由配置显式放行且为目标群成员，读取途中撤销后不上传", async () => {
  await withDualGatewayFixture("member-export-scope", 'master: ["99:42", "100:43"]\ndisablePrivate: false\n',
    async ({ root, onebot, sendOneBot }) => {
      const settings = join(root, "config/global.yaml");
      async function listing(text: string) {
        sendOneBot(text, { user_id: 44 });
        (await onebot.next("get_group_info")).respond({ group_id: 701, member_count: 3 });
        (await onebot.next("get_group_member_list")).respond(memberRows(701, 99, 42));
        return onebot.next("get_group_info");
      }

      (await listing("#群成员 701")).respond({ group_id: 701, member_count: 3 });
      const allowed = await onebot.next("upload_private_file");
      expect(allowed.params).toMatchObject({ user_id: 44, name: "701.csv" });
      allowed.respond(null, "failed");
      (await onebot.next("send_msg")).respond({ message_id: 1 });

      const count = await listing("#群成员701");
      await writeFile(settings, "permissions: {users: {deny: [44]}, scopes: {group.members.export: {policy: allow}}}\n");
      count.respond({ group_id: 701, member_count: 3 });
      const revoked = await onebot.next("send_msg");
      expect(revoked.params).toMatchObject({ user_id: 44, message: "当前会话没有群成员导出权限。" });
      revoked.respond({ message_id: 2 });
      expect(onebot.calls).toEqual([]);
    }, 5_000, undefined, async root => {
      await writeFile(join(root, "config/global.yaml"), "permissions: {scopes: {group.members.export: {policy: allow}}}\n");
    });
}, 15_000);
