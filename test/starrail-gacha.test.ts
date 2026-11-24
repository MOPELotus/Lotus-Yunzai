import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileStore } from "../packages/account/index.ts";
import { createHoyoClient, starRailGachaPools } from "../packages/hoyo-client/index.ts";

const uid = "512345678";
const options = { intervalMs: 0 };
const initial = `
version: 1
user: { qq: "42" }
profile: { id: 2 }
account:
  cookie: "cookie_token=old-cookie;e_hkrpg_token=obsolete-activity"
  stoken: mock-stoken
  stuid: "42"
  game_roles:
    sr: [{ uid: "123456789", region: prod_gf_cn }, { game_uid: "${uid}", game_biz: hkrpg_cn }]
  current_uid: { sr: "${uid}" }
device: { id: fixture-device }
`;

async function withProfile<T>(operation: (profile: Awaited<ReturnType<typeof createFixture>>) => Promise<T>) {
  const folder = await mkdtemp(join(tmpdir(), "lotus-sr-gacha-"));
  try {
    return await operation(await createFixture(folder));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

async function createFixture(folder: string) {
  const file = join(folder, "42-2.yaml");
  await writeFile(file, initial);
  const profiles = createProfileStore(folder);
  const context = await profiles.requestContext("42", 2, "sr");
  return { file, profiles, context };
}

function ok(data: unknown) {
  return Response.json({ retcode: 0, data });
}

function badge() {
  const headers = new Headers();
  headers.append("Set-Cookie", "e_hkrpg_token=activity-token; Path=/; Secure; HttpOnly");
  headers.append("Set-Cookie", "activity_session=fixture; Path=/; Secure");
  return Response.json({ retcode: 0 }, { headers });
}

function emptyResponse(path: string) {
  if (path.endsWith("/account")) return badge();
  if (path.endsWith("/brief")) return ok({ items: [] });
  if (path.endsWith("/pool_stat")) return ok({ cards: [] });
  return ok({ list: [], has_more: false });
}

test("继承荷花星铁官方六池，从档案选定角色并按双游标读取完整五星数据", async () => {
  await withProfile(async ({ context, profiles, file }) => {
    const callOrder: string[] = [];
    const pad = "1735853810000001920";
    const client = createHoyoClient(async (url, init) => {
      expect(init.redirect).toBe("error");
      const headers = new Headers(init.headers);
      const path = url.pathname;
      const pool = url.searchParams.get("gacha_type");
      callOrder.push([path.split("/").at(-1), pool, url.searchParams.get("max_id")].filter(Boolean).join(":"));
      if (path.endsWith("/account")) {
        expect(url.origin).toBe("https://api-takumi.mihoyo.com");
        expect(init.method).toBe("POST");
        expect(JSON.parse(String(init.body))).toEqual({ uid, region: "prod_qd_cn", lang: "zh-cn", game_biz: "hkrpg_cn" });
        expect(headers.get("Cookie")).toBe("cookie_token=old-cookie");
        return badge();
      }
      expect(url.origin).toBe("https://act-api-takumi.mihoyo.com");
      expect(url.searchParams.get("uid")).toBe(uid);
      expect(url.searchParams.get("badge_uid")).toBe(uid);
      expect(url.searchParams.get("region")).toBe("prod_qd_cn");
      expect(headers.get("Cookie")).toContain("e_hkrpg_token=activity-token");
      expect(headers.get("Cookie")).toContain("activity_session=fixture");
      expect(headers.get("x-rpc-device_id")).toBe("fixture-device");
      if (path.endsWith("/brief")) return ok({ version_id: 12, items: [{ item: { item_id: 1001 }, count: "65" }] });
      if (pool === "GachaType_AvatarUp") {
        if (path.endsWith("/pool_stat")) return ok({ cards: [{ gacha_id: 3020, total_count: "65", up_count: 1 }] });
        if (url.searchParams.get("version_id") === "12") {
          expect(url.searchParams.get("max_id")).toBe(pad);
          return ok({ list: [{ uuid: "legacy-id", item: { item_id: 1002 }, gacha_count: 8 }], has_more: false });
        }
        return ok({
          list: [
            { item: null, gacha_count: 4 },
            { id: pad, item: { item_id: 1001 }, is_up: true, time: "2025-01-11 08:00:00", gacha_count: "57" },
          ],
          has_more: true, next_max_id: pad, version_id: "12",
        });
      }
      return emptyResponse(path);
    }, { profiles, async exchange() { throw new Error("不应刷新"); } });

    const result = await client.fetchStarRailGacha(context, options);
    expect(result.uid).toBe(uid);
    expect(result.region).toBe("prod_qd_cn");
    expect(result.refreshedCookie).toBe(false);
    expect(result.revision).toBe(context.revision);
    expect(result.brief).toEqual({ version_id: "12", items: [{ item: { item_id: 1001 }, count: 65 }] });
    expect(result.pools.map<string>((pool) => pool.type)).toEqual(Object.keys(starRailGachaPools));
    expect(result.pools[0]).toMatchObject({
      cards: [{ gacha_id: "3020", total_count: 65, up_count: 1 }],
      fiveStars: [{ id: pad, gacha_count: 57, time: "2025-01-11 08:00:00" }, { uuid: "legacy-id", gacha_count: 8 }],
      pity: 4,
    });
    expect(result.pools[1]).toMatchObject({ cards: [], fiveStars: [], pity: null });
    expect(result.pools[0]?.fiveStars[1]).not.toHaveProperty("is_up");
    expect(callOrder).toEqual(["account", "brief",
      ...Object.keys(starRailGachaPools).flatMap((type) => [
        `pool_stat:${type}`, `five_star_list:${type}`,
        ...(type === "GachaType_AvatarUp" ? [`five_star_list:${type}:${pad}`] : []),
      ]),
    ]);
    expect(await readFile(file, "utf8")).toBe(initial);
    expect(JSON.stringify(result)).not.toContain("activity-token");
  });
});

test("只对明确失效刷新同一档案一次，并从 badge 开始重新拉取", async () => {
  await withProfile(async ({ context, profiles, file }) => {
    let attempts = 0;
    let refreshes = 0;
    const client = createHoyoClient(async (url, init) => {
      const path = url.pathname;
      const cookie = new Headers(init.headers).get("Cookie");
      if (path.endsWith("/account")) {
        attempts++;
        expect(cookie).toBe(`cookie_token=${attempts === 1 ? "old-cookie" : "new-cookie"}`);
      }
      if (attempts === 1 && path.endsWith("/five_star_list")) {
        return Response.json({ retcode: "-100", message: "内部凭据" });
      }
      return emptyResponse(path);
    }, {
      profiles,
      async exchange(current) {
        refreshes++;
        expect([current.qq, current.profileId, current.revision]).toEqual(["42", 2, context.revision]);
        return { ltoken: "mock-ltoken", cookie: "cookie_token=new-cookie" };
      },
    });

    const result = await client.fetchStarRailGacha(context, options);
    expect([attempts, refreshes]).toEqual([2, 1]);
    expect(result.pools).toHaveLength(6);
    expect(result.refreshedCookie).toBe(true);
    expect(result.revision).toBe((await profiles.accountContext("42", 2)).revision);
    expect(await readFile(file, "utf8")).not.toContain("activity-token");
  });
});

test("HTTP 401 明确报告 Cookie 失效时刷新一次，再遇失效保留已交换的档案 Cookie", async () => {
  await withProfile(async ({ context, profiles }) => {
    let attempts = 0;
    let refreshes = 0;
    const client = createHoyoClient(async () => {
      attempts++;
      return Response.json({ retcode: -100, message: "不应透传的详情" }, { status: attempts === 1 ? 401 : 200 });
    }, { profiles, async exchange() {
      refreshes++;
      return { ltoken: "mock-ltoken", cookie: "cookie_token=new-cookie" };
    } });

    await expect(client.fetchStarRailGacha(context, options)).rejects.toMatchObject({
      code: "api", retcode: -100, message: "星铁抽卡接口拒绝请求。",
    });
    expect([attempts, refreshes]).toEqual([2, 1]);
    expect((await profiles.accountContext("42", 2)).account.cookie).toBe("cookie_token=new-cookie");
  });
});

test("拒绝不完整分页、风险和未知网络错误，不把它们当作空数据或登录过期", async () => {
  await withProfile(async ({ context, profiles }) => {
    let mode = "repeat";
    let refreshes = 0;
    const client = createHoyoClient(async (url) => {
      const path = url.pathname;
      if (mode === "403") return Response.json({ retcode: -100 }, { status: 403 });
      if (mode === "401") return new Response(null, { status: 401 });
      if (mode === "401-risk") return Response.json({ retcode: -100, message: "请先完成验证" },
        { status: 401, headers: { "x-rpc-aigis": '{"challenge":"fixture"}' } });
      if (path.endsWith("/five_star_list")) {
        if (mode === "repeat") return ok({ list: [], has_more: true, version_id: "4", next_max_id: "4" });
        if (mode === "incomplete") return ok({ list: [] });
        if (mode === "risk") return Response.json({ retcode: 1034, message: "登录网络未完成" });
        if (mode === "network") throw new Error("包含 cookie_token=测试");
        if (mode === "precision") return ok({
          list: [{ id: Number.MAX_SAFE_INTEGER + 1, item: { item_id: "10" }, gacha_count: 0 }], has_more: false,
        });
      }
      return emptyResponse(path);
    }, { profiles, async exchange() { refreshes++; throw new Error("不应刷新"); } });

    for (const testCase of [
      { mode: "repeat", code: "response" },
      { mode: "incomplete", code: "response" },
      { mode: "precision", code: "response" },
      { mode: "risk", code: "api" },
      { mode: "network", code: "transport" },
      { mode: "403", code: "http" },
      { mode: "401", code: "http" },
      { mode: "401-risk", code: "http" },
    ]) {
      mode = testCase.mode;
      await expect(client.fetchStarRailGacha(context, options)).rejects.toMatchObject({ code: testCase.code });
    }
    expect(refreshes).toBe(0);
  });
});

test("海外角色不发国服请求，调用中换绑后不返回旧档案结果", async () => {
  await withProfile(async ({ context, profiles, file }) => {
    let calls = 0;
    const client = createHoyoClient(async (url) => {
      calls++;
      if (calls === 2) await writeFile(file, initial.replace("mock-stoken", "changed-login"));
      return emptyResponse(url.pathname);
    }, { profiles, async exchange() { throw new Error("不应刷新"); } });
    const overseas = { ...context, role: { ...context.role, uid: "812345678", region: "prod_official_asia" } };
    await expect(client.fetchStarRailGacha(overseas, options)).rejects.toMatchObject({ code: "invalid-input" });
    await expect(client.fetchStarRailGacha({ ...overseas, role: { ...overseas.role, region: "prod_gf_cn" } }, options))
      .rejects.toMatchObject({ code: "invalid-input" });
    expect(calls).toBe(0);
    await expect(client.fetchStarRailGacha(context, options)).rejects.toMatchObject({ code: "profile-changed" });
    expect(calls).toBe(2);
  });
});

test("星铁 HTTP 和业务层限频都保留限频语义，不交换 Cookie 或透传官方返回内容", async () => {
  await withProfile(async ({ context, profiles }) => {
    let result: () => Response = () => new Response(null, { status: 429 });
    let refreshes = 0;
    const client = createHoyoClient(async () => result(), { profiles, async exchange() {
      refreshes++;
      throw Error("限频不能触发凭据刷新");
    } });
    await expect(client.fetchStarRailGacha(context, options)).rejects.toMatchObject({
      code: "http", status: 429, reason: "rate-limited",
    });
    result = () => Response.json({ retcode: -100, message: "visit too frequently, cookie_token=withheld" });
    await expect(client.fetchStarRailGacha(context, options)).rejects.toMatchObject({
      code: "api", status: 200, reason: "rate-limited", message: "官方星铁抽卡查询请求过于频繁，请稍后重试。",
    });
    result = () => Response.json({ retcode: -100, msg: "操作过于频繁" }, { status: 401 });
    await expect(client.fetchStarRailGacha(context, options)).rejects.toMatchObject({
      code: "http", status: 401, reason: "rate-limited",
    });
    expect(refreshes).toBe(0);
  });
});
