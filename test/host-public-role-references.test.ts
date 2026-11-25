import { linkHostPackages } from "./host-fixture.ts";
import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { lockFile } from "../lib/file-lock.ts";
import { createPublicRoleReferences, matchPublicRoleReferenceCommand } from "../lib/public-role-references.ts";
import { createPublicRoleRegistration, matchPublicRoleRegistrationFollowup } from "../lib/public-role-registration.ts";
import { matchPanelSignatureCommand } from "../lib/panel-signature.ts";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

test("手工引用和旧序号提示不接管已存在的签名及账号指令", () => {
  expect(matchPublicRoleReferenceCommand("#星铁登记UID 800000042")).toEqual({ game: "sr", action: "登记uid", value: "800000042" });
  expect(matchPublicRoleReferenceCommand("#删除UID2")).toEqual({ game: "gs", action: "删除uid", value: "2" });
  for (const command of ["#绑定UID", "#绑定UID100000042", "#验证UID100000042", "#UID2", "#原神删除CK", "#删除UID100000042", "#导出面板 100000042"]) {
    expect(matchPublicRoleReferenceCommand(command)).toBeUndefined();
  }
  expect(matchPanelSignatureCommand("#绑定UID100000042")).toMatchObject({ action: "begin" });
});

test("公开引用的原子修改、分用户和撤权，等待公开请求时删除会压住旧结果", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-public-role-reference-"));
  const controller = new AbortController();
  const send = Promise.withResolvers<void>();
  const result = Promise.withResolvers<number>();
  let queryCount = 0;
  let authorized = true;
  const run = createPublicRoleReferences(lockFile, directory, async (_game, uid) => {
    if (uid === "100000042") return async () => { queryCount++; send.resolve(); return result.promise; };
    return async () => 1;
  });
  const call = (message: string, user = 42, isCurrent = () => authorized) =>
    run(matchPublicRoleReferenceCommand(message)!, { user, signal: controller.signal, isCurrent });
  try {
    expect(await call("#登记公开UID100000042")).toContain("100000042");
    const saved = await readFile(join(directory, "42", "1.json"), "utf8");
    expect(await call("#登记公开UID100000042")).toContain("100000042");
    expect(await readFile(join(directory, "42", "1.json"), "utf8")).toBe(saved);
    expect(await call("#公开UID列表", 43)).not.toContain("100000042");
    expect(await call("#删除UID1")).toContain("#删除公开UID2");
    expect(queryCount).toBe(0);
    const lookup = call("#查询公开UID");
    await send.promise;
    expect(await call("#删除公开UID1")).toContain("100000042");
    result.resolve(2);
    expect(await lookup).toContain("已变化");
    let checks = 0;
    await expect(call("#登记公开UID100000042", 42, () => ++checks < 3)).resolves.toBeUndefined();
    authorized = true;
    expect(await call("#公开UID列表")).not.toContain("100000042");
    expect(queryCount).toBe(1);

    expect(await call("#登记公开UID100000042")).toContain("100000042");
    expect(await call("#登记公开UID100000044")).toContain("100000044");
    expect(await call("#切换公开UID1")).toContain("100000042");
    expect(await call("#删除公开UID1")).toContain("100000042");
    expect(await call("#公开UID列表")).toContain("1. 100000044（当前）");
    expect(await call("#查询公开UID")).toContain("100000044 · Enka 公开展板可见 1 个角色");
  } finally {
    controller.abort();
    await rm(directory, { recursive: true, force: true });
  }
});

test("登记续问需确认送达，且分别受协议、机器人、好友、连接和时限约束", async () => {
  const confirmation = Promise.withResolvers<boolean>();
  const connection = new AbortController();
  let time = 1000;
  const register = createPublicRoleRegistration(() => time);
  const scope = { adapter: "onebot" as const, bot: 99, user: 42, connection: connection.signal, isCurrent: () => true };
  const opening = register.start(scope, "zzz", () => confirmation.promise);
  expect(register.consume(scope, "82000042")).toBeUndefined();
  confirmation.resolve(true);
  await opening;
  for (const person of [{ ...scope, user: 43 }, { ...scope, bot: 100 }, { ...scope, adapter: "milky" as const }]) {
    expect(register.consume(person, "82000042")).toBeUndefined();
  }
  expect(matchPublicRoleRegistrationFollowup("UID 82000042")).toBeUndefined();
  expect(matchPublicRoleRegistrationFollowup("#绑定UID82000042")).toBeUndefined();
  expect(matchPublicRoleRegistrationFollowup("取消")).toBeUndefined();
  expect(register.consume(scope, "82000042")).toEqual({ game: "zzz", action: "登记公开uid", value: "82000042" });
  expect(register.consume(scope, "82000042")).toBeUndefined();
  await register.start(scope, "gs", () => false);
  expect(register.consume(scope, "100000042")).toBeUndefined();
  await register.start(scope, "gs", () => true);
  expect(register.consume(scope, "#取消登记")).toEqual({ cancelled: true });
  await register.start(scope, "gs", () => true);
  time += 120_000;
  expect(register.consume(scope, "100000042")).toBeUndefined();
  await register.start(scope, "gs", () => true);
  expect(register.consume({ ...scope, connection: new AbortController().signal }, "100000042")).toBeUndefined();
});

const preload = `
const native = globalThis.fetch;
const calls = [];
Bun.env.LOTUS_PROFILE_DIR = "./profiles";
// The graphics fixture covers successful UID cards separately; exercise text recovery here.
Bun.env.LOTUS_PASSPORT_QR_RESOURCES = "./unavailable-profile-card-theme";
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname === "127.0.0.1") return native(input, init);
  const headers = new Headers(init.headers);
  if (init.method !== "GET" || init.credentials !== "omit" || init.redirect !== "error" ||
      headers.has("cookie") || headers.has("authorization") || url.search || init.body) throw Error("拒绝非公开请求");
  calls.push(url.href);
  await Bun.write("./public-reads.json", JSON.stringify(calls));
  if (url.hostname === "profile.microgg.cn" && ["/api/uid/100000042", "/api/uid/100000044"].includes(url.pathname)) {
    return Response.json({ uid: url.pathname.split("/").at(-1), ttl: 60, playerInfo: {}, avatarInfoList: [] });
  }
  if (url.href === "https://enka.network/api/uid/100000042/") {
    return Response.json({ uid: "100000042", ttl: 60, playerInfo: {}, avatarInfoList: [{ propMap: {} }] });
  }
  if (url.href === "https://api.mihomo.me/sr_info/100000043") {
    return Response.json({ detailInfo: { uid: "100000043", avatarDetailList: [{ avatarId: 1102, level: 80 }] } });
  }
  if (url.href === "https://enka.network/api/zzz/uid/82000042") {
    return Response.json({ uid: "82000042", ttl: 60, PlayerInfo: { SocialDetail: { ProfileDetail: { Uid: "82000042" } } } });
  }
  return Response.json(null, { status: 404 });
};`;

test("两个真实宿主网关只让好友管理自身公开引用，三游戏实际请求无凭据", async () => {
  await withDualGatewayFixture("public-role-refs", "disablePrivate: false\n", async ({ root, sendOneBot, sendMilky, onebot, milky }) => {
    let id = 100;
    const one = async (text: string, expected: string, fields?: object) => {
      sendOneBot(text, fields);
      const outbound = await onebot.next("send_msg").catch(error => { throw new Error(text, { cause: error }); });
      expect(JSON.stringify(outbound.params)).toContain(expected);
      expect(JSON.stringify(outbound.params)).not.toContain("fixture-secret");
      outbound.respond({ message_id: ++id });
      return JSON.stringify(outbound.params);
    };
    const other = async (text: string, expected: string) => {
      expect((await sendMilky(text)).status).toBe(200);
      const outbound = await milky.next("send_private_message").catch(error => { throw new Error(text, { cause: error }); });
      expect(outbound.params).toMatchObject({ user_id: 43 });
      expect(JSON.stringify(outbound.params)).toContain(expected);
      outbound.respond({ message_seq: ++id });
      return JSON.stringify(outbound.params);
    };
    const profile = join(root, "profiles", "42.yaml");
    const bytes = await readFile(profile);
    await one("#登记UID100000042", "请私聊机器人", { message_type: "group", sub_type: "normal", group_id: 701 });
    expect(await Bun.file(join(root, "data/public-role-references/42/1.json")).exists()).toBe(false);
    await one("#登记公开UID", "两分钟内发送");
    await one("100000042", "原神当前公开 UID 为 100000042");
    await one("%登记UID", "两分钟内发送");
    await one("82000042", "绝区零当前公开 UID 为 82000042");
    await other("*登记公开UID", "两分钟内发送");
    await Bun.sleep(40);
    await other("100000043", "星铁当前公开 UID 为 100000043");
    expect(await Bun.file(join(root, "public-reads.json")).exists()).toBe(false);
    expect(await other("#公开UID列表", "100000043")).not.toContain("100000042");
    expect(await one("#原神公开UID列表", "100000042")).not.toContain("100000043");
    await one("#查询公开UID1", "Enka 公开展板可见 1 个角色");
    await other("*查询公开UID", "Mihomo 公开展板可见 1 个角色");
    await one("%查询公开UID", "Enka 公开展板可见 0 个角色");
    await other("*导出面板 100000043", "请先签名验证本人 UID 100000043");
    await other("*体力", "正在查询");
    const note = await milky.next("send_private_message");
    expect(JSON.stringify(note.params)).toContain("没有找到可查询的 profile");
    note.respond({ message_seq: ++id });
    const mixed = await one("#UID", "公开当前 1");
    expect(mixed.match(/100000042/gu)).toHaveLength(1);
    expect(mixed).toContain("82000042");
    expect(await other("#UID", "公开 1. 100000043")).not.toContain("100000042");
    await other("*UID1", "未找到本人档案");
    await other("#登记UID100000044", "原神当前公开 UID 为 100000044");
    await other("#展板更新面板 档案1", "档案");
    await other("#展板更新面板", "正在通过 MiniGG 查询公开展板");
    const rendered = await milky.next("send_private_message");
    expect(JSON.stringify(rendered.params)).toContain("没有可读取的公开展板角色");
    rendered.respond({ message_seq: ++id });
    await one("#登记UID100000046", "原神当前公开 UID 为 100000046");
    await one("#展板更新面板", "正在通过 MiniGG 查询公开展板");
    const boundReply = await onebot.next("send_msg");
    expect(JSON.stringify(boundReply.params)).toContain("没有可读取的公开展板角色");
    boundReply.respond({ message_id: ++id });
    await one("#删除UID1", "公开UID列表");
    await one("#删除公开UID1", "已删除原神公开 UID 引用 100000042");
    expect(await one("#绝区零公开UID列表", "82000042")).not.toContain("100000042");
    expect(await readFile(profile)).toEqual(bytes);
    expect(JSON.parse(await readFile(join(root, "public-reads.json"), "utf8"))).toEqual([
      "https://enka.network/api/uid/100000042/", "https://api.mihomo.me/sr_info/100000043",
      "https://enka.network/api/zzz/uid/82000042", "https://profile.microgg.cn/api/uid/100000044", "https://profile.microgg.cn/api/uid/100000042",
    ]);
  }, 3_000, preload, async root => {
    await linkHostPackages(root);
    for (const plugin of ["genshin", "starrail", "zzz"]) {
      const source = join(import.meta.dir, "../plugins", plugin);
      const target = join(root, "plugins", plugin);
      await cp(source, target, { recursive: true, dereference: true, filter: file => ![".git", "node_modules"].includes(basename(file)) });
      await symlink(join(source, "node_modules"), join(target, "node_modules"), "dir");
    }
    const profiles = join(root, "profiles");
    await mkdir(profiles);
    await writeFile(join(profiles, "42.yaml"), Bun.YAML.stringify({ user: { qq: "42" }, profile: { id: 1 }, account: {
      stuid: "42", stoken: "fixture-secret", cookie: "cookie_token=fixture-secret", current_uid: { gs: "100000042" },
      game_roles: { gs: [{ uid: "100000042", region: "cn_gf01", game_biz: "hk4e_cn" }] },
    } }));
  });
}, 12_000);
