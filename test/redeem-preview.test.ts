import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RedeemCodeService } from "@lotus-yunzai/hoyo-client/redeem-preview";
import { MiyoliveProvider, parseOfficialDate } from "../packages/hoyo-client/redeem-preview/official.ts";
import { CommandRegistry, sendCommandReply } from "../lib/commands.ts";
import type { MessageEvent, MessageReply } from "../lib/messages.ts";
import { redeemCodeCommands } from "../lib/redeem-code-commands.ts";

const activity = "eaFixture72";
const page = `https://webstatic.mihoyo.com/bbs/event/live/index.html?act_id=${activity}`;
const start = Date.parse("2026-10-23T20:00:00+08:00");
const expiry = Date.parse("2026-10-26T12:00:00+08:00");
const title = "原神7.2前瞻";
const author = "75276539";
const fixtureItems = [
  { code: "中文测试兑换码", title: "<b>模拟原石×100</b>", to_get_time: start / 1000 },
  { code: "FIXTURE-SECOND", title: "模拟摩拉×100", to_get_time: start / 1000 },
];
const recap = { uid: author, post_id: "101", subject: "《原神》7.2版本前瞻特别节目",
  created_at: start / 1000, content: "本次兑换码将于2026年10月26日12:00:00失效。" };

test("官方开播时间必须是有效北京时间，不能把非法日期滚动成确定的开播时刻", () => {
  expect(parseOfficialDate("2026-02-31 20:00:00")).toBe(0);
  expect(parseOfficialDate("2026-04-30 24:00:00")).toBe(0);
  expect(parseOfficialDate("2028-02-29 20:00:00")).toBe(Date.parse("2028-02-29T12:00:00Z"));
  expect(parseOfficialDate("2028-02-29T20:00")).toBe(Date.parse("2028-02-29T12:00:00Z"));
});

test("仅官方直播索引 HTTP 410 触发一次匿名直连", async () => {
  const index = "https://api-takumi.mihoyo.com/event/miyolive/index";
  const calls: string[] = [];
  const direct: string[] = [];
  let fails = false;
  const controller = new AbortController();
  const provider = new MiyoliveProvider({ signal: controller.signal, async fetch(url: string, init: RequestInit) {
    calls.push(url);
    expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "error" });
    expect(new Headers(init.headers).has("Cookie")).toBe(false);
    return new Response("", { status: 410 });
  }, async directRequest(url: string, options: { headers: HeadersInit; timeoutMs: number; signal?: AbortSignal }) {
    direct.push(url);
    expect(new Headers(options.headers).has("Cookie")).toBe(false);
    expect(options.timeoutMs).toBeGreaterThan(0);
    expect(options.timeoutMs).toBeLessThanOrEqual(10_000);
    expect(options.signal).toBe(controller.signal);
    if (fails) throw new Error("直连失败夹具");
    return { retcode: 0, data: { template: {} } };
  } });
  expect(await provider.request(index, activity)).toEqual({ template: {} });
  fails = true;
  await expect(provider.request(index, activity)).rejects.toThrow("直连失败夹具");
  for (const endpoint of [
    "https://api-takumi-static.mihoyo.com/event/miyolive/refreshCode",
    "https://bbs-api.mihoyo.com/post/wapi/userPost",
  ]) await expect(provider.request(endpoint, activity)).rejects.toThrow("HTTP 410");
  expect(calls).toHaveLength(4);
  expect(direct).toEqual([index, index]);
  controller.abort();
  await expect(provider.request(index, activity)).rejects.toThrow();
  expect(calls).toHaveLength(4);
  expect(direct).toHaveLength(2);
});

type MockOptions = {
  game?: { uid: string; gids: string; version: string; title: string };
  posts?: readonly object[];
  searchPosts?: readonly object[];
  nav?: readonly object[];
  end?: string;
  codeTip?: string;
  ended?: boolean;
  apiError?: boolean;
  wrongStreamer?: boolean;
  onCodes?: () => void;
};

function officialMock(options: MockOptions = {}) {
  const game = options.game ?? { uid: author, gids: "2", version: "7.2", title };
  const calls: URL[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const target = new URL(url);
    const headers = new Headers(init.headers);
    calls.push(target);
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("omit");
    expect(init.redirect).toBe("error");
    expect(init.body).toBeUndefined();
    expect(headers.has("cookie")).toBe(false);
    expect(headers.has("authorization")).toBe(false);
    expect(target.protocol).toBe("https:");
    const ok = (data: object) => Response.json({ retcode: 0, data });
    switch (target.hostname + target.pathname) {
      case "bbs-api.miyoushe.com/apihub/api/home/new":
        expect(target.searchParams.get("gids")).toBe(game.gids);
        return ok({ navigator: options.nav ?? [{ name: "前瞻特别节目", link: page }] });
      case "bbs-api.mihoyo.com/post/wapi/userPost":
        expect(target.searchParams.get("uid")).toBe(game.uid);
        return ok({ list: (options.posts ?? [recap]).map(post => ({ post })), is_last: true });
      case "bbs-api.mihoyo.com/post/wapi/searchPosts":
        return ok({ posts: (options.searchPosts ?? options.posts ?? [recap]).map(post => ({ post })) });
      case "bbs-api.mihoyo.com/post/wapi/getPostFull":
        return ok({ post: { post: [...(options.posts ?? [recap]), ...(options.searchPosts ?? [])]
          .find(post => "post_id" in post && post.post_id === target.searchParams.get("post_id")) } });
      case "api-takumi.mihoyo.com/event/miyolive/index":
        expect(headers.get("x-rpc-act_id")).toBe(activity);
        if (options.ended) return Response.json({ retcode: -500012 });
        if (options.apiError) return new Response(null, { status: 502 });
        return ok({ streamer: { aid: options.wrongStreamer ? "1" : game.uid },
          live: { title: game.title, start: "2026-10-23 20:00:00", end: options.end, remain: 0, code_ver: "fixture-version" },
          template: JSON.stringify({ codeTipText: options.codeTip ?? "兑换码将于10月26日12:00过期。" }) });
      case "api-takumi-static.mihoyo.com/event/miyolive/refreshCode":
        expect(headers.get("x-rpc-act_id")).toBe(activity);
        expect(target.searchParams.get("version")).toBe("fixture-version");
        expect(target.searchParams.has("time")).toBe(true);
        options.onCodes?.();
        return ok({ code_list: [
          fixtureItems[0], { ...fixtureItems[0], title: "重复条目" }, fixtureItems[1],
          { code: "FUTURE", title: "未发放", to_get_time: expiry / 1000 }, { code: "", title: "空条目" },
        ] });
      default:
        throw new Error(`非公开查码请求 ${url}`);
    }
  };
  return { fetch, calls };
}

function message(msg: string, reply: MessageEvent["reply"] = () => true): MessageEvent {
  return { msg, message: msg, raw_message: msg, post_type: "message", message_type: "group",
    isGroup: true, isPrivate: false, isMaster: false, self_id: 99, user_id: 42, group_id: 77, reply };
}

test("官方明确给出无效期限时暂停取码，仍可采用同版本官帖核实的期限", async () => {
  const codeTip = "兑换码有效期为2026年10月23日20:00:00至2026年11月31日12:00:00。";
  const incomplete = officialMock({ codeTip, posts: [] });
  const service = new RedeemCodeService({ fetch: incomplete.fetch, now: () => start + 1_000 });
  expect(await service.query("gs")).toMatchObject({ status: "expiry-unconfirmed", expiry: null,
    reason: "官方公布的兑换码有效期无法识别，请查看官方活动页。" });
  expect(incomplete.calls.some(url => url.pathname.endsWith("/refreshCode"))).toBe(false);

  const verified = officialMock({ codeTip });
  const withRecap = new RedeemCodeService({ fetch: verified.fetch, now: () => start + 1_000 });
  expect(await withRecap.query("gs")).toMatchObject({ status: "available", expiry: { ms: expiry },
    expirySource: "https://www.miyoushe.com/ys/article/101" });
  expect(verified.calls.some(url => url.pathname.endsWith("/refreshCode"))).toBe(true);
});

test("原神旧别名匿名查询，中文码和奖励分别发送，同次并发共享查询", async () => {
  const mock = officialMock();
  const commands = new CommandRegistry();
  commands.registerModule(redeemCodeCommands({ fetch: mock.fetch, now: () => start + 1000 }));
  const fallback = (msg: string) => commands.dispatchFallback(message(msg), () => true, () => false);
  const [first, second, third] = await Promise.all([
    fallback("#原神兑换码"),
    fallback("  /原神直播CoDe  "),
    fallback("兑换码"),
  ]);
  const nodes = [title, fixtureItems[0]!.code, "模拟原石×100", fixtureItems[1]!.code,
    fixtureItems[1]!.title, "有效期至：2026-10-26 12:00:00（北京时间）", `官方页面：${page}`];
  expect(first).toEqual({ type: "forward", nodes });
  expect(second).toEqual(first);
  expect(third).toEqual(first);
  expect(mock.calls.filter(url => url.pathname.endsWith("/refreshCode"))).toHaveLength(1);

  const relayed: MessageReply[][] = [];
  const ordinary: MessageReply[] = [];
  const event = message("#兑换码", reply => { ordinary.push(reply); return true; });
  await sendCommandReply({ ...event, async forward(nodes) { relayed.push([...nodes]); return true; } }, first!);
  expect(relayed).toEqual([nodes]);
  expect(ordinary).toEqual([]);
  await sendCommandReply(event, second!);
  expect(ordinary).toEqual(nodes);

  expect(await fallback("#原神前瞻兑换码")).toEqual(first);
  expect(mock.calls.filter(url => url.pathname.endsWith("/refreshCode"))).toHaveLength(2);
  const count = mock.calls.length;
  for (const cmd of ["#注册自动兑换前瞻兑换码2", "#兑换码使用", "#兑换码 使用", "#星布谷地公测兑换码2"]) {
    expect(await fallback(cmd)).toBeUndefined();
  }
  expect(mock.calls).toHaveLength(count);
});

test("国际服私聊用法在国服公开转发末尾，码和奖励仍是可单独复制的节点", async () => {
  const mock = officialMock();
  const options = { fetch: mock.fetch, now: () => start + 1_000 };
  const registry = new CommandRegistry();
  registry.registerModule(redeemCodeCommands(options, new RedeemCodeService(options), undefined, async () => undefined));
  const reply = await registry.dispatchFallback(message("#原神兑换码"), () => true, () => false);
  expect(reply).toEqual({ type: "forward", nodes: [
    title, fixtureItems[0]!.code, "模拟原石×100", fixtureItems[1]!.code, fixtureItems[1]!.title,
    "有效期至：2026-10-26 12:00:00（北京时间）", `官方页面：${page}`,
    "以上为国服前瞻码。另有国际服兑换码时，可在机器人好友私聊发送 #兑换码使用 <兑换码>。",
  ] });
});

const additionalGames = [
  { id: "sr", uid: "288909600", gids: "6", version: "4.7", title: "星穹铁道4.7版本前瞻",
    aliases: ["*兑换码", "*前瞻兑换码", "#星铁兑换码", "#崩铁兑换码", "#星穹铁道前瞻兑换码", "#崩坏：星穹铁道直播CoDe"] },
  { id: "zzz", uid: "152039148", gids: "8", version: "3.4", title: "绝区零3.4版本前瞻",
    aliases: ["%兑换码", "％直播兑换码", "#绝区零兑换码", "#绝区前瞻兑换码", "#zzzcode"] },
  { id: "bh3", uid: "73565430", gids: "1", version: "9.1", title: "米游社崩坏3-9.1特别节目",
    aliases: ["#崩三兑换码", "#崩坏三前瞻兑换码", "#崩坏3兑换码"] },
];

for (const game of additionalGames) {
  test(`${game.title}沿用旧指令和官方身份校验，发一条即可转发且按官方时限停止`, async () => {
    const mock = officialMock({ game, posts: [] });
    // 直播还在发码时，公开查询同样显示已发布的部分。
    const fetchOneCode = async (url: string, init: RequestInit) => {
      const response = await mock.fetch(url, init);
      if (!url.includes("/refreshCode")) return response;
      return Response.json({ retcode: 0, data: { code_list: [fixtureItems[0], { code: "", to_get_time: expiry / 1000 }] } });
    };
    let now = start + 1000;
    const commands = new CommandRegistry();
    commands.registerModule(redeemCodeCommands({ fetch: fetchOneCode, now: () => now }));
    const query = (cmd: string) => commands.dispatchFallback(message(cmd), () => true, () => false);
    const results = await Promise.all(game.aliases.map(query));
    for (const result of results) expect(result).toEqual({ type: "forward", nodes: [
      game.title, fixtureItems[0]!.code, "模拟原石×100", "有效期至：2026-10-26 12:00:00（北京时间）", `官方页面：${page}`,
    ] });
    expect(mock.calls.filter(url => url.pathname.endsWith("/refreshCode"))).toHaveLength(1);
    now = expiry;
    const expired = await query(game.aliases[0]!);
    expect(expired).toContain("兑换码已过期");
    expect(expired).not.toContain(fixtureItems[0]!.code);
    expect(mock.calls.filter(url => url.pathname.endsWith("/refreshCode"))).toHaveLength(1);

    const wrong = officialMock({ game, posts: [], wrongStreamer: true });
    const service = new RedeemCodeService({ fetch: wrong.fetch, now: () => start + 1000 });
    expect(await service.query(game.id)).toMatchObject({ status: "unavailable", codes: [] });
    expect(wrong.calls.some(url => url.pathname.endsWith("/refreshCode"))).toBe(false);
  });
}

test("崩坏3 通过官方庆典预告发现特别节目，公告未明确失效时间时只报状态及来源", async () => {
  const game = additionalGames.find(game => game.id === "bh3")!;
  const posts = [{ uid: game.uid, post_id: "103", subject: "【资讯】V9.2更新内容前瞻丨新服装",
    created_at: start / 1000 + 172800 }];
  const searchPosts = [
    { uid: "1", post_id: "104", subject: "【资讯】十周年庆典特别节目预告", link: page.replace(activity, "unofficial") },
    { uid: game.uid, post_id: "105", subject: "【资讯】《崩坏3》十周年庆典特别节目预告",
      created_at: start / 1000 - 172800, content: page },
  ];
  const mock = officialMock({ game, posts, searchPosts, nav: [], end: "2026-10-23 21:30:00", codeTip: "兑换码存在有效期，请及时兑换哦~" });
  const commands = new CommandRegistry();
  commands.registerModule(redeemCodeCommands({ fetch: mock.fetch, now: () => expiry }));
  const reply = await commands.dispatchFallback(message("#崩坏三兑换码"), () => true, () => false);
  expect(reply).toContain("特别节目于 2026-10-23 21:30:00（北京时间）结束。");
  expect(reply).toContain("暂未找到官方公布的兑换码有效期");
  expect(reply).toContain(page);
  expect(reply).not.toContain(fixtureItems[0]!.code);
  expect(mock.calls.filter(url => url.pathname.endsWith("/index"))).toHaveLength(1);
  expect(mock.calls.some(url => url.pathname.endsWith("/refreshCode"))).toBe(false);
});

test("星布谷地公测码开服前按独立节点提示，官方截止时刻起只提示过期", async () => {
  const cutoff = Date.parse("2027-01-03T10:00:00+08:00");
  let now = Date.parse("2026-11-19T20:00:00+08:00");
  let networkCalls = 0;
  const commands = new CommandRegistry();
  commands.registerModule(redeemCodeCommands({ now: () => now, async fetch() {
    networkCalls++;
    throw new Error("固定公测活动不发网络请求");
  } }));
  const query = (cmd: string) => commands.dispatchFallback(message(cmd), () => true, () => false);
  const expected = [
    "《星布谷地》公测前瞻兑换码", "XBGD1204", "奇物海哨×10", "公测开服后可兑换，公测日期：2026年12月4日。",
    "兑换方式：游戏内【设置】—【账号】—【兑换码】，奖励在飞件箱领取。",
    "有效期至：2027-01-03 10:00:00 前（北京时间）",
    "官方页面：https://www.miyoushe.com/planet/article/79270201",
    "有效期来源：https://www.miyoushe.com/planet/article/79269582",
  ];
  expect(await query("#星布谷地公测兑换码")).toEqual({ type: "forward", nodes: expected });
  now = cutoff - 1;
  expect(await query("#星布谷地公测兑换码")).toEqual({ type: "forward", nodes: expected });
  now = cutoff;
  const expired = await query("#星布谷地公测兑换码");
  expect(expired).toContain("本次公测兑换码已过期");
  expect(expired).toContain("2027-01-03 10:00:00 前（北京时间）");
  expect(expired).not.toContain("XBGD1204");
  expect(await query("#星布谷地公测兑换码2")).toBeUndefined();
  expect(networkCalls).toBe(0);
});

test("活动到期与撤页都保留官方到期时间，未知错误独立报告", async () => {
  for (const options of [{}, { ended: true }]) {
    const mock = officialMock(options);
    const commands = new CommandRegistry();
    commands.registerModule(redeemCodeCommands({ fetch: mock.fetch, now: () => expiry }));
    const result = await commands.dispatchFallback(message("#兑换码"), () => true, () => false);
    expect(result).toContain("本次前瞻兑换码已过期");
    expect(result).toContain("2026-10-26 12:00:00（北京时间）");
    expect(result).not.toContain(fixtureItems[0]!.code);
    expect(mock.calls.some(url => url.pathname.endsWith("/refreshCode"))).toBe(false);
  }
  for (const [options, status] of [[{ wrongStreamer: true }, "unavailable"], [{ apiError: true }, "error"]] as const) {
    const mock = officialMock(options);
    const service = new RedeemCodeService({ fetch: mock.fetch, now: () => start + 1000 });
    expect((await service.query("gs")).status).toBe(status);
    expect(mock.calls.some(url => url.pathname.endsWith("/refreshCode"))).toBe(false);
  }
});

test("查询过程中到期也不发送码，新版本官宣阻止读取旧码", async () => {
  let now = expiry - 5;
  const mock = officialMock({ onCodes: () => { now = expiry; } });
  const service = new RedeemCodeService({ fetch: mock.fetch, now: () => now });
  expect(await service.query("gs")).toMatchObject({ status: "expired", codes: [] });

  const announcement = { uid: author, post_id: "102", subject: "《原神》7.3版本前瞻特别节目预告",
    created_at: start / 1000, structured_content: '[{"insert":"前瞻特别节目将于10月25日（本周日）晚上8:00正式开启。"}]' };
  const next = officialMock({ posts: [announcement, recap] });
  expect(await new RedeemCodeService({ fetch: next.fetch, now: () => start + 1000 }).query("gs")).toMatchObject({
    status: "unreleased", version: "7.3", startAt: Date.parse("2026-10-25T20:00:00+08:00"),
    source: "https://www.miyoushe.com/ys/article/102", codes: [],
  });
  const repost = officialMock({ posts: [{ ...announcement, uid: "1" }, recap] });
  expect((await new RedeemCodeService({ fetch: repost.fetch, now: () => start + 1000 }).query("gs")).status).toBe("available");
  expect(next.calls.some(url => url.pathname.endsWith("/refreshCode"))).toBe(false);
});

test("兼容旧活动 ID 文件，重启可恢复活动，且文件不含任何兑换码", async () => {
  const temp = await mkdtemp(join(tmpdir(), "lotus-redeem-preview-"));
  const historyFile = join(temp, "activities.json");
  const now = () => start + 1000;
  try {
    const primary = officialMock();
    const query = new RedeemCodeService({ historyFile, fetch: primary.fetch, now });
    expect((await query.query("gs")).status).toBe("available");
    expect(JSON.parse(await readFile(historyFile, "utf8"))).toEqual({ gs: [activity] });
    await writeFile(historyFile, JSON.stringify({ gs: ["非法 / ID"], sr: ["ea-sr"] }));
    expect((await new RedeemCodeService({ historyFile, fetch: primary.fetch, now }).query("gs")).status).toBe("available");
    expect(JSON.parse(await readFile(historyFile, "utf8"))).toEqual({ gs: [activity], sr: ["ea-sr"] });
    const removed = officialMock({ nav: [], posts: [] });
    const reopened = new RedeemCodeService({ historyFile, fetch: removed.fetch, now });
    expect((await reopened.query("gs")).status).toBe("available");
    expect(primary.calls.concat(removed.calls).filter(url => url.pathname.endsWith("/refreshCode"))).toHaveLength(3);
    expect(await readFile(historyFile, "utf8")).not.toContain(fixtureItems[0]!.code);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("保存活动缓存失败不影响并发游戏查码，磁盘恢复后补存两场活动", async () => {
  const temp = await mkdtemp(join(tmpdir(), "lotus-redeem-cache-retry-"));
  const directory = join(temp, "cache");
  const historyFile = join(directory, "activities.json");
  const discoveringStarRail = Promise.withResolvers<void>();
  const continueStarRail = Promise.withResolvers<void>();
  try {
    await writeFile(directory, "temporarily blocked cache directory");
    const service = new RedeemCodeService({ historyFile, now: () => start + 1_000 });
    const provider = service.providers.miyolive;
    provider.discover = async game => {
      if (game.id === "sr") {
        discoveringStarRail.resolve();
        await continueStarRail.promise;
      }
      const actId = "fixture-" + game.id;
      return { activity: { actId, live: { title: game.name + "7.2前瞻" } },
        posts: [], newestVersion: "7.2", activities: [actId], announcement: null };
    };
    provider.codes = async () => [{ code: "SYNTHETIC", title: "测试奖励" }];
    const starRail = service.query("sr");
    await discoveringStarRail.promise;
    const genshin = await service.query("gs");
    continueStarRail.resolve();
    expect(genshin).toMatchObject({ status: "available", codes: [{ code: "SYNTHETIC" }] });
    expect(await starRail).toMatchObject({ status: "available", codes: [{ code: "SYNTHETIC" }] });
    expect(await readFile(directory, "utf8")).toBe("temporarily blocked cache directory");

    await rm(directory);
    expect((await service.query("gs")).status).toBe("available");
    expect(JSON.parse(await readFile(historyFile, "utf8"))).toEqual({ gs: ["fixture-gs"], sr: ["fixture-sr"] });
  } finally {
    continueStarRail.resolve();
    await rm(temp, { recursive: true, force: true });
  }
});

test("旧安装的前瞻缓存只作发现线索，通过官方作者校验后才写入主缓存", async () => {
  const temp = await mkdtemp(join(tmpdir(), "lotus-redeem-history-"));
  const historyFile = join(temp, "activities.json");
  const unverifiedFile = join(temp, "unverified.json");
  const legacyHistoryFiles = [join(temp, "old.json"), join(temp, "renamed.json")];
  const oldBytes = [JSON.stringify({ gs: [activity, "invalid/id"] }) + "\r\n",
    JSON.stringify({ gs: [activity], sr: ["not-checked"] }) + "\n"];
  try {
    await Promise.all(legacyHistoryFiles.map((path, index) => writeFile(path, oldBytes[index]!)));
    await writeFile(historyFile, JSON.stringify({ sr: ["current-id"] }));
    const options = { historyFile, legacyHistoryFiles, now: () => start + 1_000 };
    const trusted = officialMock({ nav: [], posts: [] });
    expect(await new RedeemCodeService({ ...options, fetch: trusted.fetch }).query("gs")).toMatchObject({ status: "available" });
    expect(trusted.calls.filter(url => url.pathname.endsWith("/index"))).toHaveLength(1);
    expect(JSON.parse(await readFile(historyFile, "utf8"))).toEqual({ sr: ["current-id"], gs: [activity] });
    expect(await Promise.all(legacyHistoryFiles.map(path => readFile(path, "utf8")))).toEqual(oldBytes);

    const wrongAuthor = officialMock({ nav: [], posts: [], wrongStreamer: true });
    expect(await new RedeemCodeService({ ...options, fetch: wrongAuthor.fetch, historyFile: unverifiedFile }).query("gs"))
      .toMatchObject({ status: "unavailable" });
    expect(wrongAuthor.calls.some(url => url.pathname.endsWith("/refreshCode"))).toBe(false);
    expect(await Bun.file(unverifiedFile).exists()).toBe(false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
