import { linkHostPackages } from "./host-fixture.ts";
import { expect, test } from "bun:test";
import { cp, mkdir, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const cn = "https://public-operation-hkrpg.mihoyo.com";
const route = "/common/gacha_record/api/getGachaLog";
const alpha = "fixture-only-alpha", beta = "fixture-only-beta";
const accounts = { [alpha]: "100123456", [beta]: "200123457" };
const link = (key: string) => cn + route + "?game_biz=hkrpg_cn&authkey=" + key;
const preload = `
const nativeFetch = globalThis.fetch;
const accounts = ${JSON.stringify(accounts)};
Bun.env.LOTUS_PROFILE_DIR = "./profiles";
const seen = [];
globalThis.fetch = async (address, options) => {
  const url = new URL(address instanceof Request ? address.url : address);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return nativeFetch(address, options);
  if (url.origin !== ${JSON.stringify(cn)} || !url.pathname.startsWith("/common/gacha_record/api/") ||
      options.redirect !== "error" || new Headers(options.headers).has("Cookie")) throw Error("isolated upstream");
  const uid = accounts[url.searchParams.get("authkey")];
  if (!uid) throw Error("invalid test account");
  const pool = url.searchParams.get("gacha_type");
  const list = pool === "11" && url.searchParams.get("page") === "1" ? [{
    uid, id: "1800000000000000001", gacha_id: "20011", gacha_type: "11", item_id: "1003",
    rank_type: "5", count: "1", time: "2026-11-22 17:00:00", name: "夹具角色", item_type: "角色",
  }] : [];
  seen.push([uid, pool]);
  await Bun.write("./requests.json", JSON.stringify(seen));
  return Response.json({ retcode: 0, data: { region: "prod_gf_cn", region_time_zone: 8, list } });
};
`;

async function prepare(root: string) {
  const source = join(import.meta.dir, "../plugins/starrail");
  const destination = join(root, "plugins", "starrail");
  await cp(source, destination, { recursive: true, filter: file => ![".git", "node_modules"].includes(basename(file)) });
  await symlink(join(source, "node_modules"), join(destination, "node_modules"), "dir");
  await linkHostPackages(root);
  await mkdir(join(root, "profiles"), { recursive: true });
  for (const [qq, uid] of [[42, accounts[alpha]!], [43, accounts[beta]!]]) {
    await writeFile(join(root, "profiles", `${qq}.yaml`), Bun.YAML.stringify({
      user: { qq: String(qq) }, profile: { id: 1 }, account: {
        stuid: String(qq), stoken: "test-only-session", cookie: `account_id=${qq};cookie_token=test-only-cookie`,
        game_roles: { sr: [{ uid, region: "prod_gf_cn", game_biz: "hkrpg_cn" }] },
        current_uid: { sr: uid },
      },
    }));
  }
  await writeFile(join(root, "plugins", "v3-link-trap.js"), `
    export default class LinkTrap extends plugin {
      constructor() {
        super({ name: "旧入口探针", event: "message", rule: [{ reg: /authkey=/, fnc: "capture" }] });
      }
      async capture() { await Bun.write("./legacy-captured", "legacy received credential"); return this.reply("旧路由不应接收"); }
    }
  `);
}

test("OneBot and Milky use the native Star Rail private inbox and withhold links from V3", async () => {
  await withDualGatewayFixture("starrail-link-fixture", "disablePrivate: true\n", async ({ root, onebot, milky, sendOneBot, sendMilky }) => {
    sendOneBot(link(alpha), { message_type: "group", sub_type: "normal", group_id: 77 });
    sendOneBot("*抽卡链接", { message_type: "group", sub_type: "normal", group_id: 77 });
    const rejected = await onebot.next("send_msg");
    expect(rejected.params).toMatchObject({ group_id: 77, message: expect.stringContaining("好友私聊") });
    rejected.respond({ message_id: 60 });

    sendOneBot("*抽卡链接绑定");
    const prompt = await onebot.next("send_msg");
    expect(prompt.params).toMatchObject({ user_id: 42, message: expect.stringContaining("两分钟") });
    prompt.respond({ message_id: 61 });
    sendOneBot(link(alpha));
    const working = await onebot.next("send_msg");
    expect(JSON.stringify(working.params)).toContain("正在读取");
    working.respond({ message_id: 62 });
    const result = await onebot.next("send_msg");
    expect(result.params).toMatchObject({ user_id: 42, message: expect.stringContaining("新增 1") });
    expect(JSON.stringify(result.params)).not.toContain(alpha);
    result.respond({ message_id: 63 });

    await sendMilky("#星铁抽卡链接");
    const otherPrompt = await milky.next("send_private_message");
    expect(JSON.stringify(otherPrompt.params)).toContain("两分钟");
    otherPrompt.respond({ message_seq: 64 });
    await sendMilky(link(beta));
    const otherWorking = await milky.next("send_private_message");
    expect(JSON.stringify(otherWorking.params)).toContain("正在读取");
    otherWorking.respond({ message_seq: 65 });
    const otherResult = await milky.next("send_private_message");
    expect(JSON.stringify(otherResult.params)).toContain("新增 1");
    expect(JSON.stringify(otherResult.params)).not.toContain(beta);
    otherResult.respond({ message_seq: 66 });

    expect(await Bun.file(join(root, "legacy-captured")).exists()).toBe(false);
    for (const [qq, key] of [[42, alpha], [43, beta]] as const) {
      const uid = accounts[key];
      const text = await Bun.file(join(root, "data", "starRailGachaRows", String(qq), uid + ".json")).text();
      expect(text).not.toContain(key);
      expect(JSON.parse(text)).toMatchObject({ uid, qq: String(qq), records: [{ item_id: "1003" }] });
    }
    const seen = await Bun.file(join(root, "requests.json")).json() as string[][];
    expect(seen.filter(([uid]) => uid === accounts[alpha]).map(([, pool]) => pool)).toEqual(["1", "2", "11", "11", "12", "21", "22"]);
    expect(seen.filter(([uid]) => uid === accounts[beta]).map(([, pool]) => pool)).toEqual(["1", "2", "11", "11", "12", "21", "22"]);
  }, 7000, preload, prepare);
}, 25_000);
