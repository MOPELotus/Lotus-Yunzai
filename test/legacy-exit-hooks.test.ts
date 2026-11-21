import { expect, spyOn, test } from "bun:test";
import { LegacyExitHooks } from "../lib/plugins/exit-hooks.ts";
import { HandlerScope } from "../lib/plugins/handler.ts";

test("遵循重复订阅和逆序移除，隔离报错、卸载与等待超时", async () => {
  const hooks = new LegacyExitHooks(30);
  const discarded = new HandlerScope();
  const active = new HandlerScope();
  const staged = new HandlerScope();
  const bot = {};
  const probe: unknown[] = [];
  hooks.track(discarded);
  hooks.track(staged);
  hooks.track(active);
  const unexpected = () => probe.push("unexpected");
  discarded.run(() => hooks.add("exit", unexpected));
  staged.run(() => hooks.add("exit", unexpected));
  hooks.publish(discarded);
  hooks.discard(discarded);

  active.run(() => {
    const save = async function(this: object, reason: string) {
      await Bun.sleep(10);
      probe.push(this, reason, HandlerScope.current());
    };
    hooks.add("exit", save);
    hooks.add("exit", save);
    hooks.add("exit", save);
    hooks.remove("exit", save);
    hooks.add("exit", unexpected);
    hooks.remove("exit", unexpected);
    hooks.add("online", unexpected);
    hooks.add("exit", () => Promise.reject(new Error("fixture")));
    hooks.add("exit", () => new Promise(() => {}));
  });
  hooks.publish(active);

  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const once = hooks.run(bot, "restart");
    expect(hooks.run(bot, "exit")).toBe(once);
    expect(await once).toBe(true);
    expect(probe).toEqual([bot, "restart", active, bot, "restart", active]);
    expect(warn.mock.calls).toEqual([["[插件] V3 退出回调执行失败。"], ["[插件] 等待 V3 退出回调超时。"]]);
  } finally {
    warn.mockRestore();
  }
});
