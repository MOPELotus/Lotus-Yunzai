import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockFile } from "../lib/file-lock.ts";
import { createWishCommands } from "../plugins/genshin/wish-sim/commands.ts";
import { drawWish, emptySession, prepareWeaponPath } from "../plugins/genshin/wish-sim/draw.ts";
import { createWishPoolSource } from "../plugins/genshin/wish-sim/pools.ts";

const time = Date.parse("2026-09-06T16:00:00+08:00");
const poolSource = createWishPoolSource({ themeDirectory: "/nonexistent" });

test("Flower hard pity, shared character pools and weapon rotation", async () => {
  const [role, role2, permanent, weapon] = await Promise.all(
    (["role", "role2", "permanent", "weapon"] as const).map((kind) => poolSource(kind, time)),
  );
  const state = emptySession(1);
  state.role.num5 = 88;
  state.role.isUp5 = true;
  expect(drawWish(role!, state, 1, () => 0.999)).toMatchObject([{ star: 3 }]);
  expect(drawWish(role2!, state, 1, () => 0.999)).toEqual([
    { name: "伊涅芙", type: "role", star: 5, at: 1, pity: 90, guaranteed: "大保底" },
  ]);
  expect(state.permanent.num5).toBe(0);
  expect(drawWish(permanent!, state, 1, () => 0.999)).toMatchObject([{ star: 3 }]);

  prepareWeaponPath(state.weapon, weapon!);
  state.weapon.num5 = 79;
  state.weapon.lifeNum = 1;
  expect(drawWish(weapon!, state, 1, () => 0.999)).toMatchObject([
    { name: "血染荒城", star: 5, pity: 80, guaranteed: "定轨" },
  ]);
  expect(state.weapon.lifeNum).toBe(0);
  prepareWeaponPath(state.weapon, { ...weapon!, rotation: "next" });
  expect(state.weapon.target).toBeUndefined();
});

test("accepts Flower draw commands and keeps daily allowance atomic across conversations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lotus-wish-test-"));
  let clock = Date.parse("2026-09-06T03:59:59+08:00");
  const signal = new AbortController().signal;
  const create = () => createWishCommands({
    lockFile, signal, storeDirectory: dir, poolSource, now: () => clock,
    random: () => 0.99, render: async () => { throw new Error("test text reply"); },
  });
  const command = create();
  const user = { user_id: 333 };
  try {
    expect(await command("#武器十连常驻非法", user)).toBeUndefined();
    expect(await command("#原神抽卡记录2", user)).toBeUndefined();
    expect(await command("#星铁十连", user)).toBeUndefined();
    expect(await command("#定轨2", user)).toContain("[√] 支离轮光");
    expect(await command("#定轨查询", user)).toContain("支离轮光");
    const replies = await Promise.all([
      command("#常驻十连", user), create()("#十连常驻", { ...user, group_id: 334 }),
    ]);
    expect(replies.filter((reply) => typeof reply === "string" && reply.includes("相遇之缘不足"))).toHaveLength(1);
    expect(await command("#查看蓝球", user)).toContain("0个相遇之缘");
    clock += 1_000;
    expect(await create()("#查看蓝球", user)).toContain("今日成功领取100个纠缠之缘和10个相遇之缘");
    expect(await command("#单抽2", user)).toContain("角色池 · 伊涅芙");
    expect(await command("#百连", user)).toContain("需要100个，你还有99个");
    const archive = JSON.parse(await readFile(join(dir, "333", "1.json"), "utf8"));
    expect(archive.conversations.private.session.role.num5).toBe(1);
    expect(archive.conversations.private.session.weapon.target).toBe("支离轮光");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
