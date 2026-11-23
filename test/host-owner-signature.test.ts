import { expect, test } from "bun:test";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

test("NapCat 个性签名按自身内层回执断定成功失败，超时不会重发", async () => {
  await withDualGatewayFixture("owner-signature-fixture", 'master: ["99:42"]\n', async ({ onebot, sendOneBot }) => {
    async function submit(signature: string) {
      sendOneBot("#改签名" + signature);
      (await onebot.next("get_version_info")).respond({ app_name: "NapCat.Onebot", app_version: "4.9.2" });
      (await onebot.next("get_friend_list")).respond([{ user_id: 42 }]);
      const request = await onebot.next("set_self_longnick");
      expect(request.params).toEqual({ longNick: signature });
      return request;
    }
    async function expectReply(message: string) {
      const reply = await onebot.next("send_msg");
      expect(reply.params).toMatchObject({ user_id: 42, message });
      reply.respond({ message_id: 103 });
    }
    const confirmed = await submit("试用签名");
    confirmed.respond({ result: 0, errMsg: "" });
    await expectReply("修改签名成功。");

    const rejected = await submit("测试内层拒绝");
    rejected.respond({ result: 11, errMsg: "合成拒绝" });
    await expectReply("修改签名失败。");

    const unconfirmed = await submit("测试空回执");
    unconfirmed.respond({});
    await expectReply("修改签名结果未确认，请在 QQ 中核对。");

    const arrivedTooLate = await submit("");
    await expectReply("修改签名结果未确认，请在 QQ 中核对。");
    arrivedTooLate.respond({ result: 0, errMsg: "" });
    await Bun.sleep(50);
    expect(onebot.calls).toEqual([]);
  }, 6_200);
}, 10_000);
