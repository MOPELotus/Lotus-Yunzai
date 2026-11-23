import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

test("OneBot 与 Milky 的设备绑定先提示 JSON，附件缺失或拒绝再给明确提示", async () => {
  const command = "#绑定设备2";
  const source = "synthetic APK attachment bytes";
  const profiles = "data/users";
  const apkName = "copy_device_info_1.2.apk";
  const stored = `data/passport/resources/apk/${apkName}`;
  const hint = "可继续发送设备 JSON，或联系机器人主人获取设备信息工具。";
  await withDualGatewayFixture("device-apk-fixture", 'master: ["99:42", "100:43"]\n',
    async ({ root, onebot, milky, sendOneBot, sendMilky }) => {
      sendOneBot(command);
      const prompt = await onebot.next("send_msg");
      expect(prompt.params).toMatchObject({ user_id: 42, message: expect.stringContaining("请发送 profile 2 的设备 JSON") });
      prompt.respond({ message_id: 1 });
      const unavailable = await onebot.next("send_msg");
      expect(unavailable.params).toMatchObject({ user_id: 42, message: "设备信息工具文件暂不可用。" + hint });
      unavailable.respond({ message_id: 2 });

      const path = join(root, stored);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, source);
      sendOneBot("#绑定设备信息2");
      (await onebot.next("send_msg")).respond({ message_id: 3 });
      const file = await onebot.next("upload_private_file");
      expect(file.params).toMatchObject({ user_id: 42, name: apkName, file: `base64://${Buffer.from(source).toString("base64")}` });
      file.respond(null, "failed");
      const onebotRejected = await onebot.next("send_msg");
      expect(onebotRejected.params).toMatchObject({ user_id: 42, message: "设备信息工具未能发送。" + hint });
      onebotRejected.respond({ message_id: 4 });

      await sendMilky(command);
      const milkyPrompt = await milky.next("send_private_message");
      expect(JSON.stringify(milkyPrompt.params.message)).toContain("请发送 profile 2 的设备 JSON");
      milkyPrompt.respond({ message_seq: 5 });
      const attached = await milky.next("upload_private_file");
      expect(attached.params).toMatchObject({ user_id: 43, file_name: apkName, file_uri: `base64://${Buffer.from(source).toString("base64")}` });
      attached.respond(null, "failed");
      const milkyRejected = await milky.next("send_private_message");
      expect(milkyRejected.params).toMatchObject({ user_id: 43, message: [{ data: { text: "设备信息工具未能发送。" + hint } }] });
      milkyRejected.respond({ message_seq: 6 });

      await sendMilky("#绑定设备信息2");
      (await milky.next("send_private_message")).respond({ message_seq: 7 });
      (await milky.next("upload_private_file")).respond({});
      await sendMilky("#取消绑定设备2");
      const cancelled = await milky.next("send_private_message");
      expect(cancelled.params).toMatchObject({ user_id: 43, message: [{ data: { text: "已取消绑定设备。" } }] });
      cancelled.respond({ message_seq: 8 });

      sendOneBot("#星铁绑定设备2");
      (await onebot.next("send_msg")).respond({ message_id: 9 });
      (await onebot.next("upload_private_file")).respond({ file_id: "fixture-device-file" });
      sendOneBot("#取消绑定设备2");
      const onebotCancelled = await onebot.next("send_msg");
      expect(onebotCancelled.params).toMatchObject({ user_id: 42, message: "已取消绑定设备。" });
      onebotCancelled.respond({ message_id: 10 });
      expect(milky.calls).toEqual([]);
      expect(onebot.calls).toEqual([]);
    }, 4_000, undefined, async root => {
      await mkdir(join(root, profiles), { recursive: true });
      await writeFile(join(root, ".env"), `LOTUS_PROFILE_DIR=${join(root, profiles)}\n`);
      for (const qq of [42, 43]) {
        await writeFile(join(root, profiles, `${qq}-2.yaml`),
          'account: { cookie: "fixture-cookie", stoken: "fixture-stoken" }\n');
      }
    });
}, 15_000);
