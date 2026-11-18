import { expect, test } from "bun:test";
import type { CommandContext } from "../lib/commands.ts";
import { createMessageStatistics } from "../lib/message-statistics.ts";

type Counts = Parameters<typeof createMessageStatistics>[0];
type Query = Parameters<Counts["read"]>;

const owner: CommandContext = {
  message_type: "group", self_id: 99, user_id: 42, group_id: 77, isMaster: true,
};
const member: CommandContext = { ...owner, isMaster: false };
const newYear = () => new Date(2026, 0, 1, 0, 30);

function fixture(overrides: Partial<Counts> = {}) {
  const queries: Query[] = [];
  const query = createMessageStatistics({
    available: () => true,
    async read(...args) {
      queries.push(args);
      return { receive: "123", send: "456" };
    },
    ...overrides,
  }, newYear);
  return { query, queries };
}

test("主人默认查询总量、活跃量和当前对象，日桶跨年，月桶和年桶保留本月本年", async () => {
  const { query, queries } = fixture();
  const result = await query("", owner);

  const scopes: Query[1][] = ["total", "user:*", "group:*", "bot:99", "user:42", "group:77"];
  const buckets = ["2026:01:01", "2025:12:31", "2025:12:30", "2026:01", "2026", "total"];
  expect(queries).toEqual(scopes.flatMap((scope) => buckets.map<Query>((bucket) => ["msg", scope, bucket])));
  expect(result).toContain("总消息量\n2026-01-01 收 123 发 456");
  expect(result).toContain("用户量");
  expect(result).toContain("群量");
  expect(result).toContain("机器人 99");
  expect(result).toContain("总计 收 123 发 456");
});

test("主人可按任意参数顺序选择对象、消息类型和合法闰日", async () => {
  const { query, queries } = fixture();
  const result = await query("群 88 日期 2024-02-29  消息\timage 用户 52 机器人 100", owner);

  expect(queries).toEqual([
    ["image", "bot:100", "2024:02:29"],
    ["image", "user:52", "2024:02:29"],
    ["image", "group:88", "2024:02:29"],
  ]);
  expect(result).toContain("image 消息统计");
  expect(result).toContain("群 88\n2024-02-29 收 123 发 456");
});

test("普通用户可以用短日期和消息类型筛选当前范围，私聊仅可查询本人", async () => {
  const { query, queries } = fixture();
  await query("消息 text 日期 0203", member);
  await query("日期 2日", { ...member, message_type: "private" });

  expect(queries).toEqual([
    ["text", "user:42", "2026:02:03"],
    ["text", "group:77", "2026:02:03"],
    ["msg", "user:42", "2026:01:02"],
  ]);
});

test("非主人指定对象和无效参数均在读取计数前拒绝", async () => {
  const { query, queries } = fixture();
  for (const argument of ["用户 42", "群 77", "机器人 99", "消息 text 用户 52"]) {
    expect(await query(argument, member)).toContain("仅当前机器人的主人");
  }
  for (const argument of ["用户", "消息 text 消息 image", "主人 true 群 88"]) {
    expect(await query(argument, owner)).toContain("用法");
  }
  expect(await query("用户 9007199254740992", owner)).toContain("有效的 QQ 或群号");
  expect(await query("群 *", owner)).toContain("有效的 QQ 或群号");
  expect(await query("消息 text:total", owner)).toContain("消息类型无效");
  for (const date of ["20250229", "20260431", "2026-00-01", "0000-01-01"]) {
    expect(await query(`日期 ${date}`, owner)).toContain("日期无效");
  }
  expect(queries).toEqual([]);
});

test("后端不可用和异常返回通用提示，统计值保留数字精度且不回显非数字内容", async () => {
  const offline = fixture({ available: () => false });
  expect(await offline.query("", owner)).toContain("消息统计暂不可用");
  expect(offline.queries).toEqual([]);

  const failed = fixture({ async read() { throw new Error("backend-only details"); } });
  const failure = await failed.query("日期 2026/1/1", owner);
  expect(failure).toContain("消息统计暂不可用");
  expect(failure).not.toContain("backend-only details");

  const partial = fixture({ async read() { return { receive: "9223372036854775807", send: "invalid response" }; } });
  const result = await partial.query("日期 2026年1月1日", { ...member, message_type: "private" });
  expect(result).toContain("2026-01-01 收 9223372036854775807 发 —");
  expect(result).not.toContain("invalid response");
});
