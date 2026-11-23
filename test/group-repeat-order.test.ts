import { expect, test } from "bun:test";
import { createGroupRepeatOrder } from "../lib/group-repeat-order.ts";

test("复读按群入站排序，命令和下一轮观察不等待先前的媒体发送", async () => {
  const order = createGroupRepeatOrder(new AbortController().signal);
  const moderation = Promise.withResolvers<void>();
  const sending = Promise.withResolvers<void>();
  const transitions: [string, number | undefined][] = [];
  function observe(group: number, suffix: string, work?: Promise<void>) {
    const operation = order.observe(group, async (at) => {
      transitions.push([suffix, at]);
      await work;
    });
    if (!operation) throw new Error("缺少群复读预约");
    return operation;
  }

  let firstObservation: Promise<void> | undefined;
  const first = order.dispatch(77, async () => {
    await moderation.promise;
    firstObservation = observe(77, "第一条", sending.promise);
  });
  let secondObservation: Promise<void> | undefined;
  const second = order.dispatch(77, async () => {
    secondObservation = observe(77, "第二条");
    return "命令照常执行";
  });
  expect(await second).toBe("命令照常执行");

  let independent: Promise<void> | undefined;
  await order.dispatch(78, async () => { independent = observe(78, "另一群"); });
  await independent;
  expect(transitions.map(([label]) => label)).toEqual(["另一群"]);

  moderation.resolve();
  await first;
  await secondObservation;
  expect(transitions.map(([label]) => label)).toEqual(["另一群", "第一条", "第二条"]);
  expect(transitions[1]![1]).toBeLessThanOrEqual(transitions[2]![1]!);
  sending.resolve();
  await firstObservation;
});

test("较早消息未进入观察或处理失败时仍放行，停机释放未完成的预约", async () => {
  const lifecycle = new AbortController();
  const order = createGroupRepeatOrder(lifecycle.signal);
  const firstGate = Promise.withResolvers<void>();
  const first = order.dispatch(77, async () => {
    await firstGate.promise;
    throw new Error("故意中止事件");
  });
  let nextObservation: Promise<void> | undefined;
  const observed: string[] = [];
  await order.dispatch(77, async () => {
    nextObservation = order.observe(77, async () => { observed.push("可观察"); });
  });
  firstGate.resolve();
  await expect(first).rejects.toThrow("故意中止事件");
  await nextObservation;
  expect(observed).toEqual(["可观察"]);

  const stalled = Promise.withResolvers<void>();
  const third = order.dispatch(77, () => stalled.promise);
  let stopped: Promise<void> | undefined;
  await order.dispatch(77, async () => {
    stopped = order.observe(77, async () => { observed.push("关机后不执行"); });
  });
  lifecycle.abort();
  await stopped;
  expect(observed).toEqual(["可观察"]);
  stalled.resolve();
  await third;
});
