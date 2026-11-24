import { expect, spyOn, test } from "bun:test";
import type { ProfileRequestContext } from "@lotus-yunzai/account";
import { requestGenshinCalculator, requestStarRailCalculator } from "../packages/hoyo-client/genshin-backpack.ts";
import { createHoyoClient, HoyoRequestError, readGameRecordPayload } from "../packages/hoyo-client/index.ts";

const base = {
  qq: "42", profileId: 2, revision: "fixture-revision",
  account: {
    cookie: "ltuid=12; ltoken=fixture-cookie", stuid: "", ltuid: "12", stoken: "",
    ltoken: "fixture-cookie", stokenCookie: "", mid: "",
  },
  device: { id: "fixture-device", fp: "fixture-fp", name: "Test", model: "fixture-UA", androidVersion: "13", raw: {} },
};

function profile(game: ProfileRequestContext["game"], uid: string, region: string, gameBiz: string): ProfileRequestContext {
  return { ...base, game, role: { uid, nickname: "fixture-nickname", region, gameBiz, chosen: false } };
}

const gs = profile("gs", "100000123", "cn_gf01", "hk4e_cn");
const sr = profile("sr", "100000124", "prod_gf_cn", "hkrpg_cn");
const zzz = profile("zzz", "12345678", "prod_gf_cn", "nap_cn");

function failureStream(code: string) {
  return new Response(new ReadableStream({
    pull(controller) {
      controller.error(Object.assign(new Error("https://other.invalid/fixture-error"), { code }));
    },
  }), { headers: { "content-type": "application/json; charset=UTF-8" } });
}

test("国服三游战绩、星铁独立挑战和签到角色读取共享脱敏 HTTP 诊断", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const client = createHoyoClient(async () => new Response("fixture-remote-body", {
      status: 410,
      headers: {
        "content-type": "Text/Html; profile=fixture-header",
        "x-request-id": "request-Abc123",
        "x-trace-id": "100000123",
        "x-rpc-request_id": "account100000123",
        "cf-ray": "fixture-ray-NRT",
        "x-rpc-device-id": "fixture-device",
        "set-cookie": "fixture-response-cookie",
      },
    }));
    const outcome = await Promise.allSettled([
      client.fetchGenshinPersonalRecord(gs, { includeRoster: false }),
      client.fetchGenshinCharacterList(gs),
      client.fetchStarRailPersonalRecord(sr),
      client.fetchStarRailChallenge(sr, { kinds: ["hall"], period: "current", simple: false }),
      client.fetchZzzGameRecord(zzz),
      client.fetchCheckinRoles(gs, "gs"),
      client.fetchCheckinRoles(sr, "sr"),
      client.fetchCheckinRoles(zzz, "zzz"),
      client.fetchRoleCatalog(gs),
    ]);
    expect(outcome).toHaveLength(9);
    for (const item of outcome) {
      expect(item.status).toBe("rejected");
      if (item.status !== "rejected") continue;
      expect(item.reason).toBeInstanceOf(HoyoRequestError);
      expect(item.reason).toMatchObject({ code: "http", status: 410 });
    }

    expect(warn.mock.calls.map(([, event]) => (event as { route: string }).route).sort()).toEqual([
      "/binding/api/getUserGameRolesByCookie",
      "/binding/api/getUserGameRolesByCookie",
      "/binding/api/getUserGameRolesByCookie",
      "/binding/api/getUserGameRolesByCookie",
      "/event/game_record_zzz/api/zzz/index",
      "/game_record/app/genshin/api/character/list",
      "/game_record/app/genshin/api/index",
      "/game_record/app/hkrpg/api/challenge",
      "/game_record/app/hkrpg/api/index",
    ]);
    for (const [prefix, event] of warn.mock.calls) {
      expect(prefix).toBe("[米游社 HTTP]");
      const { route } = event as { route: string };
      expect(event).toEqual({
        route, method: route === "/game_record/app/genshin/api/character/list" ? "POST" : "GET", stage: "http", elapsedMs: expect.any(Number), status: 410,
        contentType: "text/html", requestIds: { "x-request-id": "request-Abc123", "cf-ray": "fixture-ray-NRT" },
      });
    }
  } finally {
    warn.mockRestore();
  }
});

test("连接失败、流断开和无效 JSON 保留各自原返回", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const connection = createHoyoClient(async () => {
      throw new Error("fixture-error", { cause: { code: "ECONNRESET", message: "fixture-cause" } });
    });
    const stream = createHoyoClient(async () => failureStream("fixture-secret-code"));
    const invalid = createHoyoClient(async () => new Response("fixture-invalid-json"));
    await expect(connection.fetchCheckinRoles(gs, "gs")).rejects.toMatchObject({ code: "transport" });
    await expect(stream.fetchCheckinRoles(gs, "gs")).rejects.toMatchObject({ code: "response" });
    await expect(invalid.fetchCheckinRoles(gs, "gs")).rejects.toMatchObject({ code: "response" });
    expect(warn.mock.calls.map(([, event]) => event)).toEqual([
      { route: "/binding/api/getUserGameRolesByCookie", method: "GET", stage: "connection",
        status: null, networkCode: "ECONNRESET", elapsedMs: expect.any(Number) },
      { route: "/binding/api/getUserGameRolesByCookie", method: "GET", stage: "stream",
        status: 200, contentType: "application/json", networkCode: "NETWORK_ERROR", elapsedMs: expect.any(Number) },
    ]);
  } finally {
    warn.mockRestore();
  }
});

test("取消不记网络异常，已报告 HTTP 错误不重复记录流异常", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const stop = new AbortController();
    const cancelled = createHoyoClient(async (_url, init) => {
      stop.abort();
      init.signal?.throwIfAborted();
      throw new Error("expected cancellation");
    });
    await expect(cancelled.fetchCheckinRoles(gs, "gs", stop.signal)).rejects.toMatchObject({ code: "transport" });
    expect(warn).not.toHaveBeenCalled();

    const unauthorized = createHoyoClient(async () => new Response(failureStream("ECONNRESET").body, { status: 401 }));
    await expect(unauthorized.fetchCheckinRoles(gs, "gs")).rejects.toMatchObject({ code: "http", status: 401 });
    expect(warn.mock.calls.map(([, event]) => event)).toEqual([
      { route: "/binding/api/getUserGameRolesByCookie", method: "GET", stage: "http", status: 401, elapsedMs: expect.any(Number) },
    ]);
  } finally {
    warn.mockRestore();
  }
});

test("诊断日志同步或异步失败不改变返回，流诊断回调失败仍返回原解析结果", async () => {
  const warn = spyOn(console, "warn").mockImplementationOnce(() => {
    throw new Error("sync");
  }).mockImplementationOnce(() => Promise.reject(new Error("async")));
  try {
    const failed = createHoyoClient(async () => new Response("", { status: 410 }));
    await expect(failed.fetchCheckinRoles(gs, "gs")).rejects.toMatchObject({ code: "http", status: 410 });
    await expect(failed.fetchCheckinRoles(gs, "gs")).rejects.toMatchObject({ code: "http", status: 410 });
    expect(warn).toHaveBeenCalledTimes(2);

    const signal = new AbortController().signal;
    expect(await readGameRecordPayload(failureStream("ECONNRESET"), 1024, signal, () => {
      throw new Error("sync");
    })).toBeUndefined();
    expect(await readGameRecordPayload(failureStream("ECONNRESET"), 1024, signal, async () => {
      throw new Error("async");
    })).toBeUndefined();
  } finally {
    warn.mockRestore();
  }
});

test("官方绑定角色只接受原请求 URL 的直接回包", async () => {
  const payload = { retcode: 0, data: { list: [{ game_biz: "hk4e_cn", game_uid: gs.role.uid, region: gs.role.region }] } };
  const redirects = [
    { redirected: true },
    { redirected: false, url: "https://api-takumi.mihoyo.com/binding/api/unrelated" },
  ];
  for (const injected of redirects) {
    const client = createHoyoClient(async (url, options) => {
      expect(options.redirect).toBe("error");
      const response = Response.json(payload);
      Object.defineProperties(response, {
        redirected: { value: injected.redirected },
        url: { value: injected.url ?? url.href },
      });
      return response;
    });
    await expect(client.fetchCheckinRoles(gs, "gs")).rejects.toMatchObject({ code: "http", status: 200 });
  }

  const direct = createHoyoClient(async (url) => {
    const response = Response.json(payload);
    Object.defineProperty(response, "url", { value: url.href });
    return response;
  });
  expect(await direct.fetchCheckinRoles(gs, "gs")).toMatchObject([{ uid: gs.role.uid }]);
});

test("原会话在角色目录返回后复核途中取消，不提交报表状态", async () => {
  const client = createHoyoClient(async () => Response.json({ retcode: 0, data: { list: [] } }));
  const controller = new AbortController();
  let verified = 0;
  await expect(client.checkLoginCookie(gs, {
    signal: controller.signal,
    async verifyReadOnly() {
      if (++verified === 2) controller.abort();
    },
  })).rejects.toMatchObject({ name: "AbortError" });
  expect(verified).toBe(2);
});

test("原神与星铁已接只读计算在 HTTP 失败时只记录固定路径、方法和非敏感诊断", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const query = new URLSearchParams({ share_code: "700000070001", region: "cn_gf01" });
    const body = JSON.stringify({ private: "fixture-body" });
    const request = async (url: URL) => {
      expect(url.origin).toBe("https://api-takumi.mihoyo.com");
      return new Response("fixture-secret-body", { status: 410, headers: {
        "content-type": "application/json; response=fixture-private",
        "x-request-id": "fixture-trace-abc", "x-trace-id": "role100000123",
      } });
    };
    for (const task of [
      () => requestGenshinCalculator(gs, request, "原神背包", "v3/batch_compute", { body }),
      () => requestGenshinCalculator(gs, request, "尘歌壶模数", "v1/furniture/blueprint", { query }),
      () => requestGenshinCalculator(gs, request, "尘歌壶模数", "v1/furniture/compute", { body }),
      () => requestStarRailCalculator(sr, request, "avatar/detail", { query }),
      () => requestStarRailCalculator(sr, request, "compute", { body }),
    ]) await expect(task()).rejects.toMatchObject({ code: "http", status: 410 });

    const events = warn.mock.calls.map(([, event]) => event);
    expect(events).toEqual([
      ["/event/e20200928calculate/v3/batch_compute", "POST"],
      ["/event/e20200928calculate/v1/furniture/blueprint", "GET"],
      ["/event/e20200928calculate/v1/furniture/compute", "POST"],
      ["/event/rpgcalc/avatar/detail", "GET"],
      ["/event/rpgcalc/compute", "POST"],
    ].map(([route, method]) => ({ route, method, elapsedMs: expect.any(Number), stage: "http", status: 410,
      contentType: "application/json", requestIds: { "x-request-id": "fixture-trace-abc" },
    })));
  } finally {
    warn.mockRestore();
  }
});

test("只读计算连接与流的错误保持原分类，普通坏回包和主动取消不误记", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  const call = (transport: Parameters<typeof requestStarRailCalculator>[1], signal?: AbortSignal) =>
    requestStarRailCalculator(sr, transport, "compute", { body: "{}", signal });
  try {
    await expect(call(async () => { throw Object.assign(new Error("fixture-private-url"), { code: "ECONNREFUSED" }); }))
      .rejects.toMatchObject({ code: "transport" });
    await expect(call(async () => failureStream("UND_ERR_SOCKET"))).rejects.toMatchObject({ code: "response" });
    await expect(call(async () => new Response("fixture-invalid-json"))).rejects.toMatchObject({ code: "response" });
    const controller = new AbortController();
    await expect(call(async () => {
      controller.abort();
      return new Response("fixture-cancelled", { status: 410 });
    }, controller.signal)).rejects.toMatchObject({ code: "transport" });
    const events = warn.mock.calls.map(([, event]) => event);
    expect(events).toEqual([
      { stage: "connection", networkCode: "ECONNREFUSED", status: null },
      { stage: "stream", networkCode: "UND_ERR_SOCKET", status: 200, contentType: "application/json" },
    ].map(detail => ({ route: "/event/rpgcalc/compute", method: "POST", elapsedMs: expect.any(Number), ...detail })));
  } finally {
    warn.mockRestore();
  }
});
