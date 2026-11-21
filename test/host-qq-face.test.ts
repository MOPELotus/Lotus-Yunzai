import { expect, test } from "bun:test";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const text = (text: string) => ({ type: "text", data: { text } });

test("取face 只读当前表情，双协议保留原生动作、首个编号与命令收到的描述", async () => {
  await withDualGatewayFixture("qq-face-fixture", "disablePrivate: false\n",
    async ({ milky, onebot, sendOneBot, sendMilky }) => {
      const oneFace = (id: number | string, data = {}) => ({ type: "face", data: { id, ...data } });
      const obGroup = { message_type: "group", sub_type: "normal", group_id: 707 };

      sendOneBot("#取face", { message: [text("#取face"), oneFace(0, { text: "网关说明" })] });
      expect((await onebot.next("send_msg")).params).toMatchObject({ user_id: 42, message: [
        text("表情："), { type: "face", data: { id: "0" } }, text("\nid：0\n描述：网关说明"),
      ] });

      sendOneBot("#取face", { ...obGroup, message: [
        text("#取face"),
        oneFace("123", { text: "原始描述", is_large: 1 }),
        oneFace(123, { text: "重复描述" }),
        { type: "mface", data: { id: "999", url: "https://invalid.example/sticker" } },
        oneFace(63, { is_large: false }),
      ] });
      const forward = await onebot.next("send_group_forward_msg");
      expect(forward.params).toMatchObject({ group_id: 707, messages: [
        { data: { content: [text("表情："), { type: "face", data: { id: "123", is_large: "1" } }, text("\nid：123\n描述：原始描述")] } },
        { data: { content: [text("表情："), { type: "face", data: { id: "63", is_large: "0" } }, text("\nid：63\n描述：未提供")] } },
      ] });
      expect(JSON.stringify(forward.params)).not.toContain("invalid.example");
      forward.respond({ message_id: -55 });

      sendOneBot("#取face", { message: [{ type: "reply", data: { id: 908 } }, text("#取face 引用")] });
      const missingOne = await onebot.next("send_msg");
      expect(missingOne.params).toMatchObject({ user_id: 42, message: [
        { type: "reply" }, text("❎ 表情参数不可为空"),
      ] });

      await sendMilky("#取face", { segments: [
        { type: "reply", data: { message_seq: 809 } },
        { type: "face_incoming", data: { face_id: 64, is_large: true, text: "不可核说明" } },
        text("#取face"),
      ] });
      const single = await milky.next("send_private_message");
      expect(single.params).toEqual({ user_id: 43, message: [
        text("表情："), { type: "face", data: { face_id: "64", is_large: true } }, text("\nid：64\n描述：未提供"),
      ] });
      single.respond({ message_seq: 210 });

      await sendMilky("#取face", { message_scene: "group", peer_id: 801, segments: [
        text("#取face"),
        { type: "face", data: { face_id: "67", is_large: false } },
        { type: "face_incoming", data: { face_id: 67, is_large: true } },
        { type: "market_face", data: { emoji_id: 9000 } },
        { type: "face_incoming", data: { face_id: 68, is_large: true } },
      ] });
      const mixed = await milky.next("send_group_message");
      expect(mixed.params).toMatchObject({ group_id: 801, message: [{ type: "forward", data: { messages: [
        { segments: [text("表情："), { type: "face", data: { face_id: "67", is_large: false } }, text("\nid：67\n描述：未提供")] },
        { segments: [text("表情："), { type: "face", data: { face_id: "68", is_large: true } }, text("\nid：68\n描述：未提供")] },
      ] } }] });
      mixed.respond({ message_seq: 211 });

      await sendMilky("#取face", { segments: [
        { type: "reply", data: { message_seq: 808 } },
        { type: "market_face", data: { emoji_id: 9000 } },
        text("#取face 引用"),
      ] });
      const missingMilky = await milky.next("send_private_message");
      expect(missingMilky.params).toMatchObject({ user_id: 43,
        message: [{ type: "reply" }, text("❎ 表情参数不可为空")],
      });
      missingMilky.respond({ message_seq: 212 });

      sendOneBot("#取Face");
      sendOneBot("取face");
      sendOneBot("#取face", { self_id: 100 });
      await sendMilky("#取face 其他", { peer_id: 42 });
      await Bun.sleep(80);
      expect(onebot.calls).toEqual([]);
      expect(milky.calls).toEqual([]);
    });
}, 9_000);
