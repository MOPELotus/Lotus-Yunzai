import { expect, test } from "bun:test";
import type { MessageEvent } from "../lib/messages.ts";
import Handler from "../lib/plugins/handler.ts";
import { LegacyPlugins } from "../lib/plugins/legacy.ts";
import Plugin from "../lib/plugins/plugin.js";

function message(msg: string): MessageEvent {
  return {
    post_type: "message", message_type: "terminal", msg, raw_message: msg, message: msg,
    isGroup: false, isPrivate: false, isMaster: true, reply: () => true,
  };
}

test("候选在最终验证前不可见，发布保留入口和 Handler 的同优先级位置", async () => {
  const legacy = new LegacyPlugins();
  const key = "fixture.entry.same-priority";
  const trace: string[] = [];
  function version(value: string) {
    return class extends Plugin {
      constructor() {
        super({ priority: 10 });
        Object.assign(this, { rule: [{ reg: "^#规则$", fnc: "ruleHandler" }] });
      }
      init() { Handler.add({ key, fn: () => value }); }
      ruleHandler() { trace.push(value); }
    };
  }

  const inspected = Promise.withResolvers<void>();
  const valid = Promise.withResolvers<boolean>();
  try {
    await legacy.register({ old: version("old") }, "entry");
    await legacy.register({ peer: version("peer") }, "peer");
    const pending = legacy.replace({ next: version("next") }, "entry", undefined, undefined, () => {
      inspected.resolve();
      return valid.promise;
    });
    await inspected.promise;
    expect(await Handler.call(key)).toBe("old");
    expect(await legacy.dispatch(message("#规则"))).toBe(true);
    valid.resolve(true);
    expect(await pending).toBe("loaded");
    expect(await Handler.call(key)).toBe("next");
    expect(await legacy.dispatch(message("#规则"))).toBe(true);
    expect(trace).toEqual(["old", "next"]);
    await legacy.remove("entry");
    expect(await Handler.call(key)).toBe("peer");
    expect(await legacy.dispatch(message("#规则"))).toBe(true);
    expect(trace.at(-1)).toBe("peer");
  } finally {
    valid.resolve(false);
    await legacy.dispose();
  }
});

test("候选空、跳过、定时任务准备失败或最终校验失败都保留旧入口", async () => {
  const legacy = new LegacyPlugins();
  const key = "fixture.entry.keep";
  const cleaned: string[] = [];
  class Old extends Plugin {
    init() { Handler.add({ key, fn: () => "old" }); }
  }
  class Candidate extends Plugin {
    init() {
      Handler.add({ key, fn: () => "candidate", priority: 1 });
      this.addCleanup(() => { cleaned.push(this.constructor.name); });
    }
  }
  class Skipped extends Candidate {
    override init() { super.init(); return "return"; }
  }
  class InvalidJob extends Candidate {
    task = { cron: "invalid", fnc() {} };
  }
  try {
    await legacy.register({ Old }, "entry");
    expect(await legacy.replace({}, "entry")).toBe("empty");
    expect(await legacy.replace({ Skipped }, "entry")).toBe("skipped");
    await expect(legacy.replace({ InvalidJob }, "entry")).rejects.toThrow("需要五段或六段 cron");
    expect(await legacy.replace({ Candidate }, "entry", undefined, undefined, async () => false)).toBe("skipped");
    expect(await Handler.call(key)).toBe("old");
    expect(cleaned).toEqual(["Skipped", "InvalidJob", "Candidate"]);
    expect(await legacy.replace({ Candidate }, "new-entry")).toBe("loaded");
    expect(await Handler.call(key)).toBe("candidate");
  } finally {
    await legacy.dispose();
  }
});

test("替换后停止旧快照后续规则及上下文，等待已进入的命令和 Handler 再逆序清理", async () => {
  const legacy = new LegacyPlugins();
  const key = "fixture.entry.drain";
  const releaseRule = Promise.withResolvers<void>();
  const startedRule = Promise.withResolvers<void>();
  const releaseHandler = Promise.withResolvers<void>();
  const startedHandler = Promise.withResolvers<void>();
  const startedContext = Promise.withResolvers<void>();
  const cleaned: string[] = [];
  let second = false;
  let receivedContext: MessageEvent | false | undefined;
  class Old extends Plugin {
    constructor() {
      super();
      Object.assign(this, { rule: [
        { reg: "^#并发$", fnc: "first" }, { reg: "^#并发$", fnc: "second" }, { reg: "^#等待$", fnc: "wait" },
      ] });
    }
    init() {
      Handler.add({ key, async fn() { startedHandler.resolve(); await releaseHandler.promise; return "old"; } });
      this.addCleanup(() => { cleaned.push("old"); });
    }
    async first() { startedRule.resolve(); await releaseRule.promise; return false; }
    second() { second = true; }
    async wait() { startedContext.resolve(); receivedContext = await this.awaitContext(); }
  }
  class Companion extends Plugin {
    init() { this.addCleanup(() => { cleaned.push("companion"); }); }
  }
  const releaseNext = Promise.withResolvers<void>();
  const startedNext = Promise.withResolvers<void>();
  class Next extends Plugin {
    constructor() {
      super();
      Object.assign(this, { rule: [{ reg: "^#新规则$", fnc: "handle" }] });
    }
    init() { this.addCleanup(() => { cleaned.push("next"); }); }
    async handle() { startedNext.resolve(); await releaseNext.promise; }
  }

  try {
    await legacy.register({ Old, Companion }, "entry");
    const first = legacy.dispatch(message("#并发"));
    const handler = Handler.call(key);
    const context = legacy.dispatch(message("#等待"));
    await Promise.all([startedRule.promise, startedHandler.promise, startedContext.promise]);
    expect(await legacy.replace({ Next }, "entry")).toBe("loaded");
    expect(Handler.has(key)).toBe(false);
    expect(await context).toBe(true);
    expect(receivedContext).toBe(false);
    expect(cleaned).toEqual([]);

    const next = legacy.dispatch(message("#新规则"));
    await startedNext.promise;
    await legacy.remove("entry");
    expect(await legacy.dispatch(message("#新规则"))).toBe(false);
    expect(cleaned).toEqual([]);
    const shutdown = legacy.dispose();
    releaseRule.resolve();
    expect(await first).toBe(false);
    expect(second).toBe(false);
    expect(cleaned).toEqual([]);
    releaseHandler.resolve();
    expect(await handler).toBe("old");
    releaseNext.resolve();
    expect(await next).toBe(true);
    await shutdown;
    expect(cleaned.filter((name) => name !== "next")).toEqual(["companion", "old"]);
    expect(cleaned).toContain("next");
  } finally {
    releaseRule.resolve();
    releaseHandler.resolve();
    releaseNext.resolve();
    await legacy.dispose();
  }
});

test("新替换或移除撤销同一入口正在准备的候选并清理迟到资源", async () => {
  const legacy = new LegacyPlugins();
  const key = "fixture.entry.concurrent";
  const trace: string[] = [];
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  class Slow extends Plugin {
    async init() {
      this.addCleanup(() => { trace.push("early"); });
      Handler.add({ key, fn: () => "stale", priority: 1 });
      entered.resolve();
      await resume.promise;
      Handler.add({ key, fn: () => "late", priority: 1 });
      this.addCleanup(() => { trace.push("late"); });
    }
  }
  class Current extends Plugin {
    init() { Handler.add({ key, fn: () => "current" }); }
  }
  try {
    await legacy.register({ Current }, "entry");
    const stale = legacy.replace({ Slow }, "entry").catch((error: unknown) => error);
    await entered.promise;
    expect(await legacy.replace({ Current }, "entry")).toBe("loaded");
    const validation = Promise.withResolvers<boolean>();
    const validating = Promise.withResolvers<void>();
    const removed = legacy.replace({ Current }, "entry", undefined, undefined, () => {
      validating.resolve();
      return validation.promise;
    }).catch((error: unknown) => error);
    await validating.promise;
    const detach = legacy.remove("entry");
    expect(Handler.has(key)).toBe(false);
    await detach;
    validation.resolve(true);
    resume.resolve();
    expect(await stale).toBeInstanceOf(Error);
    expect(await removed).toBeInstanceOf(Error);
    expect(trace).toEqual(["early", "late"]);
    expect(Handler.has(key)).toBe(false);
  } finally {
    resume.resolve();
    await legacy.dispose();
  }
});

test("内置原生事件与外部 V3 沿用相同优先级与规则权限", async () => {
  const legacy = new LegacyPlugins();
  const trace: string[] = [];
  const identity = Symbol("原生能力");
  const event = Object.defineProperty(message("#群内测试"), identity, { value: "保留" });
  const first = class extends Plugin {
    constructor() { super({ name: "前置旧插件", priority: 5000 }); }
    accept(event: MessageEvent) {
      if (Reflect.get(event, "runtime")) trace.push("前置 V3");
    }
  };
  const last = class extends Plugin {
    constructor() { super({ name: "后置旧插件", priority: 5000 }); }
    accept() { trace.push("后置 V3"); }
  };
  try {
    await legacy.register({ first }, "first");
    const remove = legacy.registerNative([{
      name: "原生群入口", event: "message", priority: 5000,
      observe(native) {
        expect(Reflect.get(native, "runtime")).toBeUndefined();
        expect(Reflect.get(native, identity)).toBe("保留");
        trace.push("原生");
      },
      rule: {
        pattern: /^#群内测试$/u, permission: "master",
        run() { trace.push("原生规则"); },
      },
    }], "group", "@lotus-yunzai/group");
    await legacy.register({ last }, "last");
    expect(await legacy.dispatch(event)).toBe(true);
    expect(trace).toEqual(["前置 V3", "原生", "后置 V3", "原生规则"]);
    trace.length = 0;
    expect(await legacy.dispatch(message("#群内测试"), names => !names.includes("原生群入口"))).toBe(false);
    expect(trace).toEqual(["前置 V3", "后置 V3"]);
    await remove();
  } finally {
    await legacy.dispose();
  }
});
