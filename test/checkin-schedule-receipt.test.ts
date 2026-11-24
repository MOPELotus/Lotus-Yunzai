import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProfileAccountContext } from "@lotus-yunzai/account";
import { runGuardedLegacyCheckinTransfer } from "../lib/checkin-schedule-handback.ts";
import { generateCheckinSchedulePlan } from "../lib/checkin-schedule-plan.ts";
import { createCheckinScheduleStore } from "../lib/checkin-schedule-store.ts";
import { createCheckinScheduler } from "../lib/checkin-scheduler.ts";

const date = "2026-11-21";
const at = Date.parse(date + "T18:00:00+08:00");
const nextAt = new Date(at + 600_000).toISOString();
const profile = { qq: "91001", profileId: 1, enabled: true };
const accountKey = createHash("sha256").update(JSON.stringify([profile.qq, profile.profileId, "81526"])).digest("hex");
const loadAccount = async (): Promise<ProfileAccountContext> => ({
  qq: profile.qq, profileId: profile.profileId, revision: "fixture",
  account: { stuid: "81526", ltuid: "", mid: "changed", cookie: "", stoken: "", stokenCookie: "", ltoken: "" },
  device: { id: "", fp: "", name: "", model: "", androidVersion: "", raw: {} },
});
const config = { mode: "fixed" as const, fixed_time: "18:00" };

async function withStore(run: (store: ReturnType<typeof createCheckinScheduleStore>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "lotus-checkin-receipt-"));
  try {
    const store = createCheckinScheduleStore(directory);
    const plan = generateCheckinSchedulePlan({ date, now: at, profiles: [profile], config });
    await store.update(date, () => ({ plan: { ...plan, entries: [{ ...plan.entries[0]!,
      communityRetry: { forums: ["6"], games: ["honkai_sr"], attempts: 2, nextAt: new Date(at).toISOString(), accountKey, verifiedUnsent: true },
    }] }, result: undefined }));
    await run(store);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("固定旧端只回交未提交游戏，提交结果未知的社区不再发送", async () => {
  await withStore(async store => {
    let now = at, count = 0;
    const scheduler = createCheckinScheduler({ store, config, now: () => now, listProfiles: async () => [profile],
      async runProfile(_entry, context) {
        expect(context.gameRetryKeys).toEqual(["honkai_sr"]);
        expect(context.communityRetryForums).toEqual([]);
        expect(context.communityWrites?.previous["6"]).toBe("unconfirmed");
        count++;
        return { ok: true, stage: "checkin", status: "complete" };
      },
    });
    expect(await runGuardedLegacyCheckinTransfer(store, date, { now: () => now, loadAccount, async runInline({ entries, ...transfer }) {
      expect((await store.read(date))?.entries[0]).toMatchObject({ done: true, stage: "legacy-unconfirmed" });
      expect((await scheduler.tick()).status).toBe("locked");
      return { ...transfer, entries: entries.map(({ qq, profileId, accountKey }) => ({
        qq, profileId, accountKey, attempts: 3, nextAt,
        outcomes: [{ target: "community:6", status: "unknown" }, { target: "game:honkai_sr", status: "unsent" }],
      })) };
    } })).toEqual({ acquired: true, value: 1 });
    now = Date.parse(nextAt);
    expect((await scheduler.tick(undefined, { communityRetriesOnly: true })).completed).toBe(1);
    expect((await scheduler.tick()).completed).toBe(0);
    expect(count).toBe(1);
    expect((await store.read(date))?.entries[0]).toMatchObject({ done: true, ok: false, communityWrites: { "6": "unconfirmed" } });
  });
});

for (const fault of ["scope", "digest", "wrong-day", "duplicate", "lost"] as const) {
  test(`交还回执 ${fault} 异常后冻结档案`, async () => {
    await withStore(async store => {
      const transfer = runGuardedLegacyCheckinTransfer(store, date, { now: () => at, loadAccount, async runInline({ entries, ...transfer }) {
        if (fault === "lost") throw new Error("接收者退出");
        return { ...transfer, ...(fault === "digest" && { planDigest: "a".repeat(64) }), entries: entries.map(({ qq, profileId, accountKey }) => ({
          qq, profileId, accountKey, attempts: 3, nextAt: fault === "wrong-day" ? "2026-11-22T00:00:00+08:00" : nextAt,
          outcomes: [{ target: fault === "scope" ? "community:8" : fault === "duplicate" ? "game:honkai_sr" : "community:6", status: "completed" },
            { target: "game:honkai_sr", status: "unsent" }],
        })) };
      } });
      await expect(transfer).rejects.toThrow();
      expect((await store.read(date))?.entries[0]).toMatchObject({ done: true, stage: "legacy-unconfirmed" });
      const scheduler = createCheckinScheduler({ store, config, now: () => Date.parse(nextAt), listProfiles: async () => [profile],
        async runProfile() { throw new Error("冻结档案不应被领取"); },
      });
      expect((await scheduler.tick()).completed).toBe(0);
    });
  });
}

test("旧副本有历史执行进度的档案保持原样，两边仍启用的目标才可交还", async () => {
  await withStore(async store => {
    const source = (await store.read(date))!;
    const historic = { ...source, entries: [{ ...source.entries[0]!, done: true, ok: true }] };
    const none = () => { throw new Error("不能重新执行旧版已有进度的档案"); };
    expect(await runGuardedLegacyCheckinTransfer(store, date, {
      now: () => at, legacy: historic, loadAccount, runInline: none,
    })).toEqual({ acquired: true, value: 0 });
    expect(await store.read(date)).toEqual(source);
    expect(await runGuardedLegacyCheckinTransfer(store, date, {
      now: () => at,
      loadAccount: async () => ({ ...await loadAccount(), checkinTargets: { forums: [], games: ["honkai_sr"] } }),
      async runInline({ entries, ...transfer }) {
        expect(entries[0]?.targets).toEqual(["game:honkai_sr"]);
        return { ...transfer, entries: entries.map(({ qq, profileId, accountKey }) => ({
          qq, profileId, accountKey, attempts: 3, outcomes: [{ target: "game:honkai_sr", status: "completed" }],
        })) };
      },
    })).toEqual({ acquired: true, value: 1 });
    expect((await store.read(date))?.entries[0]).toMatchObject({ done: true, ok: false });
  });
});
