import { expect, test } from "bun:test";
import { appendFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const command = "%显示国际服角色面板排名";
const proxyOrigin = "http://127.0.0.1:18123";
const qid = 42;
const role = "1300000001";
const accountHost = "https://api-account-os.hoyolab.com";
const route = "/binding/api/getUserGameRolesByLtoken";
const cookie = "ltuid_v2=810; ltoken_v2=v2_fixture-nap; ltmid_v2=fixture-mid";
const group = (id: number) => ({ message_type: "group", sub_type: "normal", group_id: id, sender: { user_id: qid } });
const member = (id: number) => ({ user_id: qid, group_id: id, role: "member", nickname: "fixture" });

test("真实宿主只在允许的同群原会话经主机代理核验国际服排名身份", async () => {
  const preload = `
import { appendFileSync } from "node:fs";
const realFetch = globalThis.fetch;
globalThis.redis = {
  async get() { return null; },
  async mGet(keys) { return keys.map(() => null); },
  async hSet(key, field, value) { appendFileSync("rank-writes.jsonl", JSON.stringify({key,field,value}) + "\\n"); return 1; },
};
globalThis.fetch = async (input, options) => {
  const target = new URL(input instanceof Request ? input.url : String(input));
  if (target.hostname === "127.0.0.1") return realFetch(input,options);
  const proxy = options?.proxy;
  const cookies = new Headers(options?.headers).get("cookie");
  appendFileSync("rank-network.jsonl", JSON.stringify({
    origin: target.origin, path: target.pathname, proxy: proxy?.url?.origin ?? null,
    guardedProxy: proxy?.respectNoProxy === false && options?.redirect === "error",
    verifiedCookie: cookies === ${JSON.stringify(cookie)},
  }) + "\\n");
  if (target.origin !== ${JSON.stringify(accountHost)} || target.pathname !== ${JSON.stringify(route)}) throw new Error("offline fixture guard");
  return Response.json({ retcode: 0, data: { account_id: "810", ma_passport_region: "US",
    list: [{ game_uid: ${JSON.stringify(role)}, region: "prod_gf_jp", game_biz: "nap_global", is_chosen: true }] } });
};
`;
  await withDualGatewayFixture("isolated-zzz-rank-proxy", "master: [99:42]\ndisablePrivate: false\n", async ({ root, onebot, milky, sendOneBot, sendMilky }) => {
    const trace = async (file: string) => (await readFile(join(root, file), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    const requests = () => trace("rank-network.jsonl");
    const writes = () => trace("rank-writes.jsonl");
    const memberList = async (id: number) => {
      const lookup = await onebot.next("get_group_member_list");
      expect(lookup.params.group_id).toBe(id);
      lookup.respond([member(id)]);
    };
    const reply = async (id: number, text: RegExp) => {
      const frame = await onebot.next("send_msg");
      expect(frame.params.group_id).toBe(id);
      expect(frame.params.message).toMatch(text);
      frame.respond({ message_id: 222 });
    };
    sendOneBot(command, group(772));
    await reply(772, /当前群角色面板排名功能已关闭/u);
    expect(await requests()).toEqual([]);
    expect(await writes()).toEqual([]);

    sendOneBot("#代42 -- " + command, group(771));
    const delegatedMember = await onebot.next("get_group_member_info");
    expect(delegatedMember.params).toMatchObject({ group_id: 771, user_id: 42 });
    delegatedMember.respond(member(771));
    await reply(771, /请在群聊中使用该命令/u);
    await reply(771, /执行结束：已处理 1/u);
    expect(await requests()).toEqual([]);
    expect(await writes()).toEqual([]);

    sendOneBot(command, group(773));
    const nonMember = await onebot.next("get_group_member_list");
    expect(nonMember.params.group_id).toBe(773);
    nonMember.respond([{ ...member(773), user_id: 43 }]);
    await reply(773, /暂无法核对当前群成员/u);
    expect(await requests()).toEqual([]);
    expect(await writes()).toEqual([]);

    sendOneBot(command, group(771));
    await memberList(771);
    await reply(771, /本群已显示该档案的国际服角色面板排名/u);
    const proxyRequest = { origin: accountHost, path: route, proxy: proxyOrigin, guardedProxy: true, verifiedCookie: true };
    const rankWrite = (id: number) => ({
      key: `lotus-yunzai:zzz-panel-ranks:${id}:owners`,
      field: "42:1", value: expect.stringMatching(/^international:prod_gf_jp:1300000001:[a-f0-9]{64}$/u),
    });
    expect(await requests()).toEqual([proxyRequest]);
    expect(await writes()).toEqual([rankWrite(771)]);

    expect((await sendMilky(command, { message_scene: "group", peer_id: 774, sender_id: qid })).status).toBe(200);
    const milkyMembers = await milky.next("get_group_member_list");
    expect(milkyMembers.params.group_id).toBe(774);
    milkyMembers.respond({ members: [member(774)] });
    const milkyReply = await milky.next("send_group_message");
    expect(milkyReply.params.group_id).toBe(774);
    expect(JSON.stringify(milkyReply.params)).toMatch(/本群已显示该档案的国际服角色面板排名/u);
    milkyReply.respond({ message_seq: 223 });
    expect(await requests()).toEqual([proxyRequest, proxyRequest]);
    expect(await writes()).toEqual([rankWrite(771), rankWrite(774)]);
  }, 3_000, preload, async (root) => {
    for (const plugin of ["execute", "zzz"]) {
      await cp(new URL(`../plugins/${plugin}/`, import.meta.url), join(root, "plugins", plugin), {
        recursive: true, filter: path => !path.endsWith("/.git"),
      });
    }
    await mkdir(join(root, "profiles"));
    await writeFile(join(root, ".env"), "LOTUS_PROFILE_DIR=profiles\n");
    await appendFile(join(root, "config/config/bot.yaml"), `proxyAddress: "${proxyOrigin}"\nonline_msg_exp: 0\n`);
    await writeFile(join(root, "config/zzz-rank.yaml"), "allow_group: true\nblack_list: [772]\n");
    await writeFile(join(root, "rank-network.jsonl"), "");
    await writeFile(join(root, "rank-writes.jsonl"), "");
    await writeFile(join(root, "profiles/42.yaml"), Bun.YAML.stringify({
      user: { qq: String(qid) }, profile: { id: 1 }, enabled: true,
      device: { id: "fixture-zzz-rank-device", fp: "0123456789abc", bound: true },
      account: { stuid: "71526", ltuid: "71526", stoken: "v2_fixture", mid: "fixture",
        cookie: "ltuid_v2=71526; ltmid_v2=fixture; ltoken_v2=v2_fixture; cookie_token_v2=v2_cookie" },
      games: { os: { verified_activity_cookie: cookie, verified_account_id: "810", verified_realm: "US" } },
    }), { mode: 0o600 });
  });
}, 15_000);
