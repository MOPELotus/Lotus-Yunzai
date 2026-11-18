import { expect, test } from "bun:test";
import Handler, { HandlerScope } from "../lib/plugins/handler.ts";

test("暂存 Handler 对派发不可见，可在发布前修改或丢弃", async () => {
  const active = new HandlerScope();
  const candidate = new HandlerScope(true);
  const abandoned = new HandlerScope(true);
  try {
    active.add({ key: "fixture.stage.current", ns: "legacy", fn: () => "old" });
    await candidate.run(async () => {
      Handler.add({ key: "fixture.stage.current", ns: "legacy", fn: () => "unused", priority: 20 });
      await Promise.resolve();
      Handler.add({ key: "fixture.stage.current", ns: "legacy", fn: () => "new", priority: 20 });
      Handler.add({ event: "fixture.stage.removed", ns: "temporary", fn: () => true });
      Handler.del("temporary");
    });
    abandoned.add({ key: "fixture.stage.discarded", fn: () => true });
    abandoned.dispose();
    abandoned.publish();

    expect(await Handler.call("fixture.stage.current")).toBe("old");
    expect(Handler.has("fixture.stage.discarded")).toBe(false);

    candidate.publish();
    candidate.publish();
    expect(await Handler.call("fixture.stage.current")).toBe("new");
    expect(Handler.has("fixture.stage.removed")).toBe(false);
    candidate.dispose();
    expect(await Handler.call("fixture.stage.current")).toBe("old");
  } finally {
    active.dispose();
    candidate.dispose();
    abandoned.dispose();
  }
});

test("替换 Handler 保留同优先级顺序并尊重修改后的优先级", async () => {
  const before = new HandlerScope();
  const previous = new HandlerScope();
  const after = new HandlerScope();
  const candidate = new HandlerScope(true);
  const key = "fixture.stage.order";
  const trace: string[] = [];
  try {
    before.add({ key, ns: "other", fn: () => trace.push("before") });
    previous.add({ key, ns: "legacy", fn: () => trace.push("old") });
    after.add({ key, ns: "other", fn: () => trace.push("after") });
    previous.add({ key, ns: "changed", priority: 100, fn: () => trace.push("old-priority") });
    candidate.add({ key, ns: "legacy", fn: () => trace.push("new") });
    candidate.add({ key, ns: "changed", priority: 600, fn: () => trace.push("new-priority") });

    await Handler.callAll(key);
    expect(trace.splice(0)).toEqual(["old-priority", "before", "old", "after"]);

    candidate.publish(previous);
    previous.dispose();
    await Handler.callAll(key);
    expect(trace).toEqual(["before", "new", "after", "new-priority"]);
  } finally {
    for (const scope of [before, previous, after, candidate]) scope.dispose();
  }
});

test("撤销后跳过旧派发快照中未开始的 Handler，等待在途回调完成", async () => {
  const previous = new HandlerScope();
  const candidate = new HandlerScope(true);
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const reject = Promise.withResolvers<void>();
  const failure = new Error("旧回调失败");
  const key = "fixture.stage.drain";
  const trace: string[] = [];
  try {
    previous.add({ key, ns: "old", async fn(_event, _args, next) {
      entered.resolve();
      await finish.promise;
      Handler.add({ key: "fixture.stage.late", fn: () => true });
      next();
      return "old";
    } });
    previous.add({ key, ns: "old-second", fn: () => { trace.push("unexpected"); } });
    previous.add({ key: "fixture.stage.reject", async fn() {
      await reject.promise;
      throw failure;
    } });
    candidate.add({ key, ns: "old", fn: () => "new" });

    const oldCall = Handler.callAll(key);
    const failedCall = Handler.call("fixture.stage.reject").catch((error: unknown) => error);
    await entered.promise;
    candidate.publish(previous);
    previous.dispose();
    let drained = false;
    const retirement = previous.drain().then(() => { drained = true; });
    expect(await Handler.call(key)).toBe("new");
    expect(drained).toBe(false);

    finish.resolve();
    expect(await oldCall).toBe("old");
    expect(drained).toBe(false);
    expect(trace).toEqual([]);
    expect(Handler.has("fixture.stage.late")).toBe(false);

    reject.resolve();
    expect(await failedCall).toBe(failure);
    await retirement;
    expect(drained).toBe(true);
  } finally {
    finish.resolve();
    reject.resolve();
    previous.dispose();
    candidate.dispose();
    await previous.drain();
  }
});
