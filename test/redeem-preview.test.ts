import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RedeemCodeService } from "@lotus-yunzai/hoyo-client/redeem-preview";
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

type MockOptions = {
  posts?: readonly object[];
  nav?: readonly object[];
  ended?: boolean;
  apiError?: boolean;
  wrongStreamer?: boolean;
  onCodes?: () => void;
};

function officialMock(options: MockOptions = {}) {
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
        return ok({ navigator: options.nav ?? [{ name: "前瞻特别节目", link: page }] });
      case "bbs-api.mihoyo.com/post/wapi/userPost":
        expect(target.searchParams.get("uid")).toBe(author);
        return ok({ list: (options.posts ?? [recap]).map(post => ({ post })), is_last: true });
      case "bbs-api.mihoyo.com/post/wapi/searchPosts":
        return ok({ posts: (options.posts ?? [recap]).map(post => ({ post })) });
      case "bbs-api.mihoyo.com/post/wapi/getPostFull":
        return ok({ post: { post: (options.posts ?? [recap]).find(post => "post_id" in post && post.post_id === target.searchParams.get("post_id")) } });
      case "api-takumi.mihoyo.com/event/miyolive/index":
        expect(headers.get("x-rpc-act_id")).toBe(activity);
        if (options.ended) return Response.json({ retcode: -500012 });
        if (options.apiError) return new Response(null, { status: 502 });
        return ok({ streamer: { aid: options.wrongStreamer ? "1" : author },
          live: { title, start: "2026-10-23 20:00:00", remain: 0, code_ver: "fixture-version" },
          template: JSON.stringify({ codeTipText: "兑换码将于10月26日12:00过期。" }) });
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
  for (const cmd of ["*兑换码", "%直播兑换码", "％code", "#星铁兑换码", "#绝区零兑换码",
    "#注册自动兑换前瞻兑换码2", "#兑换码使用", "#兑换码 使用", "#星布谷地公测兑换码"]) {
    expect(await fallback(cmd)).toBeUndefined();
  }
  expect(mock.calls).toHaveLength(count);
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
