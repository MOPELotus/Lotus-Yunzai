import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkinStatus } from "../lib/checkin-registration-commands.ts";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

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
