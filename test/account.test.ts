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
    gs: [{ game_uid: "800001", region: cn_gf01 }, { uid: "800002", is_chosen: true }]
  current_uid: { gs: "800001" }
device: { id: fixture-device-one, fp: fixture-fp-one, bound: true }
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
    await writeFile(join(root, `${qq}-7.yaml`), "account: { cookie: example }\n");
    await writeFile(join(root, `${qq}-255.yaml`), "profile: { id: 255 }\n");
    await writeFile(join(root, `${qq}-300.yaml`), "{}");
    await symlink(first, join(root, `${qq}-4.yaml`));

    const profiles = createProfileStore(root);
    expect(await profiles.listIds(qq)).toEqual([1, 2, 3, 7, 255]);
    const summary = await profiles.summary(qq);
    expect(summary).toEqual({ id: 1, name: "主档案", enabled: true, loggedIn: true, deviceBound: true });
    expect(JSON.stringify(summary)).not.toContain("fixture-");
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
    let exchanges = 0;
    const client = createHoyoClient(async (_url, init) => {
      const cookie = new Headers(init.headers).get("Cookie");
      seen.push(cookie);
      return cookie === "renewed"
        ? Response.json({ retcode: 0, data: { list: [] } })
        : Response.json({ retcode: -100 });
    }, {
      profiles,
      async exchange(snapshot) {
        expect(snapshot.account.stoken).toBe("retained");
        expect(snapshot.device.id).toBe("fixture-device");
        exchanges++;
        await Bun.sleep(10);
        return { cookie: "renewed", ltoken: "updated" };
      },
    });
    expect(await Promise.all([client.listRoles(context, "gs"), client.listRoles(context, "gs")]))
      .toEqual([[], []]);
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
    const registry = new CommandRegistry();
    registry.registerModule(accountCommands(root, await readAccountRefreshPermission(pathToFileURL(root + "/")), (profiles) =>
      createProfileHoyoClient(profiles, async (url) => {
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
