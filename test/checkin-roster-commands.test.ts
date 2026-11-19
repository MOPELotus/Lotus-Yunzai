import { expect, test } from "bun:test";
import { checkinRosterCommands, type CheckinRosterMember } from "../lib/checkin-roster-commands.ts";
import type { CommandContext } from "../lib/commands.ts";
import { segment } from "../lib/messages.ts";

const own = { message_type: "private", user_id: 51, isMaster: false } as const satisfies CommandContext;
const group = { message_type: "group", self_id: 12, group_id: 700, user_id: 51, isMaster: false } as const satisfies CommandContext;
const schedule = { mode: "inherit", fixedTime: undefined, allowRandom: true } as const;

function profile(qq: number, profileId = 1, enabled = true) {
  return { qq: String(qq), profileId, enabled, loggedIn: true, name: `档 ${qq}/${profileId}`, schedule };
}

function fixture({
  rows = [profile(51), profile(51, 2), profile(52, 1, false), profile(53), profile(99)],
  listMembers = async () => undefined,
  renderFailure = true,
}: {
  readonly rows?: readonly ReturnType<typeof profile>[];
  readonly listMembers?: (context: CommandContext) => Promise<readonly CheckinRosterMember[] | undefined>;
  readonly renderFailure?: boolean;
} = {}, signal = new AbortController().signal) {
  const trace: string[] = [];
  const cards: { title: string; lead: string; lines: readonly string[] }[] = [];
  const png = Buffer.from("fake PNG bytes");
  const roster = checkinRosterCommands({
    profiles: {
      async listCheckinProfiles(qqs) {
        trace.push(qqs ? `scoped ${[...qqs]}` : "global");
        // Deliberately include out-of-scope rows to verify the presentation guard.
        return [...rows];
      },
      async checkinSettings(qq, id) {
        trace.push(`details ${qq}:${id}`);
        return {
          revision: "fixture", enabled: true, loggedIn: true, displayName: "拟造", schedule,
          games: { genshin: { enabled: true, blacklist: [] } },
          communityForums: ["2"], notify: { enabled: true, prefer: "private", fallbackGroups: [] },
        };
      },
    },
    async listMembers(context) {
      trace.push(`live ${context.adapter ?? "onebot"} ${context.self_id} ${context.group_id}`);
      return listMembers(context);
    }, signal,
    async render(title, lead, lines) {
      cards.push({ title, lead, lines });
      if (renderFailure) throw new Error("本机渲染不可用");
      return { png };
    },
  });
  const handler = roster.commands["#签到名单列表"]!;
  return { invoke: (context: CommandContext, argument = "") => handler(argument, context), trace, cards, png };
}

test("主人读全局注册数并保留前 14 个档案，渲染成功返回图片", async () => {
  const rows = [...Array.from({ length: 16 }, (_, i) => profile(i + 50)), profile(70, 1, false)];
  const { invoke, trace, cards, png } = fixture({ rows, renderFailure: false });
  const result = await invoke({ ...group, isMaster: true });
  expect(result).toEqual(segment.image(png));
  expect(trace).toEqual(["global", ...rows.slice(0, 14).map(row => `details ${row.qq}:1`)]);
  expect(cards[0]).toMatchObject({ title: "签到名单", lead: "全局荷花插件 profiles · 16\n当前已注册 profile 如下。" });
  expect(cards[0]?.lines).toHaveLength(14);
});

test("普通私聊只读取本人设置，渲染失败用同一范围的文字输出", async () => {
  const { invoke, trace } = fixture();
  expect(await invoke(own)).toBe([
    "我的签到名单", "QQ 51 · 2", "你已注册的 profile 如下。",
    "P1 · 档 51/1", "已登录 · 社区开 · 原 · inherit",
    "P2 · 档 51/2", "已登录 · 社区开 · 原 · inherit",
  ].join("\n"));
  expect(trace).toEqual(["scoped 51", "details 51:1", "details 51:2"]);
  expect(await invoke(own, "99")).toBe("请直接发送 #签到名单列表。");
  expect(await invoke({ ...own, message_type: "terminal" })).toBe("请从 QQ 会话查看签到名单。");
  expect(trace).toHaveLength(3);
});

test("普通群先查当前适配器成员，去重后按成员汇总，名单外档案从未读取", async () => {
  const { invoke, trace } = fixture({
    async listMembers() {
      return [{ id: 53, name: "群昵称\n" }, { id: 51 }, { id: 52 }, { id: 51 }, { id: 0 }, { id: 2 ** 53 }];
    },
  });
  const result = await invoke({ ...group, adapter: "milky" });
  expect(result).toBe([
    "本群签到名单", "群 700 · 2/3", "本群内已注册自动签到的成员如下。",
    "群昵称 (53)", "1 profile · P1 已登录 · 社区开 · 原 · inherit",
    "群成员 (51)", "2 profile · P1 已登录 · 社区开 · 原 · inherit；P2 已登录 · 社区开 · 原 · inherit",
  ].join("\n"));
  expect(trace).toEqual(["live milky 12 700", "scoped 53,51,52", "details 53:1", "details 51:1", "details 51:2"]);
});

test("群成员无法验证、缺少请求者或查询期间停机时不读档案", async () => {
  const fixed = "无法读取本群成员列表，暂时不能生成群内签到名单。";
  for (const listMembers of [
    async () => undefined,
    async () => { throw new Error("不应回显的远端报错"); },
    async () => [{ id: 53 }],
  ]) {
    const { invoke, trace, cards } = fixture({ listMembers });
    expect(await invoke(group)).toBe(fixed);
    expect(trace).toEqual(["live onebot 12 700"]);
    expect(cards).toEqual([]);
  }
  const controller = new AbortController();
  const { invoke, trace } = fixture({ async listMembers() { controller.abort(); return [{ id: 51 }]; } }, controller.signal);
  expect(await invoke(group)).toBe("");
  expect(trace).toEqual(["live onebot 12 700"]);
});
