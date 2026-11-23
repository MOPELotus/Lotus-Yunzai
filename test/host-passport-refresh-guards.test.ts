import { expect, test } from "bun:test";
import { cp, mkdir, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createProfileStore } from "@lotus-yunzai/account";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const tuningUid = "123456789";
const replacementUid = "223456789";
const preload = `
import { appendFileSync } from "node:fs";
Bun.env.LOTUS_PROFILE_DIR = "./profiles";
const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) => realTimeout(callback,
  delay === 30_000 && new Error().stack.includes("passport-cookie-repair.ts") ? 100 : delay, ...args);
const realFetch = globalThis.fetch;
let statusRoleReads = 0;
function hit(action, account) {
  appendFileSync("./requests.jsonl", JSON.stringify({ action, account }) + "\\n");
}
globalThis.fetch = Object.assign(async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname === "127.0.0.1") return realFetch(input, init);
  if (url.origin === "https://passport-api.mihoyo.com" && url.pathname === "/account/ma-cn-session/app/exchange") {
    const { src_token, dst_token_type } = JSON.parse(init.body);
    const match = /^v2_fixture-stoken-(77|78|79|80)$/.exec(src_token?.token);
    if (!match || ![2, 4].includes(dst_token_type)) throw Error("意外换票");
    const account = match[1];
    hit("exchange-" + dst_token_type, account);
    return Response.json({ retcode: 0, data: dst_token_type === 2
      ? { ltoken: "fixture-renewed-lt-" + account } : { cookie_token: "fixture-renewed-ct-" + account, aid: account } });
  }
  const cookie = new Headers(init?.headers).get("cookie") || "";
  const account = /(?:^|;)ltuid=(77|78|79|80)(?:;|$)/.exec(cookie)?.[1];
  if (!account) throw Error("请求未使用当前档案");
  if (url.origin === "https://api-takumi.mihoyo.com" && url.pathname === "/binding/api/getUserGameRolesByCookie") {
    hit("roles", account);
    if (account === "77") return Response.json({ retcode: 0, data: { list: [
      { game_biz: "nap_cn", game_uid: "223456789", region: "prod_gf_cn" },
    ] } });
    if (account === "80") return new Response("transient fixture", { status: 410 });
    if (account === "78") {
      statusRoleReads++;
      if (statusRoleReads === 1) return Response.json({ retcode: -100 });
      if (statusRoleReads <= 3) return new Response("transient fixture", { status: 410 });
    }
    return Response.json({ retcode: 0, data: { list: [
      { game_biz: "hk4e_cn", game_uid: "100000001", region: "cn_gf01" },
    ] } });
  }
  if (url.origin === "https://act-api-takumi.mihoyo.com" && url.pathname === "/event/nap_gacha_record/api/zzz/index") {
    hit("tuning", account);
    if (!["77", "80"].includes(account) || url.searchParams.get("uid") !== "123456789") throw Error("意外调频请求");
    return cookie.includes("renewed") ? Response.json({ retcode: 0, data: { uid: "123456789" } })
      : Response.json({ retcode: -100 });
  }
  throw Error("隔离夹具禁止其他外部请求");
}, { preconnect: realFetch.preconnect });
`;

function profile(qq: string, id: number, account: string, game: "gs" | "zzz", cookie?: string) {
  const uid = game === "gs" ? "100000001" : tuningUid;
  const role = { game_uid: uid, game_biz: game === "gs" ? "hk4e_cn" : "nap_cn", region: game === "gs" ? "cn_gf01" : "prod_gf_cn" };
  return Bun.YAML.stringify({ user: { qq }, profile: { id }, account: {
    stuid: account, ltuid: account, stoken: "v2_fixture-stoken-" + account, mid: "fixture-mid-" + account,
    cookie: cookie ?? `ltoken=fixture-lt;ltuid=${account};cookie_token=fixture-ct;account_id=${account};`,
    game_roles: { [game]: [role] }, current_uid: { [game]: uid },
  }, device: { id: "fixture-device-" + account, fp: "fixture-fp-" + account } });
}

async function prepare(root: string) {
  const source = join(import.meta.dir, "../plugins/zzz");
  const destination = join(root, "plugins", "zzz");
  await cp(source, destination, { recursive: true, filter: file => ![".git", "node_modules"].includes(basename(file)) });
  await symlink(join(source, "node_modules"), join(destination, "node_modules"), "dir");
  const profiles = join(root, "profiles");
  await mkdir(profiles);
  await Promise.all([
    writeFile(join(profiles, "42.yaml"), profile("42", 1, "77", "zzz")),
    writeFile(join(profiles, "42-2.yaml"), profile("42", 2, "80", "zzz")),
    writeFile(join(profiles, "43.yaml"), profile("43", 1, "78", "gs")),
    writeFile(join(profiles, "44.yaml"), profile("44", 1, "79", "gs", "_csrf=unrelated;")),
  ]);
}

test("实际宿主启动修复旧档、OneBot 调频续期换角和 Milky 角色同步失败分别落盘", async () => {
  await withDualGatewayFixture("passport-guards-fixture", "disablePrivate: false\n",
    async ({ root, onebot, milky, sendOneBot, sendMilky }) => {
      const profiles = createProfileStore(join(root, "profiles"));
      for (let attempt = 0; attempt < 150; attempt++) {
        if ((await profiles.accountContext("44")).account.cookie.includes("fixture-renewed-ct-79")) break;
        await Bun.sleep(20);
      }
      expect((await profiles.accountContext("44")).account.cookie).toContain("fixture-renewed-ct-79");

      sendOneBot("%母带", { message_type: "group", sub_type: "normal", group_id: 600 });
      const report = await onebot.next("send_msg");
      expect(JSON.stringify(report.params)).toContain("绝区零档案已变化");
      report.respond({ message_id: 156 });
      expect((await profiles.requestSelectedContext("42", 1, "zzz")).role.uid).toBe(replacementUid);

      sendOneBot("%母带2", { message_type: "group", sub_type: "normal", group_id: 600 });
      const unchanged = await onebot.next("send_msg");
      expect(JSON.stringify(unchanged.params)).toContain("米游社未返回该角色的实时调频库存");
      unchanged.respond({ message_id: 159 });
      expect((await profiles.requestSelectedContext("42", 2, "zzz")).role.uid).toBe(tuningUid);
      expect((await profiles.describe("42", 2)).rolesPending).toBe(true);

      expect((await sendMilky("#检查CK状态")).status).toBe(200);
      const status = await milky.next("send_private_message");
      expect(JSON.stringify(status.params)).toContain("暂无法核验");
      status.respond({ message_seq: 157 });
      expect((await profiles.accountContext("43")).account.cookie).toContain("fixture-renewed-ct-78");
      expect((await profiles.describe("43", 1)).rolesPending).toBe(true);
      expect((await profiles.describe("43", 1)).activeRoles.gs).toBe("100000001");

      expect((await sendMilky("#同步角色")).status).toBe(200);
      const synchronized = await milky.next("send_private_message");
      expect(JSON.stringify(synchronized.params)).toContain("角色已同步");
      synchronized.respond({ message_seq: 158 });
      expect((await profiles.describe("43", 1)).rolesPending).toBe(false);

      const calls = (await Bun.file(join(root, "requests.jsonl")).text()).trim().split("\n")
        .map(line => JSON.parse(line) as { account: string; action: string });
      const actions = (account: string) => calls.filter(call => call.account === account).map(call => call.action);
      expect(actions("77")).toEqual(["tuning", "exchange-2", "exchange-4", "roles"]);
      expect(actions("78")).toEqual(["roles", "exchange-2", "exchange-4", "roles", "roles", "roles"]);
      expect(actions("79")).toEqual(["exchange-2", "exchange-4", "roles"]);
      expect(actions("80")).toEqual(["tuning", "exchange-2", "exchange-4", "roles", "tuning"]);
    }, 4_000, preload, prepare);
}, 15_000);
