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

test("取消旧插件入口立即撤销其 Handler，并清理迟到的初始化回调", async () => {
  const legacy = new LegacyPlugins();
  const controller = new AbortController();
  controller.signal.addEventListener("abort", (event) => event.stopImmediatePropagation());
  const reason = new Error("插件加载超时");
  const initialized = Promise.withResolvers<void>();
  const continueInit = Promise.withResolvers<void>();
  const cleaned = Promise.withResolvers<void>();
  const cleanup: string[] = [];
  let taskReads = 0;
  let afterAbort = true;

  class Healthy extends Plugin {
    init() {
      Handler.add({ key: "fixture.cancel.shared", fn: () => "healthy", priority: 50 });
    }
  }
  class First extends Plugin {
    init() {
      this.addCleanup(() => { cleanup.push("first"); cleaned.resolve(); });
      Handler.add({ key: "fixture.cancel.shared", fn: () => "cancelled", priority: 10 });
    }
  }
  class Slow extends Plugin {
    constructor() {
      super();
      Object.assign(this, { rule: [{ reg: "^#迟到$", fnc: "handle" }] });
    }

    get task() {
      taskReads++;
      return { cron: "* * * * * *", fnc() {} };
    }

    async init() {
      this.addCleanup(() => { cleanup.push("slow"); });
      Handler.add({ key: "fixture.cancel.slow", fn: () => true });
      initialized.resolve();
      await continueInit.promise;
      Handler.add({ key: "fixture.cancel.late", fn: () => true });
      afterAbort = Handler.has("fixture.cancel.late");
      this.addCleanup(() => { cleanup.push("late"); });
    }

    handle() { return true; }
  }

  try {
    expect(await legacy.register({ Healthy }, "healthy")).toBe("loaded");
    const registration = legacy.register({ First, Slow }, "cancelled", undefined, controller.signal);
    const outcome = registration.catch((error: unknown) => error);
    try {
      await initialized.promise;
      expect(await Handler.call("fixture.cancel.shared")).toBe("cancelled");
      expect(Handler.has("fixture.cancel.slow")).toBe(true);

      controller.abort(reason);
      expect(Handler.has("fixture.cancel.slow")).toBe(false);
      expect(await Handler.call("fixture.cancel.shared")).toBe("healthy");
      await cleaned.promise;
      expect(cleanup).toEqual(["slow", "first"]);
    } finally {
      continueInit.resolve();
      expect(await outcome).toBe(reason);
    }
    expect(afterAbort).toBe(false);
    expect(Handler.has("fixture.cancel.late")).toBe(false);
    expect(taskReads).toBe(0);
    expect(await legacy.dispatch(message("#迟到"))).toBe(false);
  } finally {
    await legacy.dispose();
  }
  expect(cleanup).toEqual(["slow", "first", "late"]);
  expect(Handler.has("fixture.cancel.shared")).toBe(false);
});

test("构造过程中取消会立即禁用当前 scope，也阻止其余类实例化", async () => {
  const legacy = new LegacyPlugins();
  const controller = new AbortController();
  const reason = new Error("构造时取消");
  const trace: string[] = [];
  class Cancelled extends Plugin {
    constructor() {
      super();
      Handler.add({ key: "fixture.cancel.constructor", fn: () => true });
      controller.abort(reason);
      expect(Handler.has("fixture.cancel.constructor")).toBe(false);
      Handler.add({ key: "fixture.cancel.constructor", fn: () => true });
      expect(Handler.has("fixture.cancel.constructor")).toBe(false);
      this.addCleanup(() => { trace.push("cleanup"); });
    }

    init() { trace.push("init"); }
  }

  class Untouched extends Plugin {
    constructor() {
      super();
      trace.push("构造");
    }
  }

  try {
    await expect(legacy.register({ Cancelled, Untouched }, "constructor", undefined, controller.signal)).rejects.toBe(reason);
    await expect(legacy.register({ Untouched }, "pre-aborted", undefined, controller.signal)).rejects.toBe(reason);
    expect(trace).toEqual(["cleanup"]);
  } finally {
    await legacy.dispose();
  }
  expect(trace).toEqual(["cleanup"]);
});

test("已完成的旧插件注册仍按正常退出清理", async () => {
  const legacy = new LegacyPlugins();
  const controller = new AbortController();
  let cleanups = 0;
  class Loaded extends Plugin {
    constructor() {
      super();
      Object.assign(this, { rule: [{ reg: "^#正常$", fnc: "handle" }] });
    }

    init() {
      Handler.add({ key: "fixture.cancel.loaded", fn: () => true });
      this.addCleanup(() => { cleanups++; });
    }

    handle() { return true; }
  }

  try {
    expect(await legacy.register({ Loaded }, "loaded", undefined, controller.signal)).toBe("loaded");
    controller.abort();
    expect(await legacy.dispatch(message("#正常"))).toBe(true);
    expect(Handler.has("fixture.cancel.loaded")).toBe(true);
    expect(cleanups).toBe(0);
  } finally {
    await legacy.dispose();
  }
  expect(cleanups).toBe(1);
  expect(Handler.has("fixture.cancel.loaded")).toBe(false);
});
