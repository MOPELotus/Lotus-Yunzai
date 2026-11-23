import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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


test("旧设备别名进入实际私聊，取消能阻止等待 SQLite 锁的绑定提交", async () => {
  const device = { bound: true, id: "fixture-original-device", fp: "0123456789abc", android_version: "13" };
  const original = Bun.YAML.stringify({ device, account: {
    stuid: "77", cookie: "ltuid=77;cookie_token=fixture", stoken: "fixture-stoken",
  } });
  await withDualGatewayFixture("device-active-cancel", "disablePrivate: false\n",
    async ({ root, onebot, milky, sendOneBot, sendMilky }) => {
      sendOneBot("/绝区零绑定设备2");
      const prompt = await onebot.next("send_msg");
      expect(prompt.params.message).toContain("profile 2 的设备 JSON");
      prompt.respond({ message_id: 21 });
      const apk = await onebot.next("send_msg");
      expect(apk.params.message).toContain("设备信息工具文件暂不可用");
      apk.respond({ message_id: 22 });
      sendOneBot("#绝区零zzz设备信息3");
      const viewer = await onebot.next("send_msg");
      expect(viewer.params.message).toBe("[account] 请先扫码登录 profile 3。");
      viewer.respond({ message_id: 24 });

      const directory = join(root, "data/users");
      const lock = new Database(join(directory, ".43-2.yaml.lotus-profile.sqlite"));
      lock.exec("BEGIN IMMEDIATE");
      try {
        const payload = JSON.stringify({ device_id: "fixture-replacement", device_fp: "dc00112233445" });
        expect((await sendMilky("#绝区零zzz绑定设备2 设备信息：" + payload)).status).toBe(200);
        const waiting = async () => (await readdir(directory)).some(name => name.startsWith(".profile-write-"));
        for (let attempt = 0; attempt < 60 && !await waiting(); attempt++) await Bun.sleep(10);
        expect(await waiting()).toBe(true);
        expect((await sendMilky("#取消绑定设备2")).status).toBe(200);
        const stopped = await milky.next("send_private_message");
        expect(stopped.params.message).toEqual([{ type: "text", data: { text: "已取消绑定设备。" } }]);
        stopped.respond({ message_seq: 23 });
        lock.exec("ROLLBACK");
        for (let attempt = 0; attempt < 60 && await waiting(); attempt++) await Bun.sleep(10);
        expect(await waiting()).toBe(false);
        expect(await readFile(join(directory, "43-2.yaml"), "utf8")).toBe(original);
        expect(milky.calls).toHaveLength(0);
        expect((await sendMilky("*绑定设备2 " + payload)).status).toBe(200);
        const bound = await milky.next("send_private_message");
        expect(bound.params.user_id).toBe(43);
        bound.respond({ message_seq: 25 });
        expect(Bun.YAML.parse(await readFile(join(directory, "43-2.yaml"), "utf8")))
          .toMatchObject({ device: { id: "fixture-replacement", fp: "dc00112233445", bound: true } });
      } finally {
        lock.close();
      }
    }, 3_000, undefined, async root => {
      const profiles = join(root, "data/users");
      await mkdir(profiles, { recursive: true });
      await writeFile(join(root, ".env"), `LOTUS_PROFILE_DIR=${profiles}\n`);
      for (const qq of [42, 43]) await writeFile(join(profiles, qq + "-2.yaml"), original);
    });
}, 12_000);
