import { linkHostPackages } from "./host-fixture.ts";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileStore } from "@lotus-yunzai/account";
import { matchGameLoginRemoval, removeSelectedGameLogin } from "../lib/account-commands.ts";
import { matchOwnRoleSelection } from "../lib/own-role-selection.ts";
import { matchPanelSignatureCommand } from "../lib/panel-signature.ts";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const games = {
  gs: ["100000042", "100000044"],
  sr: ["800000042", "800000044"],
  zzz: ["82000042", "82000044"],
} as const;
function document(qq: string, id: number, own: Readonly<Record<keyof typeof games, readonly string[]>> = games) {
  const roles = (uids: readonly string[], region: string, gameBiz: string) =>
    uids.map((uid, index) => ({ uid, nickname: `样本${index + 1}`, region, game_biz: gameBiz }));
  return {
    user: { qq }, profile: { id }, account: {
      stuid: "99042", stoken: "fixture-private-token", cookie: "ltuid=99042; ltoken=fixture-private-cookie",
      current_uid: { gs: own.gs[0], sr: own.sr[0], zzz: own.zzz[0], bh3: "7654321" },
      game_roles: { gs: roles(own.gs, "cn_gf01", "hk4e_cn"), sr: roles(own.sr, "prod_gf_cn", "hkrpg_cn"),
        zzz: roles(own.zzz, "prod_gf_cn", "nap_cn") },
    },
  };
}

test("UID 区分角色序号、实际 UID 和独立的签名验证", () => {
  expect(matchOwnRoleSelection("#UID")).toEqual({ game: "gs", slot: undefined, profileId: undefined });
  expect(matchOwnRoleSelection("#星铁我的UID02 档案 17")).toEqual({ game: "sr", slot: 2, profileId: 17 });
  expect(matchOwnRoleSelection("#绝区零UID0")?.slot).toBe(0);
  expect(matchOwnRoleSelection("#UID999")?.slot).toBe(999);
  expect(matchOwnRoleSelection("#设置原神uid100000042")).toEqual({ game: "gs", profileId: 1, uid: "100000042" });
  expect(matchOwnRoleSelection("#切换崩铁UID2 800000044")).toEqual({ game: "sr", profileId: 2, uid: "800000044" });
  expect(matchOwnRoleSelection("#切换星铁UID2800000044")).toEqual({ game: "sr", profileId: 1, uid: "2800000044" });
  expect(matchOwnRoleSelection("#设置绝UID 82000044")).toEqual({ game: "zzz", profileId: 1, uid: "82000044" });
  expect(matchOwnRoleSelection("#绑定绝区零UID82000042")).toEqual({ game: "zzz", profileId: 1, uid: "82000042" });
  expect(matchOwnRoleSelection("#绑定绝uid2　82000044")).toEqual({ game: "zzz", profileId: 2, uid: "82000044" });
  for (const text of ["#UID100000042", "#UID 42", "#UID-1", "#UID 档案0", "#UID 档案02", "#解绑uid2",
    "#绑定UID", "#绑定UID100000042", "#绑定原神UID100000042", "#验证UID100000042", "#取消验证UID100000042",
    "#绑定星铁UID800000042", "#绑定绝区零uId82000044", "#绑定绝区零 UID82000044", "#绝区零绑定UID82000044",
    "#切换星铁UID255800000044", "#设置原神UID02 100000042", "#切换绝区零UID2 82000044 多余参数"]) {
    expect(matchOwnRoleSelection(text)).toBeUndefined();
  }
  expect(matchPanelSignatureCommand("#绑定UID100000042")).toMatchObject({ action: "begin", uid: "100000042" });
  expect(matchPanelSignatureCommand("#UID2")).toBeUndefined();
});

test("旧删除 CK 识别游戏前缀，新增的同游戏登录档案阻止在途清除", async () => {
  expect(matchGameLoginRemoval("删除CK")).toBe("gs");
  expect(matchGameLoginRemoval("#星铁删除COOKIE")).toBe("sr");
  expect(matchGameLoginRemoval("#绝区零删除CK")).toBe("zzz");
  expect(matchGameLoginRemoval("#删除Cookie")).toBeUndefined();
  expect(matchGameLoginRemoval("#删除CK2")).toBeUndefined();
  const root = await mkdtemp(join(tmpdir(), "lotus-game-login-removal-"));
  try {
    const first = join(root, "42.yaml"), second = join(root, "42-2.yaml");
    const before = Bun.YAML.stringify(document("42", 1));
    await writeFile(first, before);
    const store = createProfileStore(root);
    let reads = 0;
    const profiles = { ...store, async listIds(qq: string) {
      if (++reads === 2) await writeFile(second, Bun.YAML.stringify(document("42", 2)));
      return store.listIds(qq);
    } };
    const scope = { user: 42, signal: new AbortController().signal, isCurrent: () => true };
    expect(await removeSelectedGameLogin(profiles, "gs", scope)).toContain("对应登录档案已变更");
    expect(await readFile(first, "utf8")).toBe(before);
    expect((await store.describe("42", 2)).loggedIn).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("角色选择只修改本人所选档案和游戏，过期授权、档案并发变更及他档 UID 禁止提交", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-own-role-selection-"));
  try {
    const path = join(root, "42.yaml");
    await writeFile(path, Bun.YAML.stringify(document("42", 1)));
    const before = await readFile(path);
    const store = createProfileStore(root);
    const first = await store.roleCatalog("42", 1);
    const signal = new AbortController().signal;
    await expect(store.selectCatalogRole("42", 1, "gs", games.sr[1]!, first.revision, signal, () => true))
      .rejects.toMatchObject({ code: "role-missing" });
    let authChecks = 0;
    await expect(store.selectCatalogRole("42", 1, "gs", games.gs[1]!, first.revision, signal, () => ++authChecks === 1))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(authChecks).toBe(2);
    expect(await readFile(path)).toEqual(before);
    const canceled = AbortSignal.abort();
    await expect(store.selectCatalogRole("42", 1, "gs", games.gs[1]!, first.revision, canceled, () => true))
      .rejects.toMatchObject({ name: "AbortError" });
    const attempts = await Promise.allSettled([
      store.selectCatalogRole("42", 1, "gs", games.gs[1]!, first.revision, signal, () => true),
      store.selectCatalogRole("42", 1, "sr", games.sr[1]!, first.revision, signal, () => true),
    ]);
    const succeeded = attempts.filter(attempt => attempt.status === "fulfilled");
    const rejected = attempts.filter(attempt => attempt.status === "rejected");
    expect(succeeded).toHaveLength(1);
    expect(rejected).toMatchObject([{ reason: { code: "changed" } }]);
    const game = attempts[0]?.status === "fulfilled" ? "gs" : "sr";
    const active = { gs: games.gs[0], sr: games.sr[0], zzz: games.zzz[0], [game]: games[game][1] };
    const latest = await store.roleCatalog("42", 1);
    expect(latest.active).toEqual(active);
    expect((await store.savedRole("42", 1, game)).uid).toBe(games[game][1]);
    expect(await store.selectCatalogRole("42", 1, game, games[game][1], latest.revision, signal, () => true))
      .toEqual({ revision: latest.revision, changed: false });
    expect(Bun.YAML.parse(await readFile(path, "utf8"))).toMatchObject({ account: {
      stoken: "fixture-private-token", current_uid: { ...active, bh3: "7654321" },
    } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OneBot 与 Milky 宿主实际派发三游 UID 列表与选槽，群内没有角色资料", async () => {
  const preload = `
const fetchInHost = globalThis.fetch;
Bun.env.LOTUS_PROFILE_DIR = "./profiles";
Bun.env.LOTUS_PASSPORT_QR_RESOURCES = "./missing-render-fixture";
globalThis.fetch = async (input, options) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname === "127.0.0.1") return fetchInHost(input, options);
  await Bun.write("./unexpected-network.txt", "attempted");
  throw new Error("role selection fixture blocks outbound requests");
};`;
  await withDualGatewayFixture("own-game-role-slots", "disablePrivate: false\n", async ({ root, sendOneBot, sendMilky, onebot, milky }) => {
    let sequence = 150;
    const replies = async (text: string, expected: string, fields?: object) => {
      sendOneBot(text, fields);
      const reply = await onebot.next("send_msg");
      expect(JSON.stringify(reply.params)).toContain(expected);
      expect(JSON.stringify(reply.params)).not.toContain("fixture-private-token");
      expect(JSON.stringify(reply.params)).not.toContain("fixture-private-cookie");
      reply.respond({ message_id: sequence++ });
      return reply.params;
    };
    const listed = await replies("#我的uid 档案2", "本人游戏角色 · 档案 2");
    expect(listed).toMatchObject({ message_type: "private", user_id: 42 });
    const text = JSON.stringify(listed);
    for (const game of ["原神", "星铁", "绝区零"]) expect(text).toContain(game);
    for (const uid of [games.gs[0], games.sr[0], games.zzz[0]]) expect(text).toContain(uid!);
    expect(text).not.toContain("100000099");
    const group = await replies("#UID2 档案2", "请私聊机器人查看或切换本人游戏角色", {
      message_type: "group", sub_type: "normal", group_id: 701,
    });
    expect(group).toMatchObject({ message_type: "group", group_id: 701 });
    expect(JSON.stringify(group)).not.toContain(games.gs[1]!);
    const all = JSON.stringify(await replies("#UID", "本人游戏角色 · 全部档案"));
    for (const uid of ["100000041", games.gs[0], games.gs[1], games.sr[0], games.zzz[0]]) expect(all).toContain(uid);
    expect(all.match(/800000042/gu)).toHaveLength(1);
    expect(all).toContain("档案 1、2 当前");
    expect(all).not.toContain("100000099");
    await replies("#设置原神UID100000044", "档案 1 没有此原神角色");
    await replies("#切换原神UID2 100000099", "档案 2 没有此原神角色");
    await replies("#绑定绝区零UID2 82000044", "请私聊机器人查看或切换本人游戏角色", {
      message_type: "group", sub_type: "normal", group_id: 701,
    });
    const ownProfiles = createProfileStore(join(root, "profiles"));
    expect((await ownProfiles.roleCatalog("42", 2)).active).toEqual({ gs: games.gs[0], sr: games.sr[0], zzz: games.zzz[0] });
    await replies("#设置原神UID2 100000042", "档案 2 · 原神当前角色已选为 100000042");
    await replies("#切换崩铁uid2 800000044", "档案 2 · 星铁当前角色已选为 800000044");
    await replies("#绑定绝区零UID2 89900042", "档案 2 没有此绝区零角色");
    await replies("#绑定绝区零UID2 82000042", "档案 2 · 绝区零当前角色已选为 82000042");
    await replies("#绑定绝UID2　82000044", "档案 2 · 绝区零当前角色已选为 82000044");
    expect((await ownProfiles.roleCatalog("42", 2)).catalog.zzz.map(({ uid }) => uid)).toEqual([...games.zzz]);
    await replies("#UID3", "档案 2 · 原神当前角色已选为 100000044");
    expect((await ownProfiles.requestContext("42", 2, "gs")).role.uid).toBe(games.gs[1]);
    expect((await ownProfiles.requestContext("42", 1, "gs")).role.uid).toBe("100000041");
    await replies("#UID02 档案2", games.gs[1]!);
    await replies("*UID2 档案2", games.sr[1]!);
    await replies("％UID2 档案2", games.zzz[1]!);
    await replies("#UID3 档案2", "没有第 3 个原神角色");
    await replies("#UID  档案3", "未找到本人档案 3");
    await replies("#UID0 档案2", "角色序号须在 1 到 99 之间");
    expect((await sendMilky("#UID")).status).toBe(200);
    const foreign = await milky.next("send_private_message");
    expect(foreign.params).toMatchObject({ user_id: 43 });
    expect(JSON.stringify(foreign.params)).toContain("100000099");
    expect(JSON.stringify(foreign.params)).not.toContain(games.gs[0]!);
    foreign.respond({ message_seq: sequence++ });
    expect((await sendMilky("#设置星铁UID800000044")).status).toBe(200);
    const choice = await milky.next("send_private_message");
    expect(choice.params).toMatchObject({ user_id: 43 });
    expect(JSON.stringify(choice.params)).toContain(games.sr[1]);
    choice.respond({ message_seq: sequence++ });
    expect((await sendMilky("#绑定绝区零uid82000044")).status).toBe(200);
    const zenless = await milky.next("send_private_message");
    expect(zenless.params).toMatchObject({ user_id: 43 });
    expect(JSON.stringify(zenless.params)).toContain("档案 1 · 绝区零当前角色已选为 82000044");
    zenless.respond({ message_seq: sequence++ });
    const profiles = createProfileStore(join(root, "profiles"));
    expect((await profiles.roleCatalog("42", 1)).active.gs).toBe("100000041");
    expect((await profiles.roleCatalog("42", 2)).active).toEqual({ gs: games.gs[1], sr: games.sr[1], zzz: games.zzz[1] });
    for (const game of ["gs", "sr", "zzz"] as const) {
      expect((await profiles.requestContext("42", 2, game)).role.uid).toBe(games[game][1]);
    }
    const milkyRoles = (await profiles.roleCatalog("43", 1)).active;
    expect(milkyRoles.gs).toBe("100000099");
    expect(milkyRoles.sr).toBe(games.sr[1]);
    expect(milkyRoles.zzz).toBe(games.zzz[1]);

    await replies("#删除CK", "多个登录档案（1、2）");
    expect((await profiles.describe("42", 1)).loggedIn).toBe(true);
    expect((await profiles.describe("42", 2)).loggedIn).toBe(true);
    await replies("#绝区零删除CK", "请在机器人好友私聊中清除本人登录信息", { message_type: "group", sub_type: "normal", group_id: 701 });
    expect((await profiles.describe("42", 2)).loggedIn).toBe(true);
    await replies("%删除CK", "已清除档案 2 的米游社登录信息");
    expect((await profiles.describe("42", 2)).loggedIn).toBe(false);
    expect((await profiles.roleCatalog("42", 2)).active.zzz).toBe(games.zzz[1]);
    await replies("#切换绝区零UID2 82000042", "档案 2 尚未登录");
    expect((await profiles.roleCatalog("42", 2)).active.zzz).toBe(games.zzz[1]);
    expect((await profiles.describe("42", 1)).loggedIn).toBe(true);
    expect((await profiles.describe("43", 1)).loggedIn).toBe(true);
    expect((await sendMilky("*删除Cookie")).status).toBe(200);
    const cleared = await milky.next("send_private_message");
    expect(cleared.params).toMatchObject({ user_id: 43 });
    expect(JSON.stringify(cleared.params)).toContain("已清除档案 1 的米游社登录信息");
    cleared.respond({ message_seq: sequence++ });
    expect((await profiles.describe("43", 1)).loggedIn).toBe(false);
    expect((await profiles.describe("42", 1)).loggedIn).toBe(true);
    expect(await Bun.file(join(root, "unexpected-network.txt")).exists()).toBe(false);
  }, 2_000, preload, async (root) => {
    const target = join(root, "profiles");
    await linkHostPackages(root);
    await mkdir(target);
    await writeFile(join(target, "42.yaml"), Bun.YAML.stringify(document("42", 1, { ...games, gs: ["100000041"], zzz: [] })));
    await writeFile(join(target, "42-2.yaml"), Bun.YAML.stringify(document("42", 2)));
    await writeFile(join(target, "43.yaml"), Bun.YAML.stringify(document("43", 1, { ...games, gs: ["100000099"] })));
  });
}, 12_000);
