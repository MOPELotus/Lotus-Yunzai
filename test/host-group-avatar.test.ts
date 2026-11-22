import { expect, test } from "bun:test";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII=";
const imageUrl = "https://gchat.qpic.cn/download?fixture=group-avatar";
const inline = "base64://" + png;
const text = (text: string) => ({ type: "text", data: { text } });
const image = (temp_url: string) => ({ type: "image", data: { temp_url } });
const offline = `
  const fetchLocal = globalThis.fetch;
  globalThis.fetch = (input, options) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname === "127.0.0.1" && url.pathname !== "/a.png") return fetchLocal(input, options);
    if (url.pathname === "/a.png") {
      return Promise.resolve(new Response(Buffer.from(${JSON.stringify(png)}, "base64"), { headers: { "content-type": "image/png" } }));
    }
    if (url.href !== ${JSON.stringify(imageUrl)} || options.redirect !== "error") throw Error("unexpected network read");
    return Promise.resolve(new Response(Buffer.from(${JSON.stringify(png)}, "base64"), { headers: { "content-type": "image/png" } }));
  };
`;

test("群头像仅用原会话栅格字节，NapCat 与 Milky 都复核权限并只写一次", async () => {
  await withDualGatewayFixture("group-avatar-fixture", 'master: ["99:42", "100:43"]\ndisablePrivate: false\n',
    async ({ onebot, milky, sendOneBot, sendMilky }) => {
      async function roles() {
        for (let i = 0; i < 2; i++) {
          const call = await onebot.next("get_group_member_info");
          expect(call.params).toMatchObject({ group_id: 701, no_cache: true });
          call.respond({ ...call.params, role: "admin" });
        }
      }
      async function milkyRole(group_id: number, role = "owner") {
        const call = await milky.next("get_group_member_info");
        expect(call.params).toEqual({ group_id, user_id: 100, no_cache: true });
        call.respond({ member: { group_id, user_id: 100, role } });
      }
      async function privateReply(expected: string, id: number) {
        const response = await milky.next("send_private_message");
        expect(response.params).toMatchObject({ user_id: 43, message: [{ data: { text: expected } }] });
        response.respond({ message_seq: id });
      }

      sendOneBot("#改群头像", {
        message_type: "group", sub_type: "normal", group_id: 701, user_id: 44,
        message: [text("#改群头像"), { type: "image", data: { url: imageUrl } }],
      });
      await roles();
      (await onebot.next("get_version_info")).respond({ app_name: "NapCat.Onebot" });
      await roles();
      const portrait = await onebot.next("set_group_portrait");
      expect(portrait.params).toEqual({ group_id: "701", file: inline });
      portrait.respond({ result: 1, errMsg: "synthetic failure" });
      const failed = await onebot.next("send_msg");
      expect(failed.params).toMatchObject({ group_id: 701, message: "❎ 群头像修改失败" });
      failed.respond({ message_id: 80 });

      sendOneBot("#换群头像", {
        message_type: "group", sub_type: "normal", group_id: 701, user_id: 44,
        message: [text("#换群头像"), { type: "image", data: { url: imageUrl } }],
      });
      await roles();
      (await onebot.next("get_version_info")).respond({ app_name: "other implementation" });
      const unsupported = await onebot.next("send_msg");
      expect(unsupported.params).toMatchObject({ group_id: 701, message: "当前协议端未确认支持修改群头像。" });
      unsupported.respond({ message_id: 86 });

      await sendMilky("#换群头像702");
      await milkyRole(702);
      await privateReply("⚠ 请发送图片", 81);
      await sendMilky("", { sender_id: 42, peer_id: 42, segments: [image(imageUrl)] });
      await Bun.sleep(50);
      expect(milky.calls).toEqual([]);
      await sendMilky("", { segments: [image(imageUrl)] });
      await milkyRole(702);
      await milkyRole(702);
      const avatar = await milky.next("set_group_avatar");
      expect(avatar.params).toEqual({ group_id: 702, image_uri: inline });
      avatar.respond({});
      await privateReply("✅ 群头像修改成功", 82);

      await sendMilky("#改群头像703", { segments: [text("#改群头像703"), image("http://127.0.0.1/a.png")] });
      await milkyRole(703);
      await privateReply("无法读取这张图片，或图片尺寸过大。请重新发送命令。", 83);

      await sendMilky("#换群头像704");
      await milkyRole(704);
      await privateReply("⚠ 请发送图片", 84);
      await sendMilky("#取消换群头像");
      await privateReply("✅ 已取消", 85);
      await sendMilky("", { segments: [image(imageUrl)] });
      await Bun.sleep(50);
      expect(onebot.calls).toEqual([]);
      expect(milky.calls).toEqual([]);

      const quoted = { type: "reply", data: { message_seq: 72 } };
      await sendMilky("#改群头像705", { segments: [quoted, text("#改群头像705")] });
      await milkyRole(705);
      const otherPeer = await milky.next("get_message");
      expect(otherPeer.params).toEqual({ message_scene: "friend", peer_id: 43, message_seq: 72 });
      otherPeer.respond({ message: {
        message_scene: "friend", peer_id: 42, sender_id: 42, message_seq: 72, segments: [image(imageUrl)],
      } });
      await privateReply("无法读取当前会话的引用消息。", 87);

      await sendMilky("#换群头像705", { segments: [quoted, text("#换群头像705")] });
      await milkyRole(705);
      (await milky.next("get_message")).respond({ message: {
        message_scene: "friend", peer_id: 43, sender_id: 43, message_seq: 72, segments: [image(imageUrl)],
      } });
      await milkyRole(705, "member");
      await privateReply("当前账号或操作者没有修改该群头像的权限。", 88);
      expect(milky.calls).toEqual([]);
    }, 4_000, offline);
}, 15_000);
