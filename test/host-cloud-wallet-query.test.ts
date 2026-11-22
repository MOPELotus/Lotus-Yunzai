import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

test("两种实际网关均只访问当前用户国服钱包", async () => {
  let profilePath = "";
  let swapDuringRequest = false;
  const requests: string[] = [];
  const route = "/hk4e_cg_cn/wallet/wallet/get";
  const source = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const target = new URL(request.url);
    expect(target.pathname).toBe(route);
    expect(target.search).toBe("");
    expect(request.method).toBe("GET");
    expect(request.headers.has("authorization")).toBe(false);
    expect(request.headers.has("cookie")).toBe(false);
    expect(request.headers.get("x-rpc-cg_game_biz")).toBe("hk4e_cn");
    const token = request.headers.get("x-rpc-combo_token");
    expect(["fixture-cn-42", "fixture-cn-43"]).toContain(token ?? "");
    requests.push(token!);
    if (swapDuringRequest) {
      const file = await readFile(profilePath, "utf8");
      await writeFile(profilePath, file.replace("fixture-cn-42", "fixture-cn-replacement"));
    }
    return Response.json({ retcode: 0, data: {
      free_time: {free_time: token === "fixture-cn-42" ? 0 : "27"},
      coin: {coin_num: token === "fixture-cn-42" ? "0" : "5"}, total_time: token === "fixture-cn-42" ? 0 : 32,
    } });
  } });
  const preload = `
process.env.LOTUS_PROFILE_DIR = process.cwd()+"/profiles";
const upstream = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin === "https://api-cloudgame.mihoyo.com" && url.pathname === ${JSON.stringify(route)}) {
    if (init?.method !== "GET" || init.body !== undefined || init.credentials !== "omit") throw new Error("fixture wallet boundary");
    return upstream("http://127.0.0.1:${source.port}"+url.pathname+url.search, init).then(response => new Response(response.body, {status: response.status, headers: response.headers}));
  }
  if (url.hostname === "127.0.0.1") return upstream(input, init);
  throw new Error("fixture blocks external traffic: "+url.hostname+" "+url.pathname);
};
`;
  function profile(qq: number, id: number, token?: string) {
    return Bun.YAML.stringify({
      user: { qq: String(qq) }, profile: { id }, enabled: false,
      account: { stuid: "71526", ltuid: "71526", stoken: "v2_fixture", mid: "fixture",
        cookie: "ltuid_v2=71526; ltmid_v2=fixture; ltoken_v2=v2_fixture; cookie_token_v2=v2_cookie" },
      cloud_games: {
        cn: { genshin: { enable: false, ...(token && { token }) }, zzz: { token: "fixture-zzz-ignore", enable: true } },
        os: { genshin: { token: "fixture-os-ignore", enable: true } },
      },
    });
  }
  try {
    await withDualGatewayFixture("which-wallet-fixture", "master: []\n", async ({ root, sendOneBot, onebot, sendMilky, milky }) => {
      const before = await readFile(profilePath, "utf8");
      sendOneBot("#云原神查询");
      const domestic = await onebot.next("send_msg");
      expect(domestic.params.message).toBe("云原神钱包 · 档案 1\n米云币：0\n免费时长：0 分钟\n总时长：0 分钟");
      domestic.respond({ message_id: 42 });
      const bare = sendMilky("云原神查询");
      const second = await milky.next("send_private_message");
      const milkyMessage = JSON.stringify(second.params);
      expect(milkyMessage).toContain("米云币：5");
      expect(milkyMessage).toContain("免费时长：27 分钟");
      expect(milkyMessage).toContain("总时长：32 分钟");
      expect(milkyMessage).not.toContain("fixture");
      second.respond({ message_seq: 43 });
      expect((await bare).ok).toBe(true);
      expect(await readFile(profilePath, "utf8")).toBe(before);
      expect(await readFile(join(root, "profiles/43.yaml"), "utf8")).toBe(profile(43, 1, "fixture-cn-43"));
      sendOneBot("#云原神查询2");
      const osOnly = await onebot.next("send_msg");
      expect(osOnly.params.message).toContain("尚未绑定国服云原神凭据");
      osOnly.respond({ message_id: 44 });
      expect(requests).toEqual(["fixture-cn-42", "fixture-cn-43"]);
      sendOneBot("#云原神查询", { user_id: 47 });
      const absent = await onebot.next("send_msg");
      expect(absent.params.message).toContain("请先登录 profile 1");
      absent.respond({ message_id: 45 });
      const group = { message_type: "group", sub_type: "normal", group_id: 7701, sender: { user_id: 42, role: "member" } };
      sendOneBot("#云原神查询1", group);
      const ownGroup = await onebot.next("send_msg");
      expect(ownGroup.params.group_id).toBe(7701);
      expect(ownGroup.params.message).toEqual([
        { type: "at", data: { qq: "42" } },
        { type: "text", data: { text: "\n云原神钱包 · 档案 1\n米云币：0\n免费时长：0 分钟\n总时长：0 分钟" } },
      ]);
      ownGroup.respond({ message_id: 451 });
      sendOneBot("#绑定云原神token2 fixture-do-not-read-group-input", group);
      const groupBind = await onebot.next("send_msg");
      expect(groupBind.params.group_id).toBe(7701);
      expect(groupBind.params.message).toContain("请勿在群聊或终端发送云游戏凭据");
      groupBind.respond({ message_id: 452 });
      sendOneBot("云原神查询", { ...group, sender: { user_id: 777, role: "member" } });
      await Bun.sleep(120);
      expect(requests).toEqual(["fixture-cn-42", "fixture-cn-43", "fixture-cn-42"]);
      expect(onebot.calls).toHaveLength(0);
      swapDuringRequest = true;
      sendOneBot("云原神查询1");
      const changed = await onebot.next("send_msg");
      expect(changed.params.message).toBe("档案已变更，请重新查询云原神钱包。");
      changed.respond({ message_id: 46 });
      expect(requests).toEqual(["fixture-cn-42", "fixture-cn-43", "fixture-cn-42", "fixture-cn-42"]);
      expect(await readFile(profilePath, "utf8")).toBe(before.replace("fixture-cn-42", "fixture-cn-replacement"));
    }, 5000, preload, async root => {
      await mkdir(join(root, "profiles"));
      profilePath = join(root, "profiles/42.yaml");
      await writeFile(profilePath, profile(42, 1, "fixture-cn-42"), { mode: 0o600 });
      await writeFile(join(root, "profiles/42-2.yaml"), profile(42, 2), { mode: 0o600 });
      await writeFile(join(root, "profiles/43.yaml"), profile(43, 1, "fixture-cn-43"), { mode: 0o600 });
      await writeFile(join(root, "config/global.yaml"), "coin_shop: {enable: false}\nscheduler: {enable: false}\n");
    });
  } finally {
    source.stop(true);
  }
}, 25_000);
