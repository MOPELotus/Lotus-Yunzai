import { expect, test } from "bun:test";
import type { MessageFallbackContext } from "../lib/commands.ts";
import { createPanelRebuild } from "../lib/panel-rebuild.ts";

const command = "#重建原铁 间隔0";

function fixture(render: Parameters<typeof createPanelRebuild>[2] = async () => { throw new Error("fixture no renderer"); }) {
  const reads: string[] = [];
  const replies: unknown[] = [];
  const requester = new AbortController();
  const lifecycle = new AbortController();
  const role = { uid: "100123456", nickname: "", gameBiz: "fixture", region: "fixture", chosen: true };
  const rebuild = createPanelRebuild({
    async listCheckinProfiles() {
      reads.push("list");
      return [
        { qq: "42", profileId: 1, loggedIn: true },
        { qq: "42", profileId: 2, loggedIn: true },
        { qq: "43", profileId: 1, loggedIn: true },
        { qq: "44", profileId: 1, loggedIn: false },
      ].map(profile => ({ ...profile, enabled: false, name: "",
        schedule: { mode: "inherit" as const, fixedTime: undefined, allowRandom: false } }));
    },
    async savedRole(qq, profileId, game) {
      reads.push(`${qq}:${profileId}:${game}`);
      if (qq === "43" && game === "sr") throw new Error("no role");
      return role;
    },
  }, lifecycle.signal, render);
  let owner = true;
  return {
    ...rebuild, reads, replies, requester,
    revoke() { owner = false; },
    invoke(overrides: Partial<MessageFallbackContext> = {}) {
      return rebuild.fallback(command, {
        message_type: "private", user_id: 7, isMaster: true,
        isBotMaster: id => id === 7 && owner, canManagePackages: true, normalizedMessage: command,
        privateCredentialSignal: requester.signal, reply(value) { replies.push(value); return true; },
        ...overrides,
      });
    },
  };
}

test("only a bound private bot owner can read all profiles for panel rebuild", async () => {
  const rebuild = fixture();
  rebuild.register("gs", async () => { throw new Error("unexpected update"); });
  for (const overrides of [
    { isMaster: false }, { isBotMaster: () => false }, { message_type: "group" as const },
    { privateCredentialSignal: undefined }, { canManagePackages: undefined }, { isDelegated: true as const },
  ]) {
    expect(await rebuild.invoke(overrides)).toContain("机器人主人在已绑定的私聊");
  }
  expect(await rebuild.invoke({ normalizedMessage: "#清理绝区零" })).toBeUndefined();
  expect(rebuild.reads).toEqual([]);
  expect(rebuild.replies).toEqual([]);
});

test("rebuild retries a duplicate from another login after failure and deduplicates success per QQ, UID and game", async () => {
  const rebuild = fixture();
  const calls: string[] = [];
  rebuild.register("gs", async (qq, profileId, _, signal, verify) => {
    verify();
    expect(signal.aborted).toBe(false);
    calls.push(`gs:${qq}:${profileId}`);
    if (qq === "42" && profileId === 1) throw new Error("fixture secret");
    return true;
  });
  rebuild.register("sr", async (qq, profileId) => {
    calls.push(`sr:${qq}:${profileId}`);
    return true;
  });
  const result = await rebuild.invoke();
  expect(result).toContain("更新 3 项，跳过 1 项，失败 1 项");
  expect(result).not.toContain("fixture secret");
  expect(result).toContain("QQ 42 · P2 · 原神 · UID 100123456：更新成功");
  expect(calls).toEqual(["gs:42:1", "sr:42:1", "gs:42:2", "gs:43:1"]);
  expect(rebuild.reads).not.toContain("44:1:gs");
  expect(rebuild.replies).toHaveLength(1);
});

test("the legacy cleanup alias returns the native status image after a safe rebuild", async () => {
  const png = Uint8Array.of(1, 2, 3);
  const rebuild = fixture(async (title, lead, rows) => {
    expect(title).toBe("原神和星铁面板重建");
    expect(lead).toBe("更新 2 项，跳过 1 项，失败 0 项。");
    expect(rows).toHaveLength(3);
    return { png };
  });
  rebuild.register("gs", async () => true);
  expect(await rebuild.invoke({ normalizedMessage: "#清理原铁 间隔0" })).toEqual({ type: "image", file: png });
});

test("rebuild refuses overlap and stops when the current bot owner authorization changes", async () => {
  const rebuild = fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let attempts = 0;
  rebuild.register("gs", async (_, __, ___, _signal, verify) => {
    attempts++;
    entered.resolve();
    await release.promise;
    verify();
    return true;
  });
  const running = rebuild.invoke();
  await entered.promise;
  expect(await rebuild.invoke()).toContain("正在重建");
  rebuild.revoke();
  release.resolve();
  expect(await running).toContain("提前结束");
  expect(attempts).toBe(1);
});
