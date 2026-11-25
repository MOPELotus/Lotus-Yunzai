import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileStore, type ProfileAccountContext } from "../packages/account/index.ts";
import { checkinBatchRefreshCommands } from "../lib/checkin-batch-refresh-commands.ts";
import type { MessageFallbackContext } from "../lib/commands.ts";
import { segment } from "../lib/messages.ts";

const command = "#批量刷新签到";
const fixtures = { cookie: "cookie_token=synthetic", stoken: "synthetic" };

async function withProfiles(run: (profiles: ReturnType<typeof createProfileStore>, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "lotus-checkin-batch-refresh-"));
  try {
    await run(createProfileStore(directory), directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function put(directory: string, qq: string, id: number, { enabled = true, loggedIn = true } = {}) {
  return writeFile(join(directory, `${qq}${id === 1 ? "" : `-${id}`}.yaml`), Bun.YAML.stringify({
    version: 1, user: { qq }, profile: { id }, account: loggedIn ? fixtures : {}, enabled,
  }));
}

function fixture(
  profiles: ReturnType<typeof createProfileStore>,
  refreshProfile: (account: ProfileAccountContext) => Promise<{ rolesSynced: boolean }>,
  { signal = new AbortController().signal, image = false } = {},
) {
  const messages: string[] = [];
  const cards: { title: string; lead: string; lines: readonly string[] }[] = [];
  const png = Buffer.from("mock bytes");
  const module = checkinBatchRefreshCommands({
    profiles, signal, makeClient: () => ({ refreshProfile }),
    async render(title, lead, lines) {
      cards.push({ title, lead, lines });
      if (image) return { png };
      throw new Error("渲染不可用");
    },
  });
  return {
    messages, cards, png,
    run(overrides: Partial<MessageFallbackContext> = {}) {
      return module.fallback?.(command, {
        message_type: "private", user_id: 51, self_id: 90, isMaster: true,
        normalizedMessage: command, isBotMaster: () => true,
        reply(reply) { messages.push(String(reply)); return true; },
        ...overrides,
      });
    },
  };
}

test("非主人不能开始批量刷新，主人按原来的全局顺序逐档刷新并保留部分结果", async () => {
  await withProfiles(async (profiles, directory) => {
    await put(directory, "51", 1);
    await put(directory, "51", 2, { enabled: false });
    await put(directory, "52", 1, { loggedIn: false });
    await put(directory, "53", 1);
    await put(directory, "54", 1);
    const calls: string[] = [];
    const { run, messages } = fixture(profiles, async account => {
      const { qq, profileId, revision } = account;
      calls.push(`${qq}:${profileId}`);
      expect(revision).toBe((await profiles.accountContext(qq, profileId)).revision);
      if (qq === "53") throw new Error("cookie/stoken/synthetic secret");
      if (qq === "54") {
        await profiles.clearLogin(qq, profileId);
        await profiles.saveRefreshedCredentials(qq, profileId, revision, { cookie: "new_cookie=synthetic", ltoken: "new" });
      }
      return { rolesSynced: profileId !== 2 };
    });
    expect(await run({ isMaster: false })).toBe("只有 bot 主人可以批量刷新签到账号。");
    expect(await run({ normalizedMessage: `${command} 2` })).toBeUndefined();
    expect(calls).toEqual([]);
    expect(messages).toEqual([]);
    const result = await run();
    expect(messages).toEqual(["正在批量刷新所有档案的登录信息。"]);
    expect(calls).toEqual(["51:1", "51:2", "53:1", "54:1"]);
    expect(result).toContain("Cookie 已刷新 2/5");
    expect(result).toContain("角色已同步 1 个档案");
    expect(result).toContain("QQ 51 · P2：Cookie 已刷新，角色暂未同步");
    expect(result).toContain("QQ 52 · P1：档案尚未登录");
    expect(result).toContain("QQ 53 · P1：刷新失败，请核对登录状态");
    expect(result).toContain("QQ 54 · P1：档案已变化");
    expect(result).not.toContain("synthetic");
    expect((await profiles.summary("54", 1)).loggedIn).toBe(false);
  });
});

test("同一批次执行时不会启动第二批，完成后可再次调用，图卡首 14 项和总数独立", async () => {
  await withProfiles(async (profiles, directory) => {
    for (let id = 1; id <= 15; id++) await put(directory, "51", id);
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let count = 0;
    const { run, messages, cards, png } = fixture(profiles, async () => {
      if (++count === 1) { started.resolve(); await finish.promise; }
      return { rolesSynced: true };
    }, { image: true });
    const first = run();
    try {
      await started.promise;
      expect(await run()).toBe("签到账号正在批量刷新。");
      expect(count).toBe(1);
      expect(messages).toHaveLength(1);
    } finally {
      finish.resolve();
      expect(await first).toEqual(segment.image(png));
    }
    expect(count).toBe(15);
    expect(cards[0]).toMatchObject({ title: "批量刷新", lead: expect.stringContaining("Cookie 已刷新 15/15") });
    expect(cards[0]?.lines).toHaveLength(14);
    expect(await run()).toEqual(segment.image(png));
    expect(count).toBe(30);
  });
});

test("停机不启动下一档案，不渲染过期回执", async () => {
  await withProfiles(async (profiles, directory) => {
    await put(directory, "51", 1);
    await put(directory, "51", 2);
    const controller = new AbortController();
    const visited: number[] = [];
    const { run, messages, cards } = fixture(profiles, async ({ profileId }) => {
      visited.push(profileId);
      controller.abort();
      return { rolesSynced: true };
    }, { signal: controller.signal });
    expect(await run()).toBeUndefined();
    expect(await run()).toBeUndefined();
    expect(visited).toEqual([1]);
    expect(messages).toHaveLength(1);
    expect(cards).toEqual([]);
  });
});
