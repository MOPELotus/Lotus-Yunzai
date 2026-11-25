import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileStore } from "@lotus-yunzai/account";
import { createGameProfileDefaults } from "../lib/game-profile-defaults.ts";
import { createGameProfileCommands, matchGameProfileCommand } from "../lib/game-profile-commands.ts";
import { lockFile } from "../lib/file-lock.ts";

const scope = () => ({ user: 42, signal: new AbortController().signal, isCurrent: () => true });
function profile(id: number, account = 4200 + id) {
  return Bun.YAML.stringify({ user: { qq: "42" }, profile: { id }, account: {
    stuid: String(account), cookie: `account_id=${account};ltoken=fixture-private-cookie`, stoken: "fixture-private-stoken",
    current_uid: { gs: String(100000040 + id), sr: String(800000040 + id), zzz: String(82000040 + id) },
    game_roles: {
      gs: [{ uid: String(100000040 + id), game_biz: "hk4e_cn", region: "cn_gf01" },
        { uid: String(500000040 + id), game_biz: "hk4e_cn", region: "cn_qd01" }],
      sr: [{ uid: String(800000040 + id), game_biz: "hkrpg_cn", region: "prod_gf_cn" }],
      zzz: [{ uid: String(82000040 + id), game_biz: "nap_cn", region: "prod_gf_cn" }],
    },
  } });
}

async function fixture(run: (root: string, profiles: ReturnType<typeof createProfileStore>, defaults: ReturnType<typeof createGameProfileDefaults>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "lotus-game-profile-command-"));
  try {
    const directory = join(root, "profiles");
    await mkdir(directory);
    for (const id of [1, 2, 3]) await writeFile(join(directory, `42${id === 1 ? "" : "-" + id}.yaml`), profile(id));
    await writeFile(join(directory, "42-4.yaml"), 'user: {qq: "42"}\nprofile: {id: 4}\n');
    const profiles = createProfileStore(directory);
    const defaults = createGameProfileDefaults(join(root, "defaults"), profiles, lockFile);
    await run(root, profiles, defaults);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("显式切档区分游戏，非法编号和尾参数不截断为有效操作", () => {
  expect(matchGameProfileCommand("#切换档案2")).toEqual({ kind: "switch", game: "gs", profileId: 2 });
  expect(matchGameProfileCommand("#切换档案 255")).toEqual({ kind: "switch", game: "gs", profileId: 255 });
  expect(matchGameProfileCommand("#星铁切换档案3")).toEqual({ kind: "switch", game: "sr", profileId: 3 });
  expect(matchGameProfileCommand("*切换档案 2")).toEqual({ kind: "switch", game: "sr", profileId: 2 });
  expect(matchGameProfileCommand("%切换档案2")).toEqual({ kind: "switch", game: "zzz", profileId: 2 });
  expect(matchGameProfileCommand("#当前档案")).toEqual({ kind: "current", game: undefined });
  expect(matchGameProfileCommand("#绝区零档案列表")).toEqual({ kind: "list", game: "zzz" });
  for (const value of ["", "0", "01", "256", "9999", "-1", "2 extra", "abc"]) {
    expect(matchGameProfileCommand("#切换档案" + value)).toEqual({ kind: "invalid", game: "gs" });
  }
  expect(matchGameProfileCommand("#档案列表 2")).toEqual({ kind: "invalid", game: "gs" });
  expect(matchGameProfileCommand("#切换角色2")).toBeUndefined();
});

test("当前档案与列表只读，只展示本人登录档案且无凭据", () => fixture(async (root, profiles, defaults) => {
  const command = createGameProfileCommands(profiles, defaults);
  const before = await readFile(join(root, "profiles", "42-2.yaml"), "utf8");
  const current = await command(matchGameProfileCommand("#当前档案")!, scope());
  expect(current).toContain("原神：档案 1");
  expect(current).toContain("星铁：档案 1");
  const result = await command(matchGameProfileCommand("#档案列表")!, scope());
  expect(result).toContain("档案 2 · 原神、星铁、绝区零");
  expect(result).not.toContain("档案 4 ·");
  expect(result).not.toContain("fixture-private");
  expect(result).not.toContain("4202");
  expect(result).not.toContain("100000042");
  expect(await Bun.file(join(root, "defaults", "42", "1.json")).exists()).toBe(false);
  expect(await readFile(join(root, "profiles", "42-2.yaml"), "utf8")).toBe(before);
}));

test("切默认档案不改档案内角色，独立设置三游并可显式切回档案1", () => fixture(async (root, profiles, defaults) => {
  const command = createGameProfileCommands(profiles, defaults);
  const source = join(root, "profiles", "42-2.yaml");
  const before = await readFile(source, "utf8");
  expect(await command(matchGameProfileCommand("#切换档案2")!, scope())).toBe("原神默认档案已切换为 2。");
  expect(await defaults.read("42")).toEqual({ gs: 2 });
  expect(await command(matchGameProfileCommand("*切换档案3")!, scope())).toBe("星铁默认档案已切换为 3。");
  expect(await defaults.read("42")).toEqual({ gs: 2, sr: 3 });
  expect(await readFile(source, "utf8")).toBe(before);
  expect((await profiles.requestSelectedContext("42", 2, "gs")).role.uid).toBe("100000042");
  expect(await command(matchGameProfileCommand("#切换档案1")!, scope())).toBe("原神默认档案已切换为 1。");
  expect(await defaults.read("42")).toEqual({ sr: 3 });
  const saved = await Bun.file(join(root, "defaults", "42", "1.json")).text();
  expect(saved).not.toContain("fixture");
  expect(saved).not.toContain("100000042");
}));

test("缺登录、他人及已撤销会话不能切档，查看无登录档案不创建偏好", () => fixture(async (root, profiles, defaults) => {
  const command = createGameProfileCommands(profiles, defaults);
  expect(await command(matchGameProfileCommand("#切换档案4")!, scope())).toBe("请先登录档案 4。");
  expect(await command(matchGameProfileCommand("#切换档案2")!, { ...scope(), user: 43 })).toBe("请先登录档案 2。");
  expect(await command(matchGameProfileCommand("#切换档案2")!, { ...scope(), signal: AbortSignal.abort() })).toBeUndefined();
  expect(await command(matchGameProfileCommand("#切换档案2")!, { ...scope(), isCurrent: () => false })).toBeUndefined();
  expect(await command(matchGameProfileCommand("#切换档案2")!, { ...scope(), isDelegated: true })).toBeUndefined();
  expect(await defaults.read("42")).toEqual({});
  const list = await command(matchGameProfileCommand("#档案列表")!, { ...scope(), user: 43 });
  expect(list).toContain("尚无登录档案");
  expect(await Bun.file(join(root, "defaults", "43", "1.json")).exists()).toBe(false);
  const noStarRail = Bun.YAML.parse(profile(3)) as { account: { game_roles: { sr: unknown[] } } };
  noStarRail.account.game_roles.sr = [];
  await writeFile(join(root, "profiles", "42-3.yaml"), Bun.YAML.stringify(noStarRail));
  expect(await command(matchGameProfileCommand("*切换档案3")!, scope())).toBe("档案 3 没有已同步的星铁角色，请先同步角色。");
}));

test("锁前换号和选中角色变化不会提交旧档案偏好", () => fixture(async (root, profiles, defaults) => {
  const initial = await profiles.requestSelectedContext("42", 1, "gs");
  await defaults.select("gs", 1, initial.role.uid, initial.revision, scope());
  let read = false;
  const command = createGameProfileCommands({ ...profiles, async requestSelectedContext(qq, id, game) {
    const source = await profiles.requestSelectedContext(qq, id, game);
    if (!read) {
      read = true;
      await writeFile(join(root, "profiles", "42-2.yaml"), profile(2, 9999));
    }
    return source;
  } }, defaults);
  expect(await command(matchGameProfileCommand("#切换档案2")!, scope())).toBe("档案或会话已变更，请重试。");
  expect(await defaults.read("42")).toEqual({});
}));

test("两个游戏并发切档以同一原子偏好存储合并，不覆盖其他游戏", () => fixture(async (_root, profiles, defaults) => {
  const command = createGameProfileCommands(profiles, defaults);
  const results = await Promise.all([
    command(matchGameProfileCommand("#切换档案2")!, scope()),
    command(matchGameProfileCommand("*切换档案3")!, scope()),
  ]);
  expect(results).toEqual(["原神默认档案已切换为 2。", "星铁默认档案已切换为 3。"]);
  expect(await defaults.read("42")).toEqual({ gs: 2, sr: 3 });
}));

test("等待偏好文件锁时会话撤销，解锁后仍不能写入旧请求", () => fixture(async (root, profiles) => {
  const directory = join(root, "waiting-defaults");
  await mkdir(join(directory, "42"), { recursive: true });
  const blocker = await lockFile(join(directory, "42", ".1.game-profile-defaults.sqlite"), "测试锁");
  const entering = Promise.withResolvers<void>();
  const defaults = createGameProfileDefaults(directory, profiles, async (...args) => {
    entering.resolve();
    return lockFile(...args);
  });
  const control = new AbortController();
  const command = createGameProfileCommands(profiles, defaults);
  const pending = command(matchGameProfileCommand("#切换档案2")!, { ...scope(), signal: control.signal });
  try {
    await entering.promise;
    control.abort();
  } finally { blocker.close(); }
  expect(await pending).toBeUndefined();
  expect(await defaults.read("42")).toEqual({});
  expect(await Bun.file(join(directory, "42", "1.json")).exists()).toBe(false);
}));
