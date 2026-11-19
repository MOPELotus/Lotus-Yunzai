import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPreviewRedeemRunner, type PreviewGame, type PreviewProfile } from "../lib/redeem-code-runner.ts";

const profile = { qq: "42", profileId: 2, games: ["gs"], allowNewJournal: true } as const;
const oldProfile = { qq: "42", profileId: 3, games: ["gs"] } as const;
const stamp = 1_793_000_000_000;
const role = { uid: "100000042", region: "cn_gf01" };
const codes = ["CODEABC", "星际列车", "CODEDEF"];
const activity = { game: "gs", status: "available", actId: "e202610010000", version: "7.2",
  expiry: { ms: stamp + 10 * 60_000 }, codes: codes.map(code => ({ code })) };
const confirmed = { status: "succeeded" } as const;
const key = (accountId: string, uid: string) => createHash("sha256")
  .update(JSON.stringify([accountId, "gs", "7.2", uid])).digest("hex");

async function fixture(use: (paths: { journal: string; legacyJournal: string }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "lotus-preview-redeem-"));
  try { await use({ journal: join(root, "auto.json"), legacyJournal: join(root, "legacy.json") }); }
  finally { await rm(root, { force: true, recursive: true }); }
}

test("旧 journal 两个路径的 started、finished 与隐式角色键均阻止重复执行", async () => {
  await fixture(async paths => {
    const primary = { [key("100", role.uid)]: { time: 1, status: "finished" } };
    const historical = { [key("101", role.uid)]: { time: 2, status: "started" },
      [key("102", "implicit")]: { time: 3, status: "finished" } };
    const historicalBytes = JSON.stringify(historical, null, 2) + "\n";
    await writeFile(paths.journal, JSON.stringify(primary));
    await writeFile(paths.legacyJournal, historicalBytes);
    const posted: string[] = [];
    const process = createPreviewRedeemRunner({ ...paths, now: () => stamp, lookup: async () => activity,
      listProfiles: async () => [100, 101, 102, 103].map(id => ({ ...oldProfile, qq: String(id) })),
      async readRoles(snapshot) { return { accountId: snapshot.qq, roles: [role], selectedUid: snapshot.qq === "102" ? "" : role.uid,
        async submit(code) { posted.push(snapshot.qq + ":" + code); return confirmed; } }; },
    });
    expect(await process.hasHistory()).toBe(true);
    await process.scan();
    await process.scan();
    expect(posted).toEqual(codes.map(code => "103:" + code));
    expect(await readFile(paths.legacyJournal, "utf8")).toBe(historicalBytes);
    const updated = JSON.parse(await readFile(paths.journal, "utf8"));
    expect(updated).toEqual({ ...primary, [key("103", role.uid)]: { time: stamp, status: "finished" } });
  });
});

test("旧档案缺失历史保持暂停，新登记档案新建 journal 后也不会误放行旧档", async () => {
  await fixture(async paths => {
    const entered: string[] = [];
    const options = { ...paths, now: () => stamp, lookup: async () => activity,
      listProfiles: async () => [oldProfile, profile],
      async readRoles(snapshot: PreviewProfile) {
        entered.push(String(snapshot.profileId));
        return { accountId: "110", roles: [role], selectedUid: role.uid, async submit() { return confirmed; } };
      },
    };
    const first = createPreviewRedeemRunner(options);
    expect(await first.hasHistory()).toBe(false);
    await first.scan();
    expect(await first.hasHistory()).toBe(false);
    await createPreviewRedeemRunner(options).scan();
    expect(entered).toEqual(["2", "2"]);
    expect(JSON.parse(await readFile(paths.journal, "utf8"))).toEqual({
      __lotusPreviewJournalVersion: 1, [key("110", role.uid)]: { time: stamp, status: "finished" },
    });
    expect((await stat(paths.journal)).mode & 0o777).toBe(0o600);
  });
});

test("仅有旧路径时保留只读来源，后来旧路径丢失仍暂停既有订阅", async () => {
  await fixture(async paths => {
    const bytes = JSON.stringify({ [key("998", role.uid)]: { time: 1, status: "finished" } });
    await writeFile(paths.legacyJournal, bytes);
    let profileReads = 0;
    const runner = createPreviewRedeemRunner({ ...paths, now: () => stamp, lookup: async () => activity,
      listProfiles: async () => [oldProfile],
      async readRoles() {
        profileReads++;
        return { accountId: "111", roles: [role], selectedUid: role.uid, async submit() { return confirmed; } };
      },
    });
    expect(await runner.hasHistory()).toBe(true);
    await runner.scan();
    expect(profileReads).toBe(1);
    expect(await readFile(paths.legacyJournal, "utf8")).toBe(bytes);
    expect(JSON.parse(await readFile(paths.journal, "utf8"))[key("111", role.uid)]).toEqual({ time: stamp, status: "finished" });
    await rm(paths.legacyJournal);
    expect(await runner.hasHistory()).toBe(false);
    await runner.scan();
    expect(profileReads).toBe(1);
  });
});

test("多个实例的批次争用只认同一份持久 started，结果不明停止后续并发送一次通知", async () => {
  await fixture(async paths => {
    const competing = Promise.withResolvers<void>();
    const sending = Promise.withResolvers<void>();
    let calls = 0;
    const notices: string[] = [];
    const options = { ...paths, now: () => stamp, lookup: async () => activity, listProfiles: async () => [profile],
      async readRoles() {
        return { accountId: "120", selectedUid: "", roles: [role], async submit() {
          calls++;
          const record = JSON.parse(await readFile(paths.journal, "utf8"));
          expect(record[key("120", "implicit")]).toEqual({ time: stamp, status: "started" });
          expect(record[key("120", role.uid)]).toEqual({ time: stamp, status: "started" });
          sending.resolve();
          await competing.promise;
          throw Error("fixture connection closed");
        }, async notify(reply: string) { notices.push(reply); } };
      },
    };
    const first = createPreviewRedeemRunner(options).scan();
    await sending.promise;
    try {
      await createPreviewRedeemRunner(options).scan();
      expect(calls).toBe(1);
    } finally {
      competing.resolve();
      await first;
    }
    await createPreviewRedeemRunner(options).scan();
    expect(calls).toBe(1);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("CODEABC：结果未确认");
    expect(notices[0]).toContain("星际列车：未提交");
    expect(await readFile(paths.journal, "utf8")).not.toContain(codes[0]!);
  });
});

test("进程在首个请求期间被杀，重启保留 started 并跳过同一批次", async () => {
  await fixture(async paths => {
    const modulePath = new URL("../lib/redeem-code-runner.ts", import.meta.url).href;
    const child = Bun.spawn([process.execPath, "-e", `
      import { createPreviewRedeemRunner } from ${JSON.stringify(modulePath)};
      const runner = createPreviewRedeemRunner({
        ...${JSON.stringify(paths)}, now: () => ${stamp}, lookup: async () => (${JSON.stringify(activity)}),
        listProfiles: async () => [${JSON.stringify(profile)}],
        async readRoles() { return { accountId: "130", selectedUid: "", roles: [${JSON.stringify(role)}],
          async submit() { console.log("started"); await new Promise(() => setInterval(() => {}, 1000)); } }; },
      });
      await runner.scan();
    `], { stdout: "pipe", stderr: "inherit" });
    const output = child.stdout.getReader();
    try {
      const ready = await output.read();
      expect(new TextDecoder().decode(ready.value).trim()).toBe("started");
      const saved = JSON.parse(await readFile(paths.journal, "utf8"));
      expect(saved[key("130", "implicit")]).toEqual({ time: stamp, status: "started" });
    } finally {
      child.kill("SIGKILL");
      await child.exited;
      output.releaseLock();
    }
    let replay = false;
    await createPreviewRedeemRunner({ ...paths, now: () => stamp, lookup: async () => activity,
      listProfiles: async () => [profile], async readRoles() { return { accountId: "130", roles: [role], selectedUid: role.uid,
        async submit() { replay = true; return confirmed; } }; },
    }).scan();
    expect(replay).toBe(false);
  });
});

test("只处理当期已发布且明确未到期的完整兑换码，拒绝重复、错误游戏和含歧义角色", async () => {
  await fixture(async paths => {
    let lookups = 0, profiles = 0, posted = 0;
    let preview: unknown;
    const options = { ...paths, now: () => stamp, async lookup() { lookups++; return preview; },
      listProfiles: async () => [profile],
      async readRoles() { profiles++; return { accountId: "121", selectedUid: "",
        roles: [role, { ...role, uid: "100000043" }], async submit() { posted++; return confirmed; } }; },
    };
    for (const value of [{ ...activity, codes: activity.codes.slice(0, 2) }, { ...activity, game: "sr" },
      { ...activity, expiry: { ms: stamp } }, { ...activity, status: "unreleased" },
      { ...activity, startAt: stamp + 60_000 },
      { ...activity, codes: ["DUP", "dup", "other"].map(code => ({ code })) }, activity]) {
      preview = value;
      await createPreviewRedeemRunner(options).scan();
    }
    expect(lookups).toBe(7);
    expect(profiles).toBe(1);
    expect(posted).toBe(0);
  });
});

test("选择同档国服角色，明确失败可继续，活动到期后停止剩余请求", async () => {
  await fixture(async paths => {
    const calls: string[] = [];
    let now = stamp;
    let notice = "";
    const service = createPreviewRedeemRunner({ ...paths, now: () => now, lookup: async () => activity,
      listProfiles: async () => [profile], async readRoles() { return { accountId: "122", selectedUid: role.uid,
        roles: [role, { uid: "100000044", region: "os_usa" }, { ...role, uid: "100000043" }],
        async submit(code, actual) {
          expect(actual).toEqual(role);
          calls.push(code);
          if (calls.length === 2) now = activity.expiry.ms;
          return { status: "invalid" };
        },
      }; }, async notify(_, reply) { notice = reply; },
    });
    await service.scan();
    expect(calls).toEqual(codes.slice(0, 2));
    expect(notice).toContain("CODEDEF：未提交");
    expect(notice).toContain("CODEABC：兑换码无效");
  });
});

test("官宣开播前等待，过期和无活动回查均按旧节流", async () => {
  await fixture(async paths => {
    let now = stamp;
    const calls: PreviewGame[] = [];
    const profiles = [{ ...profile, games: ["gs", "sr", "zzz"] }] as const;
    const service = createPreviewRedeemRunner({ ...paths, now: () => now, listProfiles: async () => profiles,
      async lookup(game) {
        calls.push(game);
        if (game === "gs") return { status: "unreleased", startAt: stamp + 90 * 60_000 };
        return { status: game === "sr" ? "expired" : "unavailable" };
      },
      async readRoles() { throw Error("Unexpected role query"); },
    });
    await service.scan();
    await service.scan();
    expect(calls).toEqual(["gs", "sr", "zzz"]);
    now += 30 * 60_000;
    await service.scan();
    expect(calls).toEqual(["gs", "sr", "zzz", "sr", "zzz"]);
    now += 30 * 60_000;
    await service.scan();
    expect(calls).toEqual(["gs", "sr", "zzz", "sr", "zzz", "gs", "sr", "zzz"]);
  });
});

test("异常旧 journal 无法解析时直接阻断扫描且保留原件", async () => {
  await fixture(async paths => {
    await writeFile(paths.legacyJournal, "corrupt fixture");
    let looked = false;
    const runner = createPreviewRedeemRunner({ ...paths, now: () => stamp, listProfiles: async () => [profile],
      async lookup() { looked = true; return activity; },
      async readRoles() { throw Error("Unexpected role query"); },
    });
    await expect(runner.scan()).rejects.toThrow();
    expect(looked).toBe(false);
    expect(await readFile(paths.legacyJournal, "utf8")).toBe("corrupt fixture");
  });
});
