import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkinStatus } from "../lib/checkin-registration-commands.ts";
import { checkinSettingsNickname } from "../lib/checkin-profile-commands.ts";
import { createProfileStore } from "@lotus-yunzai/account";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

test("只用当前本人有效会话的签到名片和昵称", () => {
  const context = {
    user_id: 42, message_type: "group", sub_type: "normal", groupActivitySignal: new AbortController().signal,
    sender: { user_id: 42, card: "群名片", nickname: "好友昵称" },
  } as const;
  expect(checkinSettingsNickname(context)).toBe("群名片");
  expect(checkinSettingsNickname({ ...context, sender: { ...context.sender, user_id: 43 } })).toBeUndefined();
  expect(checkinSettingsNickname({ ...context, isDelegated: true })).toBeUndefined();
  expect(checkinSettingsNickname({ ...context, sub_type: "anonymous" })).toBeUndefined();
  expect(checkinSettingsNickname({ ...context, groupActivitySignal: AbortSignal.abort() })).toBeUndefined();
  expect(checkinSettingsNickname({ ...context, message_type: "private", sub_type: "friend" })).toBeUndefined();
  expect(checkinSettingsNickname({ ...context, message_type: "private", sub_type: "friend",
    privateCredentialSignal: new AbortController().signal })).toBe("好友昵称");
});

test("旧签到状态只读取当前已认证 QQ 即时的各档登记", async () => {
  const phone = "13812345678";
  const secrets = {
    cookie: "account_id=123;cookie_token=private-cookie-fixture",
    stoken: "private-stoken-fixture", ltuid: "123", mid: "private-mid-fixture",
    game_roles: { gs: [{ uid: "100000042", region: "cn_gf01", nickname: phone }] },
  };
  const profile = (qq: string, id: number, enabled: boolean, loggedIn: boolean) => ({
    user: { qq, phone, nickname: phone }, profile: { id, name: "private-display" }, enabled,
    account: loggedIn ? secrets : { phone },
    games: { cn: { enable: true, genshin: { checkin: true }, honkai_sr: { checkin: false }, zzz: { checkin: true } } },
    mihoyobbs: { enable: true, tasks: { checkin: true }, checkin_list: [2, 8] },
    device: { id: "private-device", raw: { phone } },
  });
  const texts = new Map(Object.entries({
    "42.yaml": profile("42", 1, true, true),
    "42-2.yaml": profile("42", 2, false, true),
    "42-3.yaml": { ...profile("42", 3, true, false), games: { cn: { enable: false } }, mihoyobbs: { enable: false } },
    "42-5.yaml": profile("44", 5, true, true),
    "43-4.yaml": profile("43", 4, false, true),
    "44-97.yaml": profile("44", 97, true, true),
  }).map(([name, value]) => [name, Bun.YAML.stringify(value)]));
  const preload = [
    'Bun.env.LOTUS_PROFILE_DIR = process.cwd() + "/profiles";',
    'const originalFetch = globalThis.fetch;',
    'globalThis.fetch = Object.assign((input, init) => {',
    '  const url = new URL(input instanceof Request ? input.url : input);',
    '  if (url.hostname !== "127.0.0.1") throw new Error("offline fixture");',
    '  return originalFetch(input, init);',
    '}, originalFetch);',
  ].join("\n");

  await withDualGatewayFixture("checkin-status-offline", 'master: ["99:91", "100:92"]\n', async gateways => {
    const group = { message_type: "group", sub_type: "normal", group_id: 77, sender: { user_id: 42, role: "member" } };
    gateways.sendOneBot("#签到状态", group);
    const onebot = await gateways.onebot.next("send_msg");
    expect(onebot.params).toMatchObject({ message_type: "group", group_id: 77 });
    expect(onebot.params.message).toBe([
      "已绑定 2 个登录档案，已注册 2 个自动签到档案。",
      "档案 1：原神、绝区零 + 社区",
      "档案 3：无国服游戏（待登录）",
      "另有 1 个档案暂时无法读取。",
    ].join("\n"));
    onebot.respond({ message_id: 101 });

    expect((await gateways.sendMilky("#签到状态")).status).toBe(200);
    const milky = await gateways.milky.next("send_private_message");
    expect(milky.params).toMatchObject({ user_id: 43, message: [
      { type: "text", data: { text: "已绑定 1 个登录档案，已注册 0 个自动签到档案。\n尚未注册自动签到，可发送 #注册自动签到。" } },
    ] });
    milky.respond({ message_seq: 102 });

    gateways.sendOneBot("#签到状态", { user_id: 45 });
    const empty = await gateways.onebot.next("send_msg");
    expect(empty.params).toMatchObject({ user_id: 45, message: expect.stringContaining("尚无登录资料，可发送 #扫码登录。") });
    empty.respond({ message_id: 103 });

    gateways.sendOneBot("#签到状态 44", group);
    gateways.sendOneBot("#签到状态", { ...group, group_id: 78, user_id: 44, sender: { user_id: 45 } });
    gateways.sendOneBot("#签到状态", { ...group, group_id: 78, user_id: 46, sub_type: "anonymous", sender: { user_id: 46 } });
    gateways.sendOneBot("#签到状态", { ...group, group_id: 79, user_id: 44, sender: { user_id: 44, role: "member" } });
    await Bun.sleep(160);
    expect(gateways.onebot.calls).toEqual([]);
    expect(gateways.milky.calls).toEqual([]);
    const directory = join(gateways.root, "profiles");
    expect((await readdir(directory)).sort()).toEqual([...texts.keys()].sort());
    for (const [name, source] of texts) expect(await readFile(join(directory, name), "utf8")).toBe(source);
  }, 2000, preload, async root => {
    const directory = join(root, "profiles");
    await mkdir(directory);
    for (const [name, source] of texts) await writeFile(join(directory, name), source);
    await writeFile(join(root, "config/group.yaml"), Bun.YAML.stringify({
      default: { groupCD: 0, singleCD: 0 }, 79: { disable: ["@lotus-yunzai/checkin-status"] },
    }));
    await writeFile(join(root, "config/global.yaml"), "scheduler: {enable: false}\n");
  });
});

test("本人签到状态读取后收到会话撤回时不返回档案状态", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-checkin-status-revoked-"));
  try {
    await writeFile(join(directory, "42.yaml"), "user: {qq: 42}\nprofile: {id: 1}\nenabled: true\n");
    const readStatus = checkinStatus(directory);
    let checks = 0;
    expect(await readStatus("42", { isCurrent: () => ++checks <= 2 })).toBeUndefined();
    expect(checks).toBe(3);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("旧签到时间仅主人能设置，普通用户仍可管理本人签到与通知", async () => {
  const reply = "签到模式与时间由机器人主人统一安排。";
  await withDualGatewayFixture("checkin-schedule-owner", 'master: ["99:42", "100:91"]\n', async ({ root, onebot, milky, sendOneBot, sendMilky }) => {
    const profiles = createProfileStore(join(root, "profiles"));
    const original = await readFile(join(root, "profiles", "43-2.yaml"), "utf8");
    let sequence = 200;
    for (const command of ["#随机签到时间2", "#设置签到时间2 6:40", "#跟随全局签到时间2"]) {
      expect((await sendMilky(command)).status).toBe(200);
      const result = await milky.next("send_private_message");
      expect(result.params).toMatchObject({ user_id: 43, message: [{ data: { text: reply } }] });
      result.respond({ message_seq: sequence++ });
    }
    expect(await readFile(join(root, "profiles", "43-2.yaml"), "utf8")).toBe(original);

    sendOneBot("#固定签到时间2 9:05", { sender: { user_id: 42, nickname: "本人旧名片" } });
    const scheduled = await onebot.next("send_msg");
    expect(scheduled.params.user_id).toBe(42);
    expect(JSON.stringify(scheduled.params.message)).not.toContain(reply);
    scheduled.respond({ message_id: sequence++ });
    expect((await profiles.checkinSettings("42", 2)).schedule.fixedTime).toBe("09:05");
    expect((await profiles.checkinSettings("42", 2)).displayName).toBe("本人旧名片");

    for (const [index, command] of ["#关闭社区签到2", "#禁用崩铁游戏签到2", "#关闭签到通知2"].entries()) {
      expect((await sendMilky(command, { friend: { user_id: 43, nickname: index === 0 ? "Milky 本人" : "换名不覆盖" } })).status).toBe(200);
      const result = await milky.next("send_private_message");
      expect(result.params.user_id).toBe(43);
      expect(JSON.stringify(result.params.message)).not.toContain(reply);
      result.respond({ message_seq: sequence++ });
    }
    const current = await profiles.checkinSettings("43", 2);
    expect(current).toMatchObject({ displayName: "Milky 本人", communityForums: [], notify: { enabled: false }, games: { honkai_sr: { enabled: false } } });
    expect(current.schedule).toMatchObject({ mode: "fixed", fixedTime: "08:15" });

    const owner = { sender_id: 91, peer_id: 91 };
    expect((await sendMilky("#随机签到时间2", owner)).status).toBe(200);
    (await milky.next("send_private_message")).respond({ message_seq: sequence++ });
    expect((await profiles.checkinSettings("91", 2)).schedule.mode).toBe("random");

    const group = { ...owner, message_scene: "group", peer_id: 72 };
    expect((await sendMilky("#绑定通知群2", {
      ...group, group_member: { group_id: 72, user_id: 91, card: "签到群内名片", nickname: "QQ 昵称", role: "member" },
    })).status).toBe(200);
    (await milky.next("send_group_message")).respond({ message_seq: sequence++ });
    expect((await profiles.checkinSettings("91", 2)).displayName).toBe("签到群内名片");

    expect((await sendMilky("#注册本群签到2", group)).status).toBe(200);
    const roster = await milky.next("get_group_member_list");
    expect(roster.params).toEqual({ group_id: 72, no_cache: true });
    roster.respond({ members: [{ group_id: 72, user_id: 91, nickname: "合成群名片" }] });
    (await milky.next("send_group_message")).respond({ message_seq: sequence++ });
    expect((await profiles.checkinSettings("91", 2)).notify.fallbackGroups).toEqual([72]);
  }, 4000, `
    Bun.env.LOTUS_PROFILE_DIR = process.cwd() + "/profiles";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign((input, init) => {
      if (new URL(input instanceof Request ? input.url : input).hostname !== "127.0.0.1") throw new Error("offline fixture");
      return originalFetch(input, init);
    }, originalFetch);
  `, async root => {
    const directory = join(root, "profiles");
    await mkdir(directory);
    await writeFile(join(root, "config", "global.yaml"), "scheduler: {enable: false}\n");
    for (const qq of ["42", "43", "91"]) {
      const profile = {
        user: { qq }, profile: { id: 2 }, schedule: { mode: "fixed", fixed_time: "08:15" },
        account: { cookie: "cookie_token=fixture", stoken: "fixture" },
        mihoyobbs: { enable: true, tasks: { checkin: true }, checkin_list: [2, 8] },
      };
      await writeFile(join(directory, `${qq}-2.yaml`), Bun.YAML.stringify(profile));
    }
  });
}, 20_000);


test("全局签到到期授权只认当前机器人主人，并保留显式用户拒绝", async () => {
  const ownerConfig = 'master: ["99:42", "100:43", "100:44"]\ndisablePrivate: false\n';
  await withDualGatewayFixture("checkin-due-owner", ownerConfig, async ({ onebot, milky, sendOneBot, sendMilky }) => {
    const due = "#执行到期签到";
    const disabled = "全局自动签到已关闭。";
    const denied = "当前会话无权执行到期签到。";
    sendOneBot(due);
    const own = await onebot.next("send_msg");
    expect(own.params.message).toBe(disabled);
    own.respond({ message_id: 1 });

    sendOneBot(due, { user_id: 43 });
    const foreign = await onebot.next("send_msg");
    expect(foreign.params.message).toBe(denied);
    foreign.respond({ message_id: 2 });

    for (const [qq, expected] of [[43, disabled], [42, denied], [44, denied], [45, denied]] as const) {
      expect((await sendMilky(due, { sender_id: qq, peer_id: qq })).status).toBe(200);
      const response = await milky.next("send_private_message");
      expect(response.params).toMatchObject({ user_id: qq, message: [{ data: { text: expected } }] });
      response.respond({ message_seq: qq });
    }
  }, 3_000, undefined, async root => {
    await writeFile(join(root, "config", "global.yaml"),
      "scheduler: {enable: false}\npermissions: {users: {deny: [44]}}\n");
  });
}, 12_000);

test("全局签到尊重合法 allow 和 inherit，非法策略不会放宽权限", async () => {
  const disabled = "全局自动签到已关闭。";
  const denied = "当前会话无权执行到期签到。";
  for (const [rule, ordinary, allowListed] of [
    [{ policy: "master_ony" }, denied, denied],
    [{ policy: "allow" }, disabled, disabled],
    [{ policy: "inherit" }, denied, disabled],
  ] as const) {
    await withDualGatewayFixture("checkin-due-policy", 'master: ["99:42"]\ndisablePrivate: false\n',
      async ({ onebot, milky, sendOneBot, sendMilky }) => {
        sendOneBot("#执行到期签到", { user_id: 43 });
        const one = await onebot.next("send_msg");
        expect(one.params.message).toBe(ordinary);
        one.respond({ message_id: 1 });
        for (const [qq, expected] of [[44, denied], [45, allowListed]] as const) {
          expect((await sendMilky("#执行到期签到", { sender_id: qq, peer_id: qq })).status).toBe(200);
          const response = await milky.next("send_private_message");
          expect(response.params).toMatchObject({ user_id: qq, message: [{ data: { text: expected } }] });
          response.respond({ message_seq: qq });
        }
      }, 3_000, undefined, async root => {
        await writeFile(join(root, "config", "global.yaml"), Bun.YAML.stringify({
          scheduler: { enable: false },
          permissions: { default_policy: rule.policy === "inherit" ? "deny" : "allow",
            users: { allow: [45], deny: [44] }, scopes: { "scheduler.run_due": rule } },
        }));
      });
  }
}, 15_000);

test("签到权限拒绝配置形状错误，并保留旧全局缺省策略行为", async () => {
  const deniedDue = "当前会话无权执行到期签到。";
  const deniedRefresh = "当前不允许刷新登录信息，请联系机器人主人。";
  const allowedDue = "全局自动签到已关闭。";
  const allowedRefresh = "当前 QQ 尚未创建档案。";
  const inherited = { policy: "inherit" };
  for (const [defaultPolicy, refreshRule, due, refresh] of [
    ["allow_typo", inherited, deniedDue, deniedRefresh],
    ["allow", "master_only", allowedDue, deniedRefresh],
    ["allow", [], allowedDue, deniedRefresh],
    ["master_only", inherited, allowedDue, allowedRefresh],
    ["inherit", inherited, allowedDue, allowedRefresh],
    ["deny", inherited, deniedDue, deniedRefresh],
    [null, null, allowedDue, allowedRefresh],
  ] as const) {
    await withDualGatewayFixture("checkin-scope-shape", "disablePrivate: false\n", async ({ onebot, milky, sendOneBot, sendMilky }) => {
      sendOneBot("#执行到期签到");
      const one = await onebot.next("send_msg");
      expect(one.params.message).toBe(due);
      one.respond({ message_id: 1 });
      expect((await sendMilky("#刷新Cookie")).status).toBe(200);
      const other = await milky.next("send_private_message");
      expect(other.params).toMatchObject({ user_id: 43, message: [{ data: { text: refresh } }] });
      other.respond({ message_seq: 2 });
    }, 3_000, undefined, async root => {
      await writeFile(join(root, "config", "global.yaml"), Bun.YAML.stringify({
        scheduler: { enable: false },
        permissions: { default_policy: defaultPolicy,
          scopes: { "scheduler.run_due": inherited, "checkin.refresh": refreshRule } },
      }));
    });
  }
}, 20_000);
