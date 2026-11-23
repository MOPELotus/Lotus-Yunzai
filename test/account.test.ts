import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { accountCommands } from "../lib/account-commands.ts";
import { repairLegacyPassportCookies } from "../lib/passport-cookie-repair.ts";
import { CommandRegistry } from "../lib/commands.ts";
import { readAccountRefreshPermission } from "../lib/permissions.ts";
import { createProfileStore, importProfiles } from "../packages/account/index.ts";
import { createCredentialExchange, createHoyoClient, createProfileHoyoClient } from "../packages/hoyo-client/index.ts";

test("主人用户统计只显示去重的本机档案计数，不检查或回显凭据", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-account-inventory-"));
  const account = { stuid: "18000721", ltuid: "18000721", stoken: "fixture-secret-stoken", cookie: "account_id=18000721;cookie_token=fixture-secret" };
  const os = { cookie: "fixture-foreign-secret", verified_account_id: "18000722", verified_realm: "SG" };
  const files = new Map([
    ["42.yaml", Bun.YAML.stringify({ user: { qq: "42" }, account, games: { os } })],
    ["42-2.yaml", Bun.YAML.stringify({ user: { qq: "42" }, profile: { id: 2 }, account, games: { os } })],
    ["43.yaml", Bun.YAML.stringify({ user: { qq: "43" }, account: { ltuid: "18000723",
      cookie: "ltuid=18000723;ltoken=fixture-legacy;cookie_token=fixture-readonly" } })],
    ["44.yaml", Bun.YAML.stringify({ user: { qq: "99" }, account })],
    ["45.yaml", Bun.YAML.stringify({ user: { qq: "45" }, account: { ...account, ltuid: "18000999" }, games: { os: { cookie: os.cookie } } })],
  ]);
  try {
    await Promise.all([...files].map(([file, value]) => writeFile(join(root, file), value)));
    let network = 0;
    const registry = new CommandRegistry();
    registry.registerModule(accountCommands(root, () => false, profiles => createProfileHoyoClient(profiles, async () => {
      network++;
      throw new Error("统计不应发出请求");
    })));
    const signal = new AbortController().signal;
    const owner = { message_type: "private", user_id: 42, self_id: 50, isMaster: true, privateCredentialSignal: signal } as const;
    expect(await registry.dispatch("#用户统计", { ...owner, isMaster: false })).toContain("只有机器人主人");
    expect(await registry.dispatch("#用户统计", { ...owner, isDelegated: true })).toContain("只有机器人主人");
    expect(await registry.dispatch("#用户统计", { ...owner, privateCredentialSignal: undefined })).toContain("已绑定");
    const reply = await registry.dispatch("#用户统计", owner);
    expect(reply).toBe("用户统计（本机档案）\nQQ 用户 3 · 可读取档案 4\n米游社已保存 1 个去重账号 · HoYoLAB 已保存 1 个去重账号\n仅查询旧 Cookie 档案 1 · 无法读取档案 1");
    for (const fingerprint of [account.stuid, account.stoken, account.cookie, os.cookie, os.verified_account_id]) {
      expect(reply).not.toContain(fingerprint);
    }
    expect(await Promise.all([...files.keys()].map(file => readFile(join(root, file), "utf8")))).toEqual([...files.values()]);
    expect(network).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("档案续期和设置跨进程写入只接受一个版本，重试保留两项结果", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lotus-profile-cross-process-")));
  const alias = join(root, "profile-alias");
  const profile = join(root, "42.yaml");
  const blocked = join(root, "before-rename");
  const release = join(root, "release-rename");
  const editing = join(root, "editing-preference");
  const children: Bun.Subprocess[] = [];
  try {
    await writeFile(profile, 'enabled: false\naccount: { ltuid: "4001", cookie: old-cookie, stoken: old-stoken }\n');
    await symlink(root, alias, "dir");
    const profiles = createProfileStore(root);
    const { revision } = await profiles.checkinSettings("42", 1);
    const module = new URL("../packages/account/index.ts", import.meta.url).href;
    function run(refresh: boolean) {
      const code = `
        import { mock } from "bun:test";
        import * as files from "node:fs/promises";
        const rename = files.rename;
        if (${refresh}) mock.module("node:fs/promises", () => ({ ...files, async rename(from, to) {
          if (to === ${JSON.stringify(profile)}) {
            await files.writeFile(${JSON.stringify(blocked)}, "");
            while (!await Bun.file(${JSON.stringify(release)}).exists()) await Bun.sleep(10);
          }
          return rename(from, to);
        } }));
        const { createProfileStore } = await import(${JSON.stringify(module)});
        const profiles = createProfileStore(${JSON.stringify(refresh ? root : alias)});
        try {
          if (${refresh}) {
            await profiles.saveRefreshedCredentials("42", 1, ${JSON.stringify(revision)},
              { cookie: "new-cookie", ltoken: "new-ltoken", stokenCookie: "stoken=old-stoken" });
          } else {
            await files.writeFile(${JSON.stringify(editing)}, "");
            await profiles.setCheckinEnabled("42", 1, ${JSON.stringify(revision)}, true);
          }
          console.log("saved");
        } catch (error) {
          if (error?.code !== "changed") throw error;
          console.log("changed");
        }
      `;
      const child = Bun.spawn([process.execPath, "--no-env-file", "-e", code], {
        stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 8_000,
      });
      children.push(child);
      return Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    }
    async function wait(path: string) {
      for (let attempt = 0; attempt < 200 && !await Bun.file(path).exists(); attempt++) await Bun.sleep(10);
      expect(await Bun.file(path).exists()).toBe(true);
    }
    const saving = run(true);
    await wait(blocked);
    const setting = run(false);
    await wait(editing);
    await Promise.race([setting, Bun.sleep(350)]);
    await writeFile(release, "");
    expect(await saving).toEqual([0, "saved\n", ""]);
    expect(await setting).toEqual([0, "changed\n", ""]);
    const current = await profiles.checkinSettings("42", 1);
    expect(current.enabled).toBe(false);
    await expect(profiles.setCheckinEnabled("42", 1, current.revision, true)).resolves.toMatchObject({ enabled: true });
    const final = await profiles.accountContext("42");
    expect(final.account.cookie).toBe("new-cookie");
    expect(final.account.ltoken).toBe("new-ltoken");
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await child.exited;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

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
    expect(await profiles.requestSelectedContext(qq, 1, "gs")).toEqual(main);
    await expect(profiles.requestSelectedContext(qq, 2, "gs")).rejects.toMatchObject({ code: "role-missing" });
    await expect(profiles.requestSelectedContext(qq, 7, "sr")).rejects.toMatchObject({ code: "login-required" });
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
      expect(init).toMatchObject({ redirect: "error", proxy: false });
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
    expect(await profiles.saveLogin(first, { ...credentials("8001"), roles })).toMatchObject({ rolesSynced: true, revision: expect.any(String) });
    await expect(profiles.saveLogin(competing, credentials("8002"))).rejects.toMatchObject({ code: "changed" });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await profiles.requestContext("42", 2, "gs")).toMatchObject({
      role: { uid: "123456789" }, account: { stuid: "8001" }, device: { id: first.device.id },
    });

    const same = await profiles.openLoginSlot("42", 2);
    expect(same.device.id).toBe(first.device.id);
    expect(await profiles.saveLogin(same, credentials("8001"))).toMatchObject({ rolesSynced: false, revision: expect.any(String) });
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
    expect(await profiles.saveLogin(next, credentials("8002"))).toMatchObject({ rolesSynced: false, revision: expect.any(String) });
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
    const firstRead = Promise.withResolvers<void>();
    const secondRead = Promise.withResolvers<void>();
    const late = Promise.withResolvers<void>();
    let exchanges = 0;
    const client = createHoyoClient(async (_url, init) => {
      const cookie = new Headers(init.headers).get("Cookie");
      seen.push(cookie);
      if (cookie === "expired") {
        // Wait for both requests to reach the transport before allowing either to refresh.
        if (seen.length === 1) {
          firstRead.resolve();
          await secondRead.promise;
        } else if (seen.length === 2) {
          secondRead.resolve();
          await late.promise;
        }
      }
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
    await Promise.race([firstRead.promise, first]);
    const second = client.listRoles(context, "gs");
    try {
      expect(await first).toEqual([]);
    } finally {
      late.resolve();
    }
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

test("月谕圣牌只查询当前档案剧诗，续期一次并校验区服和角色", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-genshin-tarot-account-"));
  try {
    const uid = "123456789";
    await writeFile(join(root, "42.yaml"), Bun.YAML.stringify({
      account: { stuid: "71", stoken: "fixture-login", cookie: "ltoken=old;ltuid=71",
        game_roles: { gs: [{ uid, region: "cn_gf01" }] } },
      device: { id: "fixture-device" },
    }));
    const profiles = createProfileStore(root);
    const source = await profiles.requestContext("42", 1, "gs");
    const collection = { list: [{ name: "愚人", is_unlock: true, unlock_num: 2 }] };
    let reads = 0;
    let exchanges = 0;
    const client = createHoyoClient(async (url, init) => {
      reads++;
      expect(url.pathname).toEndWith("/role_combat");
      expect(url.searchParams.get("role_id")).toBe(uid);
      expect(url.searchParams.get("server")).toBe("cn_gf01");
      expect(url.searchParams.get("need_detail")).toBe("true");
      return new Headers(init.headers).get("cookie")?.includes("ltoken=old")
        ? Response.json({ retcode: -100 })
        : Response.json({ retcode: 0, data: { uid, tarot_card_state: collection } });
    }, { profiles, async exchange() {
      exchanges++;
      return { cookie: "ltoken=new;ltuid=71", ltoken: "new" };
    } });
    expect(await client.fetchGenshinTarotCollection(source)).toMatchObject({ collection, refreshedCookie: true });
    expect([reads, exchanges]).toEqual([2, 1]);
    const current = await profiles.requestContext("42", 1, "gs");
    const mismatch = createHoyoClient(async () => Response.json({ retcode: 0, data: { uid: "987654321" } }));
    await expect(mismatch.fetchGenshinTarotCollection(current)).rejects.toMatchObject({ code: "response" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("按旧 v1 和 Passport App v2 路径换票，核验账号后重试原业务", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-yunzai-exchange-"));
  try {
    const primary = "profile: { id: 1 }\naccount: { stuid: '71', stoken: v2_login, mid: login-mid, cookie: expired }\ndevice: { id: device-one, fp: fp-one }\n";
    await writeFile(join(root, "42.yaml"), primary);
    await writeFile(join(root, "42-2.yaml"), "profile: { id: 2 }\naccount: { cookie: old, stoken_cookie: 'stuid=72;stoken=legacy-login' }\n");
    const profiles = createProfileStore(root);
    const requests: string[] = [];
    const targets: number[] = [];
    const lifecycleIds = new Set<string>();
    const client = createProfileHoyoClient(profiles, async (url, init) => {
      expect(init).toMatchObject({ redirect: "error", proxy: false });
      requests.push(url.pathname);
      const headers = new Headers(init.headers);
      if (url.pathname.endsWith("getUserGameRolesByCookie")) {
        if (headers.get("cookie") === "expired") return Response.json({ retcode: -100 });
        expect(headers.get("cookie")).toBe("ltoken_v2=v2_new;ltuid_v2=71;ltmid_v2=login-mid;cookie_token_v2=v2_cookie;account_id_v2=71;account_mid_v2=login-mid;");
        return Response.json({ retcode: 0, data: { list: [{ game_biz: "hk4e_cn", game_uid: "81" }] } });
      }
      expect(url.origin).toBe("https://passport-api.mihoyo.com");
      expect(url.pathname).toBe("/account/ma-cn-session/app/exchange");
      expect(url.search).toBe("");
      expect(init.method).toBe("POST");
      expect(init.credentials).toBe("omit");
      expect(headers.get("cookie")).toBeNull();
      const body = String(init.body);
      const input = JSON.parse(body);
      expect(input.src_token).toEqual({ token: "v2_login", token_type: 1 });
      expect(input.mid).toBe("login-mid");
      targets.push(input.dst_token_type);
      expect(headers.get("x-rpc-device_id")).toBe("device-one");
      expect(headers.get("x-rpc-device_fp")).toBe("fp-one");
      expect(headers.get("x-rpc-sdk_version")).toBe("2.44.0");
      expect(headers.get("x-rpc-app_version")).toBe("2.102.1");
      expect(headers.get("x-rpc-account_version")).toBe("2.44.0");
      expect(headers.get("x-rpc-channel")).toBe("appstore");
      expect(headers.get("User-Agent")).toBe("okhttp/4.8.0");
      lifecycleIds.add(headers.get("x-rpc-lifecycle_id")!);
      const [time, nonce, signature] = headers.get("ds")!.split(",");
      expect(Number(nonce)).toBeGreaterThan(100000);
      expect(Number(nonce)).toBeLessThan(200000);
      expect(signature).toBe(createHash("md5").update(`salt=JwYDpKvLj6MrMqqYU6jTKF17KNO2PXoS&t=${time}&r=${nonce}&b=${body}&q=`).digest("hex"));
      return input.dst_token_type === 2
        ? Response.json({ retcode: 0, data: { token: { token: "v2_new" }, user_info: { aid: "71" } } })
        : Response.json({ retcode: 0, data: { cookie_token: "v2_cookie", user_info: { aid: "71" } } });
    });
    expect(await client.listRoles(await profiles.accountContext("42"), "gs")).toMatchObject([{ uid: "81" }]);
    expect(requests).toEqual([
      "/binding/api/getUserGameRolesByCookie", "/account/ma-cn-session/app/exchange",
      "/account/ma-cn-session/app/exchange", "/binding/api/getUserGameRolesByCookie", "/binding/api/getUserGameRolesByCookie",
    ]);
    expect(targets).toEqual([2, 4]);
    expect(lifecycleIds.size).toBe(1);
    expect([...lifecycleIds][0]).toMatch(/^[\da-f-]{36}$/u);
    expect((await profiles.requestContext("42", 1, "gs")).role.uid).toBe("81");

    const refreshed = await profiles.accountContext("42");
    let denied = 0;
    const rejected = createCredentialExchange(async () => {
      denied++;
      return Response.json({ retcode: -464, message: "不应回显原文" });
    });
    await expect(rejected(refreshed)).rejects.toMatchObject({ code: "api", retcode: -464, message: "LToken 换票未成功。" });
    expect(denied).toBe(1);
    const wrongOwner = createCredentialExchange(async () =>
      Response.json({ retcode: 0, data: { token: { token: "v2_wrong" }, user_info: { aid: "99" } } }));
    await expect(wrongOwner(refreshed)).rejects.toThrow("账号身份与档案不一致");
    const unidentifiedCookie = createCredentialExchange(async (_url, init) => {
      const { dst_token_type } = JSON.parse(String(init.body));
      return dst_token_type === 2
        ? Response.json({ retcode: 0, data: { ltoken: "v2_new", aid: "71" } })
        : Response.json({ retcode: 0, data: { token: { token: "v2_cookie" } } });
    });
    await expect(unidentifiedCookie(refreshed)).rejects.toThrow("账号身份与档案不一致");

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

test("角色同步挡住串档 Cookie，显式续期仍能用该档原 STOKEN 修复", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-cookie-owner-"));
  const path = join(root, "42-2.yaml");
  try {
    const profile = Bun.YAML.stringify({
      user: { qq: "42" }, profile: { id: 2 },
      account: { stuid: "71", ltuid: "71", mid: "fixture-mid", stoken: "v2_original",
        cookie: "ltuid_v2=72;ltmid_v2=fixture-mid;ltoken_v2=v2_old;cookie_token_v2=v2_old" },
    });
    await writeFile(path, profile);
    const requests: string[] = [];
    const registry = new CommandRegistry();
    registry.registerModule(accountCommands(root, () => true, profiles => createProfileHoyoClient(profiles, async (url, init) => {
      requests.push(url.pathname);
      if (url.pathname.endsWith("/getUserGameRolesByCookie")) {
        expect(new Headers(init.headers).get("cookie")).toContain("ltuid_v2=71");
        return Response.json({ retcode: 0, data: { list: [{ game_biz: "hk4e_cn", game_uid: "100000031", region: "cn_gf01" }] } });
      }
      const { src_token, dst_token_type } = JSON.parse(String(init.body));
      expect(src_token.token).toBe("v2_original");
      return Response.json({ retcode: 0, data: { user_info: { aid: "71" },
        token: { token: dst_token_type === 2 ? "v2_fresh-ltoken" : "v2_fresh-cookie" } } });
    })));
    const context = { user_id: 42, message_type: "private", isMaster: false } as const;
    expect(await registry.dispatch("#同步角色2", context)).toContain("无法同步");
    expect(requests).toEqual([]);
    expect(await readFile(path, "utf8")).toBe(profile);
    expect(await registry.dispatch("#刷新cookie2", context)).toContain("刷新成功");
    expect(requests).toEqual(["/account/ma-cn-session/app/exchange", "/account/ma-cn-session/app/exchange",
      "/binding/api/getUserGameRolesByCookie"]);
    expect((await createProfileStore(root).requestContext("42", 2, "gs")).role.uid).toBe("100000031");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("多个客户端从同一档案及目录别名读到失效，只换票一次并分别重试", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-shared-cn-refresh-"));
  const directory = join(root, "users");
  const alias = join(root, "alias");
  await mkdir(directory);
  await symlink(directory, alias);
  try {
    await writeFile(join(directory, "42.yaml"), "account: { stuid: '71', stoken: old-token, cookie: 'ltoken=expired' }\n");
    const firstStore = createProfileStore(directory);
    const secondStore = createProfileStore(alias);
    const bothExpired = Promise.withResolvers<void>();
    const requestLog: string[] = [];
    let expiredReads = 0;
    const transport: Parameters<typeof createProfileHoyoClient>[1] = async (url, init) => {
      if (url.pathname.endsWith("BySToken")) {
        requestLog.push(url.pathname.split("/").at(-1)!);
        return Response.json({ retcode: 0, data: url.pathname.endsWith("getLTokenBySToken")
          ? { ltoken: "fresh" } : { token: { token: "fresh-cookie" }, uid: "71" } });
      }
      const game = url.searchParams.get("game_biz");
      const cookie = new Headers(init.headers).get("cookie");
      if (cookie === "ltoken=expired") {
        if (++expiredReads === 2) bothExpired.resolve();
        await bothExpired.promise;
        return Response.json({ retcode: "-100" }, { status: 401 });
      }
      expect(cookie).toInclude("cookie_token=fresh-cookie");
      requestLog.push(game ?? "sync");
      return Response.json({ retcode: 0, data: { list: [
        { game_biz: "hk4e_cn", game_uid: "81", region: "cn_gf01" },
        { game_biz: "hkrpg_cn", game_uid: "82", region: "prod_gf_cn" },
      ] } });
    };
    const first = createProfileHoyoClient(firstStore, transport);
    const second = createProfileHoyoClient(secondStore, transport);
    const [gs, sr] = await Promise.all([first.listRoles(await firstStore.accountContext("42"), "gs"),
      second.listRoles(await secondStore.accountContext("42"), "sr")]);
    expect(gs).toMatchObject([{ uid: "81" }]);
    expect(sr).toMatchObject([{ uid: "82" }]);
    expect(requestLog.slice(0, 3)).toEqual(["getLTokenBySToken", "getCookieAccountInfoBySToken", "sync"]);
    expect(requestLog.slice(3).sort()).toEqual(["hk4e_cn", "hkrpg_cn"]);
    expect((await secondStore.requestContext("42", 1, "sr")).role.uid).toBe("82");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("旧 Cookie 自检只换掉异常的可续期档案并保留失败档", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-old-cn-cookie-"));
  try {
    const content = (uid: string, stoken: string, cookie: string) => Bun.YAML.stringify({ account: { stuid: uid, stoken, mid: "fixture-mid", cookie } });
    const bad = (uid: string) => `ltoken=v2_legacy;ltuid=${uid};cookie_token=legacy;account_id=${uid};`;
    const stranded = content("71", "", bad("71"));
    const rejected = content("72", "v2_expired", bad("72"));
    const healthy = content("73", "v2_healthy", "ltoken=legacy;ltuid=73;cookie_token_v2=v2_new;account_id_v2=73;account_mid_v2=fixture-mid;");
    await Promise.all([writeFile(join(root, "41.yaml"), stranded), writeFile(join(root, "42.yaml"), rejected),
      writeFile(join(root, "43.yaml"), healthy), writeFile(join(root, "44.yaml"), Bun.YAML.stringify({ account: {
        stoken_cookie: "stoken=v2_valid;stuid=74;mid=fixture-mid;", cookie: bad("74"),
      } }))]);
    const profiles = createProfileStore(root);
    const seen: string[] = [];
    const client = createProfileHoyoClient(profiles, async (url, init) => {
      if (url.pathname.endsWith("/exchange")) {
        const { src_token, dst_token_type } = JSON.parse(String(init.body));
        seen.push(src_token.token);
        if (src_token.token === "v2_expired") return Response.json({ retcode: -100 });
        return Response.json({ retcode: 0, data: dst_token_type === 2
          ? { ltoken: "legacy" } : { cookie_token: "v2_new", aid: "74" } });
      }
      expect(url.pathname).toEndWith("getUserGameRolesByCookie");
      return Response.json({ retcode: 0, data: { list: [] } });
    });
    expect(await repairLegacyPassportCookies(profiles, client, new AbortController().signal)).toEqual({ repaired: 1, failed: 1 });
    expect(seen).toEqual(["v2_expired", "v2_valid", "v2_valid"]);
    expect(await Bun.file(join(root, "41.yaml")).text()).toBe(stranded);
    expect(await Bun.file(join(root, "42.yaml")).text()).toBe(rejected);
    expect(await Bun.file(join(root, "43.yaml")).text()).toBe(healthy);
    expect((await profiles.accountContext("44")).account).toMatchObject({ stuid: "74", ltuid: "74", stoken: "v2_valid", mid: "fixture-mid",
      cookie: "ltoken=legacy;ltuid=74;cookie_token_v2=v2_new;account_id_v2=74;account_mid_v2=fixture-mid;" });
    expect(await repairLegacyPassportCookies(profiles, client, AbortSignal.abort())).toEqual({ repaired: 0, failed: 0 });
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
    for (const command of ["#配置2", "#资料2", "#绝区零设备信息2"]) {
      expect(await registry.dispatch(`${command} 多余参数`, user)).toBe("用法：#配置 或 #配置2");
    }
    expect(await registry.dispatch("#Lotus配置2", user)).toBeUndefined();
    expect(await registry.dispatch("#荷花资料卡2", user)).toBeUndefined();
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

test("网页签到一次保存现有开关，保留主人排期、通知群及未展示的旧设置", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-web-checkin-preferences-"));
  try {
    const file = join(root, "42-2.yaml");
    const original = {
      enabled: false, account: { cookie: "test-cookie", stoken: "test-token" },
      profile: { id: 2, notify: { enable: true, prefer: "group", fallback_groups: ["71"], extension: "保留" } },
      schedule: { mode: "fixed", fixed_time: "11:01" },
      games: { cn: { enable: false, genshin: { checkin: false, black_list: ["81"] }, hna: { checkin: true } },
        os: { enable: true, cookie: "test-os", verified_account_id: "77", verified_realm: "EU", lang: "zh-tw",
          honkai3rd: { checkin: false, black_list: ["91"] }, honkai2: { checkin: true } } },
      mihoyobbs: { enable: false, tasks: { checkin: false, read: true, like: true }, checkin_list: [1, 6] },
      cloud_games: { cn: { genshin: { enable: false, token: "test-cloud" }, zzz: { enable: true } }, extra: "保留" },
    };
    await writeFile(file, Bun.YAML.stringify(original));
    const profiles = createProfileStore(root);
    const current = await profiles.webCheckinSettings("42", 2);
    expect(current).toMatchObject({ enabled: false, notify: true, community: false, cnEnabled: false,
      forums: [1, 6], cloud: { genshin: false, zzz: true }, cloudBound: { genshin: true, zzz: false }, games: {
      genshin: false, honkai_sr: true, zzz: true, honkai2: false, honkai3rd: false, tears_of_themis: false,
    }, osEnabled: true, osBound: true, os: { genshin: false, honkai_sr: false, zzz: false, honkai3rd: false, tears_of_themis: false } });
    const patch = { enabled: true, notify: false, community: true, games: { ...current.games, genshin: true },
      forums: [6, 8], cloud: { genshin: true, zzz: false }, osEnabled: false, os: { ...current.os, honkai3rd: true } };
    const saved = await profiles.setWebCheckinSettings("42", 2, current.revision, patch);
    expect(await profiles.webCheckinSettings("42", 2)).toMatchObject({ ...patch, revision: saved.revision, cnEnabled: false });
    expect(Bun.YAML.parse(await readFile(file, "utf8"))).toMatchObject({
      ...original, enabled: true,
      profile: { ...original.profile, notify: { ...original.profile.notify, enable: false } },
      games: { cn: { ...original.games.cn, genshin: { checkin: true, black_list: ["81"] } },
        os: { ...original.games.os, enable: false, honkai3rd: { checkin: true, black_list: ["91"] } } },
      mihoyobbs: { ...original.mihoyobbs, enable: true, checkin_list: [6, 8], tasks: { ...original.mihoyobbs.tasks, checkin: true } },
      cloud_games: { ...original.cloud_games, cn: { genshin: { enable: true, token: "test-cloud" }, zzz: { enable: false } } },
    });
    const unchanged = await readFile(file);
    await expect(profiles.setWebCheckinSettings("42", 2, current.revision, patch)).rejects.toMatchObject({ code: "changed" });
    await expect(profiles.setWebCheckinSettings("42", 2, saved.revision, {
      ...patch, forums: [2], cloud: { genshin: false, zzz: true },
    })).rejects.toMatchObject({ code: "invalid" });
    expect(await readFile(file)).toEqual(unchanged);
    expect((await profiles.checkinSettings("42", 2)).games.genshin?.enabled).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
