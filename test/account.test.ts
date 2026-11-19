import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { accountCommands } from "../lib/account-commands.ts";
import { CommandRegistry } from "../lib/commands.ts";
import { readAccountRefreshPermission } from "../lib/permissions.ts";
import { createProfileStore, importProfiles } from "../packages/account/index.ts";
import { createCredentialExchange, createHoyoClient, createProfileHoyoClient } from "../packages/hoyo-client/index.ts";

test("扩展签到目录保留同 UID 的不同官服，忽略渠道和测试服", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-checkin-role-catalog-"));
  try {
    await writeFile(join(root, "42.yaml"), "account: { cookie: fixture-cookie, stoken: fixture-stoken }\n");
    const rows = ["bb01", "ios01", "android01", "pc01", "ios01", "hun01"]
      .map(region => ({ region, game_uid: "123456789", game_biz: "bh3_cn" }));
    rows.push(...["bb01", "gf01", "ptr01", "gf01"].map(region => ({ region, game_uid: "223456789", game_biz: "bh2_cn" })));
    const client = createHoyoClient(async (endpoint, options) => {
      expect(String(endpoint)).toBe("https://api-takumi.mihoyo.com/binding/api/getUserGameRolesByCookie");
      expect(new Headers(options?.headers).get("Cookie")).toBe("fixture-cookie");
      return Response.json({ retcode: 0, data: { list: rows } });
    });
    const catalog = await client.fetchRoleCatalog(await createProfileStore(root).accountContext("42"));
    expect(catalog.bh3.map(role => [role.uid, role.region])).toEqual([
      ["123456789", "ios01"], ["123456789", "android01"], ["123456789", "pc01"],
    ]);
    expect(catalog.bh2.map(role => [role.uid, role.region])).toEqual([["223456789", "gf01"]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("旧版多档案按自身账号、角色和设备构建请求上下文", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-yunzai-account-"));
  const qq = "100001";
  try {
    const first = join(root, `${qq}.yaml`);
    const second = join(root, `${qq}-2.yaml`);
    await writeFile(first, `
version: 1
enabled: true
user: { qq: "100001" }
profile: { id: 1, name: 主档案 }
account:
  ltuid: "400001"
  cookie: fixture-cookie-one
  stoken: fixture-token-one
  game_roles:
    gs: [{ game_uid: "800001", region: cn_gf01, game_head_icon: "https://upload-bbs.mihoyo.com/legacy-role.png?temporary=discard" }, { uid: "800002", is_chosen: true, avatar_url: "https://unknown.invalid/role.png" }]
  current_uid: { gs: "800001" }
device: { id: fixture-device-one, fp: fixture-fp-one, name: "Device FIXTURE-FP-ONE", model: "Fixture Model", bound: true }
`);
    await writeFile(second, `
user: { qq: 100001 }
profile: { id: 2, name: 副档案 }
account:
  ltuid: 400002
  cookie: fixture-cookie-two
  stoken_cookie: fixture-token-two
  current_uid: { gs: "800001" }
  game_roles: { gs: ["800004", { uid: "800003", is_chosen: true }] }
device:
  id: fixture-device-two
  fp: fixture-fp-two
  raw: { osVersion: 15 }
`);
    await writeFile(join(root, `${qq}-3.yaml`), "user: { qq: '100002' }\n");
    await writeFile(join(root, `${qq}-7.yaml`), "account: { cookie: example, current_uid: { sr: '700001' } }\n");
    await writeFile(join(root, `${qq}-255.yaml`), "profile: { id: 255 }\n");
    await writeFile(join(root, `${qq}-300.yaml`), "{}");
    await symlink(first, join(root, `${qq}-4.yaml`));

    const profiles = createProfileStore(root);
    expect(await profiles.listIds(qq)).toEqual([1, 2, 3, 7, 255]);
    const summary = await profiles.summary(qq);
    expect(summary).toEqual({ id: 1, name: "主档案", enabled: true, loggedIn: true, deviceBound: true });
    expect(JSON.stringify(summary)).not.toContain("fixture-");
    const view = await profiles.describe(qq);
    expect(view).toMatchObject({
      id: 1, hasCookie: true, hasStoken: true, passport: "已绑定",
      device: { hasFingerprint: true, name: "Fixture Model" }, activeRoles: { gs: "800001" },
    });
    expect(view.roles.gs.map(({ avatar }) => avatar)).toEqual(["https://upload-bbs.mihoyo.com/legacy-role.png", undefined]);
    for (const secret of ["fixture-cookie-one", "fixture-token-one", "fixture-device-one", "fixture-fp-one", "400001"]) {
      expect(JSON.stringify(view)).not.toContain(secret);
    }
    const [main, alternate] = await Promise.all([
      profiles.requestContext(qq, 1, "gs"), profiles.requestContext(qq, 2, "gs"),
    ]);
    expect(main).toMatchObject({
      profileId: 1, role: { uid: "800001", region: "cn_gf01" },
      account: { ltuid: "400001", stoken: "fixture-token-one" },
      device: { id: "fixture-device-one", fp: "fixture-fp-one" },
    });
    expect(alternate).toMatchObject({
      profileId: 2, role: { uid: "800003" },
      account: { ltuid: "400002", stokenCookie: "fixture-token-two" },
      device: { id: "fixture-device-two", fp: "fixture-fp-two", androidVersion: "15" },
    });
    expect((await profiles.requestContext(qq, 2, "gs", "800004")).role.uid).toBe("800004");
    const allAlternate = await profiles.requestContexts(qq, 2, ["sr", "gs", "gs"]);
    expect(allAlternate.map(({ game, role }) => [game, role.uid])).toEqual([["gs", "800004"], ["gs", "800003"]]);
    expect(allAlternate.every(({ qq: owner, profileId, revision, account, device }) => owner === qq && profileId === 2 &&
      revision === alternate.revision && account.cookie === alternate.account.cookie && device.id === alternate.device.id)).toBe(true);
    expect(await profiles.requestContexts(qq, 2, ["zzz"])).toEqual([]);
    await expect(profiles.requestContexts(qq, 7)).rejects.toMatchObject({ code: "login-required" });
    const beforeRoleBinding = await profiles.accountContext(qq, 2);
    const captured: Array<{ biz: string | null; cookie: string | null }> = [];
    const hoyo = createHoyoClient(async (endpoint, init) => {
      expect(endpoint.origin).toBe("https://api-takumi.mihoyo.com");
      expect(endpoint.pathname).toBe("/binding/api/getUserGameRolesByCookie");
      expect(init.redirect).toBe("error");
      captured.push({ biz: endpoint.searchParams.get("game_biz"), cookie: new Headers(init.headers).get("Cookie") });
      return Response.json({ retcode: 0, data: { list: [
        { game_biz: "nap_cn", game_uid: "910001", region: "prod_gf_cn", nickname: "示例" },
        { game_biz: "nap_cn", game_uid: "910001" },
        { game_biz: "hk4e_cn", game_uid: "810001" },
      ] } });
    });
    expect(await hoyo.listRoles(beforeRoleBinding, "zzz")).toEqual([
      { uid: "910001", gameBiz: "nap_cn", region: "prod_gf_cn", nickname: "示例", chosen: false },
    ]);
    expect(captured).toEqual([{ biz: "nap_cn", cookie: "fixture-cookie-two" }]);
    const failure = createHoyoClient(async () => Response.json({
      retcode: -100, message: "fixture-cookie-two",
    }));
    await expect(failure.listRoles(beforeRoleBinding, "sr")).rejects.toMatchObject({
      code: "api", retcode: -100, message: "米游社角色查询失败。",
    });
    await expect(profiles.requestContext(qq, 2, "gs", "800001")).rejects.toMatchObject({ code: "role-missing" });
    await expect(profiles.requestContext(qq, 7, "sr")).rejects.toMatchObject({ code: "login-required" });
    expect(await profiles.savedRole(qq, 7, "sr")).toEqual({ uid: "700001", nickname: "", region: "", gameBiz: "", chosen: false });
    expect(await profiles.savedRole(qq, 2, "gs")).toMatchObject({ uid: "800001", nickname: "", region: "" });
    expect(await profiles.savedRole(qq, 1, "gs")).toMatchObject({ uid: "800001", region: "cn_gf01" });
    await expect(profiles.savedRole(qq, 2, "sr")).rejects.toMatchObject({ code: "role-missing" });
    await expect(profiles.summary(qq, 3)).rejects.toMatchObject({ code: "invalid" });
    await expect(profiles.summary(qq, 4)).rejects.toMatchObject({ code: "invalid" });
    await expect(profiles.summary(qq, 5)).rejects.toMatchObject({ code: "missing" });
    await expect(profiles.summary("../100001")).rejects.toMatchObject({ code: "invalid" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("档案导入预检无写入，并行导入与重跑保留目标冲突", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-yunzai-profile-import-"));
  try {
    const source = join(root, "source");
    const destination = join(root, "destination");
    await mkdir(source);
    const original = "profile: { id: 1 }\naccount: { cookie: fixture, stoken: fixture }\n";
    await writeFile(join(source, "42.yaml"), original);
    await writeFile(join(source, "42-2.yaml"), "profile: { id: 2 }\n");
    await writeFile(join(source, "42-3.yaml"), "profile: { id: 4 }\n");
    await symlink(join(source, "42.yaml"), join(source, "42-4.yaml"));

    expect(await importProfiles(source, destination)).toEqual({
      ready: 2, invalid: 2, unchanged: 0, imported: 0, conflict: 0,
    });
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(destination);
    await writeFile(join(destination, "42-2.yaml"), "profile: { id: 2, name: 已存在 }\n");

    const applied = await Promise.all([
      importProfiles(source, destination, true), importProfiles(source, destination, true),
    ]);
    expect(applied.reduce((sum, item) => sum + item.imported, 0)).toBe(1);
    expect(applied.reduce((sum, item) => sum + item.unchanged, 0)).toBe(1);
    expect(applied.every((item) => item.invalid === 2 && item.conflict === 1)).toBe(true);
    expect(await readFile(join(destination, "42.yaml"), "utf8")).toBe(original);
    expect(await readFile(join(source, "42.yaml"), "utf8")).toBe(original);
    expect((await stat(join(destination, "42.yaml"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(destination, "42-2.yaml"), "utf8")).toContain("已存在");
    expect(await importProfiles(source, destination, true)).toEqual({
      ready: 0, invalid: 2, unchanged: 1, imported: 0, conflict: 1,
    });
    await expect(importProfiles(source, source, true)).rejects.toThrow("不同的来源和目标");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("扫码登录按原档案做原子提交，同账号续用角色，换账号隔离旧 UID", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-yunzai-login-slot-"));
  const directory = join(root, "profiles");
  const path = join(directory, "42-2.yaml");
  const profiles = createProfileStore(directory);
  const credentials = (aid: string) => ({
    stuid: aid,
    stoken: `fixture-stoken-${aid}`,
    credentials: {
      ltoken: `fixture-ltoken-${aid}`,
      cookie: `ltoken=fixture-ltoken-${aid};ltuid=${aid};cookie_token=fixture-cookie;account_id=${aid};`,
      stokenCookie: `stoken=fixture-stoken-${aid};stuid=${aid};`,
    },
  });
  const roles = {
    gs: [{ uid: "123456789", region: "cn_gf01", chosen: true, gameBiz: "hk4e_cn", nickname: "fixture-role" }],
    sr: [], zzz: [],
  };
  try {
    const first = await profiles.openLoginSlot("42", 2);
    const competing = await profiles.openLoginSlot("42", 2);
    expect(first.revision).toBeNull();
    expect(first.device.id).toMatch(/^[A-F0-9]{32}$/u);
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(profiles.verifyLoginSlot({ ...first })).rejects.toMatchObject({ code: "changed" });
    await expect(profiles.saveLogin(first, credentials("8001"), AbortSignal.abort("cancelled"))).rejects.toBe("cancelled");
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await profiles.saveLogin(first, { ...credentials("8001"), roles })).toEqual({ rolesSynced: true });
    await expect(profiles.saveLogin(competing, credentials("8002"))).rejects.toMatchObject({ code: "changed" });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await profiles.requestContext("42", 2, "gs")).toMatchObject({
      role: { uid: "123456789" }, account: { stuid: "8001" }, device: { id: first.device.id },
    });

    const same = await profiles.openLoginSlot("42", 2);
    expect(same.device.id).toBe(first.device.id);
    expect(await profiles.saveLogin(same, credentials("8001"))).toEqual({ rolesSynced: false });
    expect(await profiles.savedRole("42", 2, "gs")).toMatchObject({ uid: "123456789" });
    const inFlight = await profiles.openLoginSlot("42", 2);
    const latest = await profiles.accountContext("42", 2);
    await profiles.saveBoundDevice("42", 2, latest.revision, { id: "fixture-bound-device", fp: "dc00112233445" });
    await expect(profiles.verifyLoginSlot(inFlight)).rejects.toMatchObject({ code: "changed" });
    await expect(profiles.saveBoundDevice("42", 2, latest.revision, {
      id: "fixture-second-device", fp: "abcdef0123456",
    })).rejects.toMatchObject({ code: "changed" });
    expect((await profiles.accountContext("42", 2)).device).toMatchObject({
      id: "fixture-bound-device", fp: "dc00112233445", name: "", model: "",
    });
    const next = await profiles.openLoginSlot("42", 2);
    const inconsistent = credentials("8002");
    await expect(profiles.saveLogin(next, { ...inconsistent,
      credentials: { ...inconsistent.credentials, cookie: credentials("8003").credentials.cookie },
    })).rejects.toMatchObject({ code: "invalid" });
    expect((await profiles.accountContext("42", 2)).account.stuid).toBe("8001");
    expect(await profiles.saveLogin(next, credentials("8002"))).toEqual({ rolesSynced: false });
    await expect(profiles.savedRole("42", 2, "gs")).rejects.toMatchObject({ code: "role-missing" });
    expect((await profiles.accountContext("42", 2)).device.id).toBe("fixture-bound-device");

    const pending = await profiles.openLoginSlot("42", 2);
    await profiles.clearLogin("42", 2);
    await expect(profiles.verifyLoginSlot(pending)).rejects.toMatchObject({ code: "changed" });
    await expect(profiles.saveLogin(pending, credentials("8003"))).rejects.toMatchObject({ code: "changed" });
    expect((await profiles.summary("42", 2)).loggedIn).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("角色查询仅对 Cookie 过期刷新本档案一次，换绑后的凭据不会被迟到结果覆盖", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-yunzai-refresh-"));
  try {
    const file = join(root, "42.yaml");
    const original = `
user: { qq: "42" }
profile: { id: 1, name: 测试 }
account: { cookie: expired, stoken: retained, ltoken: old }
device: { id: fixture-device }
schedule: { mode: fixed }
`;
    await writeFile(file, original);
    const profiles = createProfileStore(root);
    const context = await profiles.accountContext("42");
    const seen: Array<string | null> = [];
    const late = Promise.withResolvers<void>();
    let exchanges = 0;
    const client = createHoyoClient(async (_url, init) => {
      const cookie = new Headers(init.headers).get("Cookie");
      seen.push(cookie);
      if (cookie === "expired" && seen.length === 2) await late.promise;
      return cookie === "renewed"
        ? Response.json({ retcode: 0, data: { list: [] } })
        : Response.json({ retcode: -100 });
    }, {
      profiles,
      async exchange(snapshot) {
        expect(snapshot.account.stoken).toBe("retained");
        expect(snapshot.device.id).toBe("fixture-device");
        exchanges++;
        return { cookie: "renewed", ltoken: "updated" };
      },
    });
    const first = client.listRoles(context, "gs");
    const second = client.listRoles(context, "gs");
    expect(await first).toEqual([]);
    late.resolve();
    expect(await second).toEqual([]);
    expect(exchanges).toBe(1);
    expect(seen).toEqual(["expired", "expired", "renewed", "renewed"]);
    expect((await profiles.accountContext("42")).account).toMatchObject({
      cookie: "renewed", ltoken: "updated", stoken: "retained",
    });
    expect(Bun.YAML.parse(await readFile(file, "utf8"))).toMatchObject({ schedule: { mode: "fixed" } });

    const updated = await profiles.accountContext("42");
    const racing = createHoyoClient(async () => Response.json({ retcode: -100 }), {
      profiles,
      async exchange() {
        await writeFile(file, original.replace("expired", "rebound").replace("retained", "new-login"));
        return { cookie: "stale-result", ltoken: "stale-token" };
      },
    });
    await expect(racing.listRoles(updated, "gs")).rejects.toMatchObject({ code: "refresh" });
    expect((await profiles.accountContext("42")).account).toMatchObject({ cookie: "rebound", stoken: "new-login" });

    const delayed = Promise.withResolvers<void>();
    const rebound = await profiles.accountContext("42");
    const replayed: string[] = [];
    const laterRebind = createHoyoClient(async (url, init) => {
      const cookie = new Headers(init.headers).get("Cookie");
      if (cookie === "rebound") {
        if (url.searchParams.get("game_biz") === "hkrpg_cn") await delayed.promise;
        return Response.json({ retcode: -100 });
      }
      replayed.push(String(cookie));
      return Response.json({ retcode: 0, data: { list: [] } });
    }, { profiles, async exchange() { return { cookie: "rebound-refreshed", ltoken: "newer-token" }; } });
    const gs = laterRebind.listRoles(rebound, "gs");
    const sr = laterRebind.listRoles(rebound, "sr");
    expect(await gs).toEqual([]);
    await writeFile(file, original.replace("expired", "another-account").replace("retained", "another-login"));
    delayed.resolve();
    await expect(sr).rejects.toMatchObject({ code: "refresh" });
    expect(replayed).toEqual(["rebound-refreshed"]);
    expect((await profiles.accountContext("42")).account.cookie).toBe("another-account");

    const ordinaryError = createHoyoClient(async () => Response.json({ retcode: 10041 }), {
      profiles,
      async exchange() { throw new Error("协议风控不能触发刷新"); },
    });
    await expect(ordinaryError.listRoles(await profiles.accountContext("42"), "gs"))
      .rejects.toMatchObject({ code: "api", retcode: 10041 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("使用旧 v1/v2 令牌交换路径，校验账号后重试并保留混合令牌格式", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-yunzai-exchange-"));
  try {
    const primary = "profile: { id: 1 }\naccount: { stuid: '71', stoken: v2_login, mid: login-mid, cookie: expired }\ndevice: { id: device-one, fp: fp-one }\n";
    await writeFile(join(root, "42.yaml"), primary);
    await writeFile(join(root, "42-2.yaml"), "profile: { id: 2 }\naccount: { cookie: old, stoken_cookie: 'stuid=72;stoken=legacy-login' }\n");
    const profiles = createProfileStore(root);
    const requests: string[] = [];
    const client = createProfileHoyoClient(profiles, async (url, init) => {
      expect(init.redirect).toBe("error");
      requests.push(url.pathname);
      const headers = new Headers(init.headers);
      if (url.pathname.endsWith("getUserGameRolesByCookie")) {
        if (headers.get("cookie") === "expired") return Response.json({ retcode: -100 });
        expect(headers.get("cookie")).toBe("ltoken_v2=v2_new;ltuid_v2=71;ltmid_v2=login-mid;cookie_token=legacy-new;account_id=71;");
        return Response.json({ retcode: 0, data: { list: [{ game_biz: "hk4e_cn", game_uid: "81" }] } });
      }
      expect(url.origin).toBe("https://passport-api.mihoyo.com");
      expect(url.searchParams.get("stoken")).toBe("v2_login");
      expect(url.searchParams.has("stuid")).toBe(false);
      expect(headers.get("x-rpc-device_id")).toBe("device-one");
      expect(headers.get("x-rpc-device_fp")).toBe("fp-one");
      expect(headers.get("ds")).toMatch(/^\d+,\d+,[a-f\d]{32}$/u);
      return url.pathname.endsWith("getLTokenBySToken")
        ? Response.json({ retcode: 0, data: { token: { token: "v2_new" }, user_info: { uid: "71" } } })
        : Response.json({ retcode: 0, data: { cookie_token: "legacy-new", account_id: "71", mid: "login-mid" } });
    });
    expect(await client.listRoles(await profiles.accountContext("42"), "gs")).toMatchObject([{ uid: "81" }]);
    expect(requests).toEqual([
      "/binding/api/getUserGameRolesByCookie", "/account/auth/api/getLTokenBySToken",
      "/account/auth/api/getCookieAccountInfoBySToken", "/binding/api/getUserGameRolesByCookie",
    ]);

    const second = await profiles.accountContext("42", 2);
    const paths: string[] = [];
    const legacy = createCredentialExchange(async (url, init) => {
      paths.push(url.origin + url.pathname);
      expect(init.method).toBe("GET");
      expect(url.searchParams.get("stoken")).toBe("legacy-login");
      if (url.pathname.endsWith("getLTokenBySToken")) {
        expect(url.searchParams.get("stuid")).toBe("72");
        return Response.json({ retcode: 0, data: { ltoken: "lt" } });
      }
      expect(url.searchParams.get("uid")).toBe("72");
      expect(url.searchParams.get("game_biz")).toBe("hk4e_cn");
      return Response.json({ retcode: 0, data: { cookie_token: "ck", uid: "72" } });
    });
    expect(await legacy(second)).toMatchObject({ cookie: "ltoken=lt;ltuid=72;cookie_token=ck;account_id=72;" });
    expect(paths).toEqual([
      "https://passport-api.mihoyo.com/account/auth/api/getLTokenBySToken",
      "https://api-takumi.mihoyo.com/auth/api/getCookieAccountInfoBySToken",
    ]);

    const mismatch = createProfileHoyoClient(profiles, async (url) => {
      if (url.pathname.endsWith("getUserGameRolesByCookie")) return Response.json({ retcode: -100 });
      if (url.pathname.endsWith("getLTokenBySToken")) return Response.json({ retcode: 0, data: { ltoken: "lt" } });
      return Response.json({ retcode: 0, data: { cookie_token: "ck", uid: "99" } });
    });
    await expect(mismatch.listRoles(second, "gs")).rejects.toMatchObject({ code: "refresh" });
    expect((await profiles.accountContext("42", 2)).account.cookie).toBe("old");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("旧刷新指令支持单档案后缀和批量刷新，沿用旧权限配置", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-yunzai-refresh-command-"));
  try {
    const config = join(root, "config");
    await mkdir(config);
    await writeFile(join(config, "global.yaml"), `
permissions:
  users: { deny: [51] }
  scopes:
    checkin.refresh: { policy: master_only }
`);
    await writeFile(join(root, "42.yaml"), "account: { cookie: old, stuid: '71', stoken: login-1 }\n");
    await writeFile(join(root, "42-2.yaml"),
      "profile: { id: 2 }\naccount: { cookie: old, stuid: '72', stoken: login-2, current_uid: { gs: '82' } }\ndevice: { id: my-device }\nschedule: { mode: fixed }\n");
    const seen: Array<string | null> = [];
    let malformedRoles = false;
    const registry = new CommandRegistry();
    registry.registerModule(accountCommands(root, await readAccountRefreshPermission(pathToFileURL(root + "/")), (profiles) =>
      createProfileHoyoClient(profiles, async (url, init) => {
        if (url.pathname.endsWith("getUserGameRolesByCookie")) {
          expect(url.searchParams.has("game_biz")).toBe(false);
          const account = new Headers(init.headers).get("cookie")?.includes("account_id=72;");
          return Response.json({ retcode: 0, data: { list: malformedRoles
            ? [{ game_biz: "hk4e_cn" }]
            : [
              { game_biz: "hk4e_cn", game_uid: account ? "82" : "81", region: "cn_gf01", region_name: "天空岛", level: 60 },
              { game_biz: "hk4e_cn", game_uid: account ? "92" : "91", is_chosen: true },
              { game_biz: "hkrpg_cn", game_uid: account ? "182" : "181" },
            ] } });
        }
        seen.push(url.searchParams.get("stoken"));
        return Response.json({ retcode: 0, data: url.pathname.endsWith("getLTokenBySToken")
          ? { ltoken: "lt" }
          : { cookie_token: "ck", uid: url.searchParams.get("uid") } });
      })));
    const user = { user_id: 42, message_type: "private", isMaster: false } as const;
    const owner = { ...user, isMaster: true };
    expect(await registry.dispatch("#刷新cookie2", user)).toContain("当前不允许");
    expect(await registry.dispatch("#刷新cookie", { ...owner, user_id: 51 })).toContain("当前不允许");
    expect(seen).toEqual([]);
    expect(await registry.dispatch("#刷新ck2", owner)).toBe("Cookie 刷新\n档案 2 · 刷新成功");
    expect(seen).toEqual(["login-2", "login-2"]);
    expect(await registry.dispatch("#刷新Cookie", owner)).toBe("Cookie 刷新\n档案 1 · 刷新成功\n档案 2 · 刷新成功");
    expect(seen).toEqual(["login-2", "login-2", "login-1", "login-1", "login-2", "login-2"]);
    const profiles = createProfileStore(root);
    expect(await registry.dispatch("#同步UID2", owner)).toContain("原神 2，星铁 1，绝区零 0");
    expect((await profiles.requestContext("42", 2, "gs")).role).toMatchObject({ uid: "82", regionName: "天空岛", level: 60 });
    expect((await profiles.requestContext("42", 1, "sr")).role.uid).toBe("181");

    malformedRoles = true;
    expect(await registry.dispatch("#刷新自动签到2", owner)).toContain("刷新成功，角色同步失败");
    expect((await profiles.requestContext("42", 2, "gs")).role.uid).toBe("82");

    const old = await profiles.accountContext("42", 2);
    expect(await registry.dispatch("#删除扫码登录2", user)).toContain("档案 2 的登录信息已清除");
    expect((await profiles.summary("42", 1)).loggedIn).toBe(true);
    expect((await profiles.summary("42", 2)).loggedIn).toBe(false);
    expect(Bun.YAML.parse(await readFile(join(root, "42-2.yaml"), "utf8"))).toMatchObject({
      account: { cookie: "", stoken: "", current_uid: { gs: "82" } },
      device: { id: "my-device" },
      schedule: { mode: "fixed" },
    });
    await expect(profiles.saveRefreshedCredentials("42", 2, old.revision, { cookie: "late", ltoken: "late" }))
      .rejects.toMatchObject({ code: "changed" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("刷新回执保留逐档状态，绘制失败时返回同一批操作的文字结果", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-yunzai-refresh-card-"));
  try {
    for (const name of ["42", "42-2", "42-3", "51"]) {
      await writeFile(join(root, name + ".yaml"), "account: { cookie: fixture, stuid: '71', stoken: fixture }\n");
    }
    const png = Uint8Array.of(137, 80, 78, 71);
    const completed: number[] = [];
    const cards: { title: string; lead: string; contents: readonly string[] }[] = [];
    let renderFailure = false;
    const registry = new CommandRegistry();
    registry.registerModule(accountCommands(root, ({ isMaster }) => isMaster, (profiles) => ({
      ...createProfileHoyoClient(profiles),
      async refreshProfile({ qq, profileId }) {
        expect(qq).toBe("42");
        completed.push(profileId);
        if (profileId === 3) throw new Error("private-upstream-fixture");
        return { rolesSynced: profileId === 1 };
      },
    }), async (title, lead, contents) => {
      cards.push({ title, lead, contents });
      if (renderFailure) throw new Error("fixture draw failed");
      return { png };
    }));
    const owner = { user_id: 42, message_type: "private", isMaster: true } as const;
    expect(await registry.dispatch("#刷新cookie", { ...owner, isMaster: false })).toContain("当前不允许");
    expect(await registry.dispatch("#刷新c", { ...owner, user_id: 999 })).toContain("尚未创建档案");
    expect(await registry.dispatch("#刷新ck", { ...owner, user_id: undefined })).toContain("请从 QQ 会话");
    expect(cards).toEqual([]);
    expect(completed).toEqual([]);

    expect(await registry.dispatch("#刷新Cookie", owner)).toEqual({ type: "image", file: png });
    expect(completed).toEqual([1, 2, 3]);
    expect(cards[0]).toEqual({
      title: "Cookie 刷新",
      lead: "QQ 42\n已按 profile 粒度处理当前 QQ 的登录信息，刷新成功 2/3。",
      contents: ["Profile 1：刷新成功", "Profile 2：刷新成功，角色同步失败", "Profile 3：刷新失败，请确认登录状态后重试"],
    });

    expect(await registry.dispatch("#刷新自动签到2", owner)).toEqual({ type: "image", file: png });
    expect(cards[1]).toEqual({
      title: "Cookie 刷新",
      lead: "QQ 42\n已刷新 profile 2 的登录信息。",
      contents: ["Profile 2：刷新成功，角色同步失败"],
    });

    renderFailure = true;
    expect(await registry.dispatch("#刷新ck3", owner)).toBe("Cookie 刷新\n档案 3 · 刷新失败，请确认登录状态后重试");
    expect(cards[2]?.lead).toBe("QQ 42\nprofile 3 的登录信息未能刷新。");
    expect(completed).toEqual([1, 2, 3, 2, 3]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("自动兑换独立保存旧档游戏和本版预设，写入前会话失效时不落盘", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-preview-settings-"));
  try {
    const live = "profile: {id: 1}\naccount: {cookie: old, stoken: token}\n";
    const old = "profile: {id: 2}\naccount: {cookie: old, stoken: token}\nauto_redeem: {enable: true, games: [sr]}\n";
    await writeFile(join(root, "42.yaml"), live);
    await writeFile(join(root, "42-2.yaml"), old);
    const profiles = createProfileStore(root);
    const settings = await profiles.previewRedeemSettings("42", 1);
    expect(settings).toMatchObject({ enabled: false, games: ["gs", "sr", "zzz"], allowNewJournal: false });
    await expect(profiles.setPreviewRedeemSettings("42", 1, settings.revision, true, ["gs"], undefined, async () => {
      throw new Error("会话已失效");
    })).rejects.toThrow("会话已失效");
    expect(await readFile(join(root, "42.yaml"), "utf8")).toBe(live);
    const preset = await profiles.setPreviewRedeemSettings("42", 1, settings.revision, false, ["zzz"]);
    expect(await profiles.previewRedeemSettings("42", 1)).toMatchObject({
      revision: preset.revision, enabled: false, games: ["zzz"], allowNewJournal: true,
    });
    expect(await profiles.listPreviewRedeemProfiles()).toEqual([{ qq: "42", profileId: 2, games: ["sr"], allowNewJournal: false }]);
    await expect(profiles.setPreviewRedeemSettings("42", 1, settings.revision, true, ["gs"])).rejects.toMatchObject({ code: "changed" });
    expect(await readFile(join(root, "42-2.yaml"), "utf8")).toBe(old);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
