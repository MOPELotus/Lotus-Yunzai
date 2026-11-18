import { expect, test } from "bun:test";
import { LegacyPlugins } from "../lib/plugins/legacy.ts";
import Plugin from "../lib/plugins/plugin.js";

const path = "/plugin/lifecycle-fixture";
const exclusive = "/plugin/lifecycle-peer";
const isolated = "/plugin/lifecycle-isolated";
const auth = new Headers();

function status(legacy: LegacyPlugins, target = path) {
  return legacy.httpRoutes.handle(new Request(`http://127.0.0.1${target}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  }), auth).then((response) => response?.status);
}

test("旧插件 HTTP 路由在启动与替换时随入口发布，验证拒绝保留旧路由", async () => {
  const legacy = new LegacyPlugins();
  const express = legacy.httpRoutes.express;
  const initialized = Promise.withResolvers<void>();
  const resumeInit = Promise.withResolvers<void>();
  const validating = Promise.withResolvers<void>();
  const decision = Promise.withResolvers<boolean>();

  class First extends Plugin {
    init() {
      express.post(path, (_request, response) => { response.sendStatus(201); });
      initialized.resolve();
      return resumeInit.promise;
    }
  }
  class Next extends Plugin {
    init() { express.post(path, (_request, response) => { response.sendStatus(202); }); }
  }
  class Skipped extends Next {
    override init() { super.init(); return "return"; }
  }

  try {
    const loading = legacy.register({ First }, "entry");
    await initialized.promise;
    expect(await status(legacy)).toBeUndefined();
    resumeInit.resolve();
    expect(await loading).toBe("loaded");
    expect(await status(legacy)).toBe(201);

    const replacement = legacy.replace({ Next }, "entry", undefined, undefined, () => {
      validating.resolve();
      return decision.promise;
    });
    await validating.promise;
    expect(await status(legacy)).toBe(201);
    decision.resolve(false);
    expect(await replacement).toBe("skipped");
    expect(await legacy.replace({ Skipped }, "entry")).toBe("skipped");
    expect(await status(legacy)).toBe(201);

    expect(await legacy.replace({ Next }, "entry")).toBe("loaded");
    expect(await status(legacy)).toBe(202);
  } finally {
    resumeInit.resolve();
    decision.resolve(false);
    await legacy.dispose();
  }
  expect(await status(legacy)).toBeUndefined();
});

test("跨插件路径冲突和取消的候选不会留下暂存路由", async () => {
  const legacy = new LegacyPlugins();
  const express = legacy.httpRoutes.express;
  const cleaned: string[] = [];
  const detach = Promise.withResolvers<void>();
  const lateRegistration = Promise.withResolvers<boolean>();
  class First extends Plugin {
    init() { express.post(path, (_request, response) => { response.sendStatus(201); }); }
  }
  class Peer extends Plugin {
    init() { express.post(exclusive, (_request, response) => { response.sendStatus(202); }); }
  }
  class Conflict extends Plugin {
    init() {
      this.addCleanup(() => { cleaned.push("conflict"); });
      express.post(isolated, (_request, response) => { response.sendStatus(203); });
      express.post(exclusive, (_request, response) => { response.sendStatus(204); });
    }
  }
  class Cancelled extends Plugin {
    init() {
      this.addCleanup(() => { cleaned.push("cancelled"); });
      express.post(isolated, (_request, response) => { response.sendStatus(203); });
      void detach.promise.then(() => {
        try {
          express.post("/plugin/lifecycle-late", (_request, response) => { response.sendStatus(204); });
          lateRegistration.resolve(false);
        } catch {
          lateRegistration.resolve(true);
        }
      });
    }
  }
  class Broken extends Plugin {
    constructor() {
      super();
      express.post(isolated, (_request, response) => { response.sendStatus(203); });
    }
  }

  const valid = Promise.withResolvers<boolean>();
  const validating = Promise.withResolvers<void>();
  const controller = new AbortController();
  const reason = new Error("fixture abort");
  try {
    await legacy.register({ First }, "first");
    await legacy.register({ Peer }, "peer");
    await expect(legacy.replace({ Broken }, "first")).rejects.toThrow("须在旧插件初始化期间调用");
    await expect(legacy.replace({ Conflict }, "first")).rejects.toThrow();
    expect(cleaned).toEqual(["conflict"]);
    expect(await status(legacy, isolated)).toBeUndefined();

    const replacement = legacy.replace({ Cancelled }, "first", undefined, controller.signal, () => {
      validating.resolve();
      return valid.promise;
    }).catch((error: unknown) => error);
    await validating.promise;
    detach.resolve();
    expect(await lateRegistration.promise).toBe(true);
    controller.abort(reason);
    valid.resolve(true);
    expect(await replacement).toBe(reason);
    expect(cleaned).toEqual(["conflict", "cancelled"]);
    expect(await status(legacy)).toBe(201);
    expect(await status(legacy, exclusive)).toBe(202);
    expect(await status(legacy, isolated)).toBeUndefined();
  } finally {
    detach.resolve();
    valid.resolve(false);
    await legacy.dispose();
  }
});

test("入口立刻停止接收 HTTP 请求，清理等待已经开始的回调", async () => {
  const legacy = new LegacyPlugins();
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const trace: string[] = [];
  class Slow extends Plugin {
    init() {
      this.addCleanup(() => { trace.push("cleaned"); });
      legacy.httpRoutes.express.post(path, async (_request, response) => {
        entered.resolve();
        await finish.promise;
        trace.push("served");
        response.sendStatus(201);
      });
    }
  }

  try {
    await legacy.register({ Slow }, "slow");
    const handling = status(legacy);
    await entered.promise;
    await legacy.remove("slow");
    expect(await status(legacy)).toBeUndefined();
    expect(trace).toEqual([]);
    const shutdown = legacy.dispose();
    finish.resolve();
    expect(await handling).toBe(201);
    await shutdown;
    expect(trace).toEqual(["served", "cleaned"]);
  } finally {
    finish.resolve();
    await legacy.dispose();
  }
});
