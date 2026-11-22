import { expect, test } from "bun:test";
import { createGroupRankRefresh } from "@lotus-yunzai/account";

test("两份群榜共享并发预算，按各输入顺序保留成功、未展示和失败", async () => {
  const refresh = createGroupRankRefresh(2);
  const signal = new AbortController().signal;
  const permits = new Map(["a", "b", "c", "d"].map(key => [key, Promise.withResolvers<number | undefined>()]));
  const started = new Set<string>();
  const read = async (entry: string) => {
    started.add(entry);
    return permits.get(entry)!.promise;
  };
  const first = refresh(["a", "b", "c"], read, signal);
  const second = refresh(["d"], read, signal);
  await Promise.resolve();
  expect([...started]).toEqual(["a", "b"]);
  permits.get("b")!.resolve(undefined);
  await Bun.sleep(0);
  expect([...started]).toEqual(["a", "b", "d"]);
  permits.get("a")!.resolve(20);
  permits.get("d")!.resolve(18);
  await Bun.sleep(0);
  permits.get("c")!.reject(new Error("上游响应失败"));
  expect(await first).toEqual([{ entry: "a", status: "fresh", value: 20 },
    { entry: "b", status: "not-listed" }, { entry: "c", status: "failed" }]);
  expect(await second).toEqual([{ entry: "d", status: "fresh", value: 18 }]);
});

test("取消等候中的排行榜不会调用来源或占住可用名额", async () => {
  const refresh = createGroupRankRefresh(1);
  const visible = new AbortController();
  const cancelled = new AbortController();
  const permit = Promise.withResolvers<boolean>();
  const first = refresh([1], () => permit.promise, visible.signal);
  let calls = 0;
  const second = refresh([2], async () => { calls++; return true; }, cancelled.signal);
  const reason = new Error("要求中止");
  cancelled.abort(reason);
  expect(await second.catch(error => error)).toBe(reason);
  permit.resolve(true);
  expect(await first).toEqual([{ entry: 1, status: "fresh", value: true }]);
  expect(calls).toBe(0);
  expect(await refresh([3], async () => true, visible.signal)).toEqual([{ entry: 3, status: "fresh", value: true }]);
});
