import { linkHostPackages } from "./host-fixture.ts";
import { expect, test } from "bun:test";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const uid = "100000042";
const auth = "synthetic-charge-fixture";
const link = `https://webstatic.mihoyo.com/csc/bill-record-user?authkey=${auth} 档案2`;
const wrong = link.replace(auth, "synthetic-wrong-role");
const preload = `
const native = globalThis.fetch;
const calls = [];
Bun.env.LOTUS_PROFILE_DIR = "./profiles";
globalThis.fetch = async (address, options) => {
  const url = new URL(address instanceof Request ? address.url : address);
  if (url.hostname === "127.0.0.1") return native(address, options);
  if (url.hostname !== "hk4e-api.mihoyo.com" || !url.pathname.startsWith("/common/hk4e_self_help_query/User/") ||
      url.searchParams.get("auth_appid") !== "csc" || new Headers(options.headers).has("cookie") || options.redirect !== "error") {
    throw new Error("隔离夹具禁止外部调用");
  }
  const route = url.pathname.split("/").at(-1);
  calls.push(route);
  await Bun.write("./pay-log-requests.json", JSON.stringify(calls));
  const uid = url.searchParams.get("authkey") === ${JSON.stringify(auth)} ? ${JSON.stringify(uid)} : "100000043";
  return Response.json({ retcode: 0, data: route === "GetUserInfo" ? { uid } : { list: [] } });
};`;

async function prepare(root: string) {
  const source = join(import.meta.dir, "../plugins/genshin");
  const destination = join(root, "plugins", "genshin");
  await cp(source, destination, { recursive: true, filter: file => ![".git", "node_modules"].includes(basename(file)) });
  await symlink(join(source, "node_modules"), join(destination, "node_modules"), "dir");
  await linkHostPackages(root);
  await mkdir(join(root, "profiles"));
  await writeFile(join(root, "profiles", "42-2.yaml"), Bun.YAML.stringify({ user: { qq: "42" }, profile: { id: 2 }, account: {
    stuid: "99042", stoken: "fixture", cookie: "account_id=99042;cookie_token=fixture", current_uid: { gs: uid },
    game_roles: { gs: [{ uid, region: "cn_gf01", game_biz: "hk4e_cn" }] },
  } }));
  await writeFile(join(root, "plugins", "sensitive-spy.js"), `export default class extends plugin {
  constructor() { super({ name: "fixture spy", event: "message", rule: [{ reg: "authkey=", fnc: "observe" }] }); }
  observe() { return Bun.write("./spy-observed.txt", "sensitive fallback received input"); }
}`);
}

test("真实宿主独派客服查询链接，不把档案号刷新词交给仓库更新", async () => {
  await withDualGatewayFixture("genshin-pay-log", "disablePrivate: false\n", async ({ root, onebot, milky, sendOneBot, sendMilky }) => {
    const calls = join(root, "pay-log-requests.json");
    const ledger = join(root, "data", "genshin", "pay-log", "42", `${uid}.json`);
    sendOneBot(link, { message_type: "group", sub_type: "normal", group_id: 601 });
    expect((await sendMilky(link)).status).toBe(200);
    const foreign = await milky.next("send_private_message");
    expect(foreign.params).toMatchObject({ user_id: 43 });
    expect(JSON.stringify(foreign.params)).toContain("请先登录档案 2");
    foreign.respond({ message_seq: 49 });
    await Bun.sleep(75);
    expect(await Bun.file(calls).exists()).toBe(false);
    expect(await Bun.file(join(root, "spy-observed.txt")).exists()).toBe(false);
    sendOneBot(wrong);
    const blocked = await onebot.next("send_msg");
    expect(JSON.stringify(blocked.params)).toContain("角色与当前档案不一致");
    blocked.respond({ message_id: 50 });
    expect(JSON.parse(await readFile(calls, "utf8"))).toEqual(["GetUserInfo"]);
    expect(await Bun.file(ledger).exists()).toBe(false);
    sendOneBot(link);
    const first = await onebot.next("send_msg");
    expect(first.params).toMatchObject({ message_type: "private", user_id: 42 });
    expect(JSON.stringify(first.params)).toContain("没有可统计的消费");
    first.respond({ message_id: 51 });
    expect(JSON.parse(await readFile(ledger, "utf8"))).toEqual({ [uid]: { uid, crystal: 0, monthData: [] } });
    sendOneBot("#更新充值记录 档案2");
    const refreshed = await onebot.next("send_msg");
    expect(JSON.stringify(refreshed.params)).toContain("没有可统计的消费");
    refreshed.respond({ message_id: 52 });
    expect(JSON.parse(await readFile(calls, "utf8"))).toEqual(["GetUserInfo", "GetUserInfo", "GetCrystalLog", "GetPrimogemLog",
      "GetUserInfo", "GetCrystalLog", "GetPrimogemLog"]);
    expect(await Bun.file(join(root, "spy-observed.txt")).exists()).toBe(false);
  }, 3_000, preload, prepare);
}, 12_000);
