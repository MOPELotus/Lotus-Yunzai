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
  const stored = `resources/device-binding/${apkName}`;
  const hint = "可继续发送设备 JSON。需要工具时，可直接下载：";
  await withDualGatewayFixture("device-apk-fixture", 'master: ["99:420", "100:430"]\ndisablePrivate: true\n',
    async ({ root, onebot, milky, sendOneBot, sendMilky }) => {
      sendOneBot(command);
      const prompt = await onebot.next("send_msg");
      expect(prompt.params).toMatchObject({ user_id: 42, message: expect.stringContaining("请发送档案 2 的设备 JSON") });
      prompt.respond({ message_id: 1 });
      const unavailable = await onebot.next("send_msg");
      expect(unavailable.params.user_id).toBe(42);
      expect(unavailable.params.message).toContain("设备信息工具文件暂不可用。" + hint);
      expect(unavailable.params.message).toContain("/resources/apk/" + apkName);
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
      expect(onebotRejected.params).toMatchObject({ user_id: 42, message: expect.stringContaining("设备信息工具未能发送。" + hint) });
      onebotRejected.respond({ message_id: 4 });

      await sendMilky(command);
      const milkyPrompt = await milky.next("send_private_message");
      expect(JSON.stringify(milkyPrompt.params.message)).toContain("请发送档案 2 的设备 JSON");
      milkyPrompt.respond({ message_seq: 5 });
      const attached = await milky.next("upload_private_file");
      expect(attached.params).toMatchObject({ user_id: 43, file_name: apkName, file_uri: `base64://${Buffer.from(source).toString("base64")}` });
      attached.respond(null, "failed");
      const milkyRejected = await milky.next("send_private_message");
      expect(milkyRejected.params).toMatchObject({ user_id: 43, message: [{ data: { text: expect.stringContaining("设备信息工具未能发送。" + hint) } }] });
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

      const pair = { device_id: "fixture-user-device", device_fp: "0123456789abc" };
      sendOneBot(command + " " + JSON.stringify(pair));
      const saved = await onebot.next("send_msg");
      expect(saved.params.message).toContain("设备已绑定");
      expect(saved.params.message).toContain("请撤回包含设备资料的消息");
      expect(saved.params.message).not.toContain(pair.device_fp);
      saved.respond({ message_id: 11 });
      expect(Bun.YAML.parse(await readFile(join(root, profiles, "42-2.yaml"), "utf8")))
        .toMatchObject({ device: { bound: true, id: pair.device_id, fp: pair.device_fp } });
      expect(milky.calls).toEqual([]);
    }, 4_000, undefined, async root => {
      await mkdir(join(root, profiles), { recursive: true });
      await writeFile(join(root, ".env"), `LOTUS_PROFILE_DIR=${join(root, profiles)}\n`);
      for (const qq of [42, 43]) {
        await writeFile(join(root, profiles, `${qq}-2.yaml`),
          'account: { cookie: "fixture-cookie", stoken: "fixture-stoken" }\ndevice: { id: fixture-existing-device, fp: "0123456789abc", bound: true }\n');
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
      expect(prompt.params.message).toContain("档案 2 的设备 JSON");
      prompt.respond({ message_id: 21 });
      const apk = await onebot.next("send_msg");
      expect(apk.params.message).toContain("设备信息工具文件暂不可用");
      apk.respond({ message_id: 22 });
      sendOneBot("#绝区零zzz设备信息3");
      const viewer = await onebot.next("send_msg");
      expect(viewer.params.message).toBe("请先扫码登录档案 3。");
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
        expect(JSON.stringify(bound.params.message)).toContain("请撤回包含设备资料的消息");
        expect(JSON.stringify(bound.params.message)).not.toContain("dc00112233445");
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




test("OneBot 与 Milky 从 APK 安卓 JSON 申请指纹并绑定原档案，瞬时失败沿用同一设备", async () => {
  const metadata = {
    deviceName: "Fixture Pixel", deviceModel: "Pixel 7", deviceFingerprint: "google/panther/panther:13/TQ1A/fixture:user/release-keys",
    deviceProduct: "panther", deviceBoard: "panther", oaid: "0123456789abcdef0123456789abcdef", osVersion: "13", sdkVersion: "33",
    cookie: "must-not-forward", stoken: "must-not-forward",
  };
  const preload = `
import { appendFileSync } from "node:fs";
const nativeFetch = globalThis.fetch;
const issued = new Set();
globalThis.fetch = Object.assign(async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url === "https://public-data-api.mihoyo.com/device-fp/api/getFp") {
    const body = JSON.parse(String(init.body));
    appendFileSync("getfp.jsonl", JSON.stringify({ body, headers: Object.fromEntries(new Headers(init.headers)) }) + "\\n");
    if (!issued.has(body.device_id)) { issued.add(body.device_id); return new Response(null, { status: 503 }); }
    return Response.json({ retcode: 0, data: { code: 200, device_fp: "a1b2c3d4e5f67" } });
  }
  return nativeFetch(input, init);
}, nativeFetch);
`;
  await withDualGatewayFixture("device-android-issuance", "disablePrivate: false\n",
    async ({ root, onebot, milky, sendOneBot, sendMilky }) => {
      for (const protocol of ["onebot", "milky"] as const) {
        const input = "#绑定设备2 " + JSON.stringify(metadata);
        if (protocol === "onebot") sendOneBot(input);
        else expect((await sendMilky(input)).status).toBe(200);
        const message = protocol === "onebot" ? await onebot.next("send_msg") : await milky.next("send_private_message");
        expect(JSON.stringify(message.params.message)).toContain("设备已绑定");
        expect(JSON.stringify(message.params.message)).not.toContain("a1b2c3d4e5f67");
        message.respond(protocol === "onebot" ? { message_id: 51 } : { message_seq: 52 });
        const saved = Bun.YAML.parse(await readFile(join(root, "data/users", (protocol === "onebot" ? "42" : "43") + "-2.yaml"), "utf8"));
        expect(saved).toMatchObject({ device: { bound: true, fp: "a1b2c3d4e5f67", android_version: "13", model: "Pixel 7" } });
      }
      const requests = (await readFile(join(root, "getfp.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      expect(requests).toHaveLength(4);
      for (let index = 0; index < requests.length; index += 2) {
        expect(requests[index].body).toEqual(requests[index + 1].body);
        expect(requests[index].headers).not.toHaveProperty("cookie");
        expect(JSON.stringify(requests[index])).not.toContain("must-not-forward");
        expect(JSON.parse(requests[index].body.ext_fields)).toMatchObject({ oaid: metadata.oaid, deviceInfo: metadata.deviceFingerprint });
      }
    }, 5_000, preload, async root => {
      const profiles = join(root, "data/users");
      await mkdir(profiles, { recursive: true });
      await writeFile(join(root, ".env"), `LOTUS_PROFILE_DIR=${profiles}\n`);
      for (const qq of [42, 43]) await writeFile(join(profiles, qq + "-2.yaml"),
        'account: { cookie: "fixture-cookie", stoken: "fixture-stoken" }\ndevice: { id: fixture-existing-device, fp: "0123456789abc", bound: true }\n');
    });
}, 15_000);

test("关闭私聊时两协议群绑定按群隔离，设备原文撤回且不交通用插件", async () => {
  await withDualGatewayFixture("group-device-binding", "disablePrivate: true\n", async ({ root, onebot, milky, sendOneBot, sendMilky }) => {
    let sequence = 500;
    const replies: { protocol: string; text: string; group: unknown }[] = [];
    const recalls: unknown[] = [];
    let stopped = false;
    const pump = (async () => {
      while (!stopped) {
        for (const [protocol, queue] of [["onebot", onebot], ["milky", milky]] as const) {
          let call;
          while ((call = queue.calls.shift())) {
            if (call.action === "get_group_member_info") call.respond({ ...call.params, role: call.params.user_id === 99 ? "admin" : "member" });
            else if (call.action === "get_group_member_list") call.respond([{ user_id: 99, role: "admin" }, { user_id: 42, role: "member" }]);
            else if (call.action === "send_msg" || call.action === "send_group_message") {
              replies.push({ protocol, text: JSON.stringify(call.params.message), group: call.params.group_id });
              call.respond(protocol === "onebot" ? { message_id: ++sequence } : { message_seq: ++sequence });
            } else if (call.action === "delete_msg" || call.action === "recall_group_message") { recalls.push(call.params); call.respond({}); }
            else throw new Error(`unexpected ${protocol} ${call.action}`);
          }
        }
        await Bun.sleep(5);
      }
    })();
    async function until(check: () => boolean | Promise<boolean>) {
      for (const deadline = Date.now() + 5000; !await check();) {
        if (Date.now() > deadline) throw new Error(JSON.stringify(replies));
        await Bun.sleep(10);
      }
    }
    try {
      for (const protocol of ["onebot", "milky"] as const) {
        const qq = protocol === "onebot" ? 42 : 43;
        const file = join(root, "data/users", `${qq}-2.yaml`);
        const send = (text: string, group = 77) => protocol === "onebot"
          ? sendOneBot(text, { message_type: "group", sub_type: "normal", group_id: group, sender: { user_id: qq, role: "member" } })
          : sendMilky(text, { message_scene: "group", peer_id: group, sender_id: qq });
        await send("#绑定设备2");
        await until(() => replies.some(r => r.protocol === protocol && r.text.includes("档案 2 的设备 JSON")));
        const payload = JSON.stringify({ device_id: "fixture-group-device", device_fp: "a1b2c3d4e5f67" });
        await send(payload, 78);
        await until(() => replies.some(r => r.protocol === protocol && r.group === 78));
        expect(Bun.YAML.parse(await readFile(file, "utf8"))).toMatchObject({ device: { id: "fixture-existing-device" } });
        await send(payload);
        await until(() => replies.some(r => r.protocol === protocol && r.group === 77 && r.text.includes("设备已绑定")));
        expect(Bun.YAML.parse(await readFile(file, "utf8"))).toMatchObject({ device: { id: "fixture-group-device", fp: "a1b2c3d4e5f67", bound: true } });
        expect(replies.filter(r => r.protocol === protocol).map(r => r.text).join("\n")).not.toContain("a1b2c3d4e5f67");
        await send("#设备分类对照");
        await until(() => replies.some(r => r.protocol === protocol && r.text.includes("通用插件对照")));
      }
      expect(recalls.length).toBeGreaterThanOrEqual(2);
      expect(replies.some(r => r.text.includes("设备元数据到达通用插件"))).toBe(false);
    } finally { stopped = true; await pump; }
  }, 5000, undefined, async root => {
    const profiles = join(root, "data/users");
    await mkdir(profiles, { recursive: true });
    await writeFile(join(root, ".env"), `LOTUS_PROFILE_DIR=${profiles}\n`);
    for (const qq of [42, 43]) await writeFile(join(profiles, `${qq}-2.yaml`), 'account: { cookie: "fixture-cookie", stoken: "fixture-stoken" }\ndevice: { id: fixture-existing-device, fp: "0123456789abc", bound: true }\n');
    const plugin = join(root, "plugins/native-device-proof");
    await mkdir(plugin);
    await writeFile(join(plugin, "package.json"), JSON.stringify({ name: "native-device-proof", lotusYunzai: { entry: "./index.ts" } }));
    await writeFile(join(plugin, "index.ts"), 'export default { commands: {}, fallback(message) { if(message === "#设备分类对照") return "通用插件对照"; if(message.includes("device_fp")) return "设备元数据到达通用插件"; } };');
  });
}, 15000);
