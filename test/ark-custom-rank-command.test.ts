import { expect, test } from "bun:test";
import { createArkCustomRankSessions, type ArkCustomRankQuery } from "../lib/ark-custom-rank.ts";
import { createArkRankCommand, matchArkRankCommand, parseArkRankFilters } from "../lib/ark-custom-rank-command.ts";

const queryId = "12345678901234567890123456789012";
const receipt = () => ({ user_id: 99, message: [] });
const signal = new AbortController().signal;
const group = { message_type: "group", self_id: 99, group_id: 88, user_id: 42,
  lookupReply: async () => receipt(), groupActivitySignal: signal } as const;
const image = { type: "image", file: Uint8Array.of(1) } as const;
const character = { id: 1102, name: "希儿" };
const rows = [{ uid: "12****678", talent: { a: 10 }, sets: { "繁星璀璨的天才": 4 }, damage: 0, score: 335 }];
function ranking(message: string) {
  const command = matchArkRankCommand(message);
  expect(command?.type).toBe("rank");
  if (command?.type !== "rank") throw new Error("expected rank");
  return command;
}

test("旧命令及规范化原铁前缀保留筛选、数量与各种排名指标", () => {
  expect(parseArkRankFilters(ranking("#ark胡桃排行 cons=0"), "gs")).toEqual({
    name: "胡桃", count: 20, filters: [{ field: "cons", operator: 1, value: 0 }], filterText: "cons=0",
  });
  expect(parseArkRankFilters(ranking("*自定义希儿遗器排名 命座<=2 部位4=速度 数量:100"), "sr")).toMatchObject({
    name: "希儿", count: 50, filters: [{ field: "cons", operator: 2, value: 2 }, { field: "pos4", operator: 1, value: 4 }],
  });
  expect(ranking("#星铁自定义希儿伤害排行").metric).toBe("damage");
  expect(ranking("#原神自定义胡桃圣遗物排行").metric).toBe("artifacts");
  expect(parseArkRankFilters(ranking("#ark胡桃排行 部位4=速度"), "gs")).toContain("不支持");
  expect(parseArkRankFilters(ranking("*自定义希儿排行 部位4=暴击"), "sr")).toContain("没有这个主词条");
  expect(parseArkRankFilters(ranking("*自定义希儿排行 sort:asc"), "sr")).toContain("降序");
  expect(matchArkRankCommand("#ark获取面板20")).toMatchObject({ type: "panel", rank: 20 });
  expect(matchArkRankCommand("#ark自定义排行帮助")).toMatchObject({ type: "help" });
  for (const ignored of ["#胡桃排名", "#群内胡桃排名", "#希儿排名统计", "#绝区零自定义安比排行"]) {
    expect(matchArkRankCommand(ignored)).toBeUndefined();
  }
});

test("榜单只根据实际回执绑定同协议、Bot 和会话，第 1–20 名与已显示 UID 联动", async () => {
  let now = 0;
  const sessions = createArkCustomRankSessions(() => now);
  const queries: ArkCustomRankQuery[] = [];
  const panels: { readonly id: string; readonly index: number; readonly token?: string }[] = [];
  const run = createArkRankCommand("sr", signal, {
    async resolveCharacter(name) { return character.name === name ? character : undefined; },
    async renderRank(_character, model) { expect(model.rows).toEqual(rows); return image; },
    async renderPanel(_character, uid, snapshot) {
      expect(uid).toBe("12****678");
      expect(snapshot).toEqual({ uid: "12@@@@678" });
      return image;
    },
  }, {
    async fetchRank(input, _signal, token) { expect(token).toBeUndefined(); queries.push(input); return { queryId, rows }; },
    async fetchPanel(id, index, _signal, token) { panels.push({ id, index, token }); return { snapshot: { uid: "12@@@@678" } }; },
    async readToken() { throw new Error("普通公榜不得读取高级凭据"); },
    sessions,
  });
  const list = await run(ranking("*自定义希儿排行 命=0"), group);
  expect(queries).toHaveLength(1);
  if (!list || typeof list !== "object" || !("type" in list) || list.type !== "delivery") throw new Error("missing delivery");
  const request = matchArkRankCommand("#ark获取面板1")!;
  const same = { ...group, reply_id: 11 };
  expect(await run(request, same)).toContain("请引用");
  await list.onDelivered(11);
  expect(await run(request, { ...same, group_id: 87 })).toContain("请引用");
  expect(await run(request, { ...same, adapter: "milky" })).toContain("请引用");
  expect(await run(request, { ...same, self_id: 98 })).toContain("请引用");
  expect(await run(request, { ...same, lookupReply: async () => ({ ...receipt(), user_id: 43 }) })).toContain("无法确认");
  expect(await run(matchArkRankCommand("*排行面板2")!, same)).toContain("没有对应名次");
  expect(await run(matchArkRankCommand("*排行面板21")!, same)).toContain("1–20");
  expect(await run(request, { ...same, user_id: 43 })).toEqual(image);
  expect(panels).toEqual([{ id: queryId, index: 0, token: undefined }]);
  now += 300_000;
  expect(await run(request, same)).toContain("请引用");
});

test("仅本机器人当前主人可用高级筛选，其他群成员不能借引用使用现有凭据", async () => {
  const sessions = createArkCustomRankSessions();
  const tokens: (string | undefined)[] = [];
  const command = createArkRankCommand("sr", signal, {
    async resolveCharacter() { return character; }, async renderRank() { return image; }, async renderPanel() { return image; },
  }, {
    async fetchRank(_query, _signal, token) { tokens.push(token); return { queryId, rows }; },
    async fetchPanel(_id, _index, _signal, token) { tokens.push(token); return { snapshot: {} }; },
    async readToken() { return "synthetic-token"; }, sessions,
  });
  const owner = { ...group, isBotMaster: (id: number) => id === 42 };
  const rank = ranking("*自定义希儿排行 部位4=速度");
  expect(await command(rank, group)).toContain("主人");
  expect(await command(rank, { ...owner, isDelegated: true })).toContain("直接操作");
  const list = await command(rank, owner);
  if (!list || typeof list !== "object" || !("type" in list) || list.type !== "delivery") throw new Error("missing delivery");
  await list.onDelivered(11);
  const pick = matchArkRankCommand("*排行面板1")!;
  expect(await command(pick, { ...owner, reply_id: 11, user_id: 43 })).toContain("请引用");
  expect(await command(pick, { ...owner, reply_id: 11, isBotMaster: () => false })).toContain("主人");
  expect(await command(pick, { ...owner, reply_id: 11 })).toEqual(image);
  expect(tokens).toEqual(["synthetic-token", "synthetic-token"]);
});

test("榜单连接失效后丢弃在途回复以及稍后到达的发送回执", async () => {
  const connection = new AbortController();
  const late = new AbortController();
  const sessions = createArkCustomRankSessions();
  let calls = 0;
  const run = createArkRankCommand("sr", signal, {
    async resolveCharacter() { return character; }, async renderRank() { return image; }, async renderPanel() { return image; },
  }, {
    async fetchRank(_query, active) {
      if (++calls === 1) {
        connection.abort();
        expect(active.aborted).toBe(true);
      }
      return { queryId, rows };
    }, sessions,
  });
  const intent = ranking("*自定义希儿排行");
  expect(await run(intent, { ...group, groupActivitySignal: connection.signal })).toBeUndefined();
  const list = await run(intent, { ...group, groupActivitySignal: late.signal });
  if (!list || typeof list !== "object" || !("type" in list) || list.type !== "delivery") throw new Error("missing delivery");
  late.abort();
  await list.onDelivered(11);
  expect(sessions.find({ ...group, reply_id: 11 })).toBeUndefined();
});
