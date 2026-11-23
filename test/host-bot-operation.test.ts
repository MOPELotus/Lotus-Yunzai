import { expect, test } from "bun:test";
import { cp, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const token = "bot-operation-fixture";
const privateCode = "private-secret-marker";
const groupCode = "group-secret-marker";
const milkyCode = "milky-secret-marker";

test("旧 Bot 操作按绑定会话区分主人、目标和能力，验证码不交旧插件或进日志", async () => {
  await withDualGatewayFixture(token, 'master: ["99:42", "100:43"]\n', async ({
    root, onebot, milky, sendOneBot, sendMilky,
  }) => {
    async function oneBotReply(text: string, reply: string, fields?: object) {
      sendOneBot(text, fields);
      const frame = await onebot.next("send_msg");
      expect(frame.params).toMatchObject({ message: reply });
      frame.respond({ message_id: 700 });
    }
    async function milkyReply(text: string, reply: string, fields?: object) {
      expect((await sendMilky(text, fields)).status).toBe(200);
      const frame = await milky.next("send_private_message");
      expect(frame.params).toMatchObject({ message: [{ type: "text", data: { text: reply } }] });
      frame.respond({ message_seq: 701, time: 1_700_000_000 });
    }

    await oneBotReply("#Bot上线99", "暂不支持此操作");
    await oneBotReply("#机器人下线 100", "只能操作当前机器人的账号。");
    await oneBotReply("#Bot下线 12345", "Bot 不存在");
    await oneBotReply("#机器人上线 99", "只有当前机器人的主人才能执行此操作。", { user_id: 43 });
    await oneBotReply(`#机器人验证 99:${privateCode}:保留后续冒号`, "暂不支持此操作");
    await oneBotReply(`测试别名 #Bot验证99:${groupCode}`, "暂不支持此操作", {
      message_type: "group", sub_type: "normal", group_id: 77, sender: { user_id: 42, nickname: "同号主人" },
    });
    await milkyReply("#Bot下线100", "暂不支持此操作");
    await milkyReply("#机器人上线 99", "只能操作当前机器人的账号。");
    await milkyReply("#机器人下线 23456", "Bot 不存在");
    await milkyReply("#Bot上线100", "只有当前机器人的主人才能执行此操作。", { sender_id: 42, peer_id: 42 });
    await milkyReply(`#Bot验证 100:${milkyCode}`, "暂不支持此操作");

    await oneBotReply("普通转述 #Bot验证方式说明", "普通文本仍走旧插件", { user_id: 55 });
    await milkyReply("普通转述 #设置主人验证码", "普通文本仍走旧插件", { sender_id: 56, peer_id: 56 });
    expect(await readFile(join(root, "ordinary.txt"), "utf8")).toContain("普通转述 #Bot验证方式说明");
    expect(await readFile(join(root, "ordinary.txt"), "utf8")).toContain("普通转述 #设置主人验证码");
    const logfiles = new Bun.Glob("logs/*.log").scanSync(root);
    const logs = await Promise.all([...logfiles].map(path => Bun.file(join(root, path)).text()));
    expect(logs.join("\n")).toContain("普通消息夹具");
    for (const needle of [privateCode, groupCode, milkyCode]) {
      expect(await readFile(join(root, "ordinary.txt"), "utf8")).not.toContain(needle);
      expect(logs.join("\n")).not.toContain(needle);
    }
    expect(onebot.calls).toEqual([]);
    expect(milky.calls).toEqual([]);
  }, 2_000, undefined, async root => {
    await writeFile(join(root, "config", "bot.yaml"), "cache_group_member: false\nonline_msg_exp: 0\n");
    await writeFile(join(root, "config", "group.yaml"),
      "default: { groupCD: 0, singleCD: 0, onlyReplyAt: 1, botAlias: [测试别名] }\n");
    await writeFile(join(root, "plugins", "ordinary-fixture.js"), `
      import { appendFileSync } from "node:fs";
      export default class Ordinary extends plugin {
        constructor() { super({ event: "message", rule: [{ reg: "^普通转述", fnc: "relay" }] }); }
        accept(e) {
          appendFileSync("./ordinary.txt", e.raw_message + "\\n");
          Bot.makeLog("info", e.raw_message, "普通消息夹具");
        }
        relay(e) { return e.reply("普通文本仍走旧插件"); }
      }
    `);
  });
}, 12_000);

test("两种网关群消息通知继续转交普通文本，带别名的验证码不会转告主人", async () => {
  await withDualGatewayFixture(token + "-group-notices", 'master: ["99:42", "100:43"]\n', async ({
    onebot, milky, sendOneBot, sendMilky,
  }) => {
    const oneBotGroup = { message_type: "group", sub_type: "normal", group_id: 77, user_id: 55 };
    const milkyGroup = { message_scene: "group", sender_id: 56, peer_id: 77 };
    sendOneBot(`测试别名 #Bot验证99:${groupCode}`, oneBotGroup);
    const obDenied = await onebot.next("send_msg");
    expect(obDenied.params).toMatchObject({ group_id: 77, message: "只有当前机器人的主人才能执行此操作。" });
    obDenied.respond({ message_id: 810 });
    expect((await sendMilky(`测试别名 #机器人验证100:${milkyCode}`, milkyGroup)).status).toBe(200);
    const mkDenied = await milky.next("send_group_message");
    expect(mkDenied.params).toMatchObject({ group_id: 77, message: [{ type: "text", data: { text: "只有当前机器人的主人才能执行此操作。" } }] });
    mkDenied.respond({ message_seq: 811, time: 1_700_000_000 });
    await Bun.sleep(65);
    expect(onebot.calls).toEqual([]);
    expect(milky.calls).toEqual([]);

    sendOneBot("OneBot 普通群消息继续转述", oneBotGroup);
    (await onebot.next("get_group_info")).respond({ group_id: 77, group_name: "测试群" });
    (await onebot.next("get_friend_list")).respond([{ user_id: 42 }]);
    const obNotice = await onebot.next("send_msg");
    expect(obNotice.params).toMatchObject({ user_id: 42 });
    expect(JSON.stringify(obNotice.params.message)).toContain("OneBot 普通群消息继续转述");
    obNotice.respond({ message_id: 812 });
    expect((await sendMilky("Milky 普通群消息继续转述", milkyGroup)).status).toBe(200);
    (await milky.next("get_group_info")).respond({ group: { group_id: 77, group_name: "测试群" } });
    (await milky.next("get_friend_list")).respond({ friends: [{ user_id: 43 }] });
    const mkNotice = await milky.next("send_private_message");
    expect(mkNotice.params).toMatchObject({ user_id: 43 });
    expect(JSON.stringify(mkNotice.params.message)).toContain("Milky 普通群消息继续转述");
    mkNotice.respond({ message_seq: 813, time: 1_700_000_000 });
  }, 2_000, undefined, async root => {
    const source = await realpath(new URL("../plugins/group", import.meta.url));
    const target = join(root, "plugins", "group");
    await cp(source, target, { recursive: true, filter: path => ![".git", "node_modules"].includes(basename(path)) });
    await mkdir(join(target, "node_modules"), { recursive: true });
    for (const dependency of ["skia-canvas", "yaml"]) {
      await symlink(await realpath(join(source, "node_modules", dependency)), join(target, "node_modules", dependency), "dir");
    }
    await writeFile(join(root, "config", "bot.yaml"), "cache_group_member: false\nonline_msg_exp: 0\n");
    await writeFile(join(root, "config", "group.yaml"), "default: { groupCD: 0, singleCD: 0, botAlias: [测试别名] }\n");
    await writeFile(join(root, "config", "group-notice.yaml"), "default: { groupMessage: true, groupRecall: true }\n");
  });
}, 12_000);
