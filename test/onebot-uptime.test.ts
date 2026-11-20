import { expect, test } from "bun:test";
import { OneBotCalls, type OneBotAction } from "../lib/adapters/onebot-calls.ts";
import { OneBotGroups } from "../lib/adapters/onebot-groups.ts";

function connection(groupId: number) {
  const calls = new OneBotCalls();
  return {
    calls,
    send({ echo }: OneBotAction) {
      calls.receive({ echo, status: "ok", retcode: 0, data: [{ group_id: groupId }] });
      return true;
    },
  };
}

test("OneBot 在线账号按账号排序，以共用的单调时钟计算非负整秒", () => {
  let now = 0;
  const groups = new OneBotGroups(() => now);
  expect(groups.onlineAccounts()).toEqual([]);
  groups.connect(100, connection(77));
  now = 1_650;
  groups.connect(99, connection(78));
  now = 3_250;
  expect(groups.onlineAccounts()).toEqual([{ id: 99, seconds: 1 }, { id: 100, seconds: 3 }]);
  expect(groups.onlineBots()).toEqual([99, 100]);
  now = 1_000;
  expect(groups.onlineAccounts()).toEqual([{ id: 99, seconds: 0 }, { id: 100, seconds: 1 }]);
});

test("同账号替换后重新计时，旧连接关闭不影响新连接与群转发", async () => {
  let now = 2_000;
  const groups = new OneBotGroups(() => now);
  const transport = groups.transport();
  const detachOld = groups.connect(99, connection(77));
  now = 7_250;
  expect(groups.onlineAccounts()).toEqual([{ id: 99, seconds: 5 }]);
  expect(await transport.listGroups(99)).toEqual([{ id: 77, name: undefined }]);

  const detachNew = groups.connect(99, connection(78));
  detachOld();
  expect(groups.onlineAccounts()).toEqual([{ id: 99, seconds: 0 }]);
  expect(transport.onlineBots()).toEqual([99]);
  expect(await transport.listGroups(99)).toEqual([{ id: 78, name: undefined }]);
  now = 11_280;
  expect(groups.onlineAccounts()).toEqual([{ id: 99, seconds: 4 }]);

  detachNew();
  expect(groups.onlineAccounts()).toEqual([]);
  await expect(transport.listGroups(99)).rejects.toThrow("指定机器人未连接 OneBot。");
  now = 20_000;
  groups.connect(99, connection(79));
  expect(groups.onlineAccounts()).toEqual([{ id: 99, seconds: 0 }]);
});

test("按需读取已绑定机器人的昵称，同账号旧回执和其他账号的昵称不可缓存", async () => {
  const groups = new OneBotGroups(() => 0);
  function bind() {
    const calls = new OneBotCalls();
    const frames: OneBotAction[] = [];
    const detach = groups.connect(99, { calls, send(frame) { frames.push(frame); return true; }, ownGroupCardAccount: {
      adapter: "onebot", botId: 99, signal: new AbortController().signal,
      async groups() { return []; }, async updateSelfCard() { return "rejected"; },
    } });
    return { frames, detach, reply(data: { user_id: number; nickname: string }) {
      calls.receive({ echo: frames[0]?.echo, status: "ok", retcode: 0, data });
    } };
  }

  const first = bind();
  expect(first.frames).toEqual([]);
  expect(groups.onlineProfiles()[0]?.nickname).toBeUndefined();
  expect(groups.onlineProfiles()[0]?.nickname).toBeUndefined();
  expect(first.frames).toHaveLength(1);
  expect(first.frames[0]).toMatchObject({ action: "get_login_info", params: {} });

  const second = bind();
  first.reply({ user_id: 99, nickname: "旧连接" });
  second.reply({ user_id: 100, nickname: "其他账号" });
  await Bun.sleep(0);
  expect(groups.onlineProfiles()[0]?.nickname).toBeUndefined();

  const third = bind();
  second.detach();
  third.reply({ user_id: 99, nickname: " 当前昵称 " });
  await Bun.sleep(0);
  expect(groups.onlineProfiles()).toEqual([{ id: 99, startedAt: 0, nickname: "当前昵称" }]);
  expect(third.frames).toHaveLength(1);
  third.detach();
  expect(groups.onlineProfiles()).toEqual([]);
});
