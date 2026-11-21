import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createMiyousheShopPlans, type MiyousheShopInspection } from "../lib/miyoushe-shop-plans.ts";
import { createManualCaptchaRelay } from "../lib/captcha/manual-relay.ts";

const target = { qq: "42", profileId: 1 };
const other = { qq: "42", profileId: 2 };
const startTime = 1_792_000_000_000;
const uid = "1000042";
const region = "cn_gf01";
const body = { confirmed: true, goodsId: "27", uid, region, immediate: true, expectedPrice: 300 };
const planRole = { uid, region, gameBiz: "hk4e_cn" };
const mockGood = { id: "27", name: "测试商品", price: 300, type: 2, status: "available", gameBiz: "hk4e_cn", opensAt: null } as const;

async function fixture(run: (data: {
  file: string; profileDirectory: string; profile: (qq: string, id: number, account?: string, fp?: string) => Promise<void>;
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "lotus-miyoushe-plans-"));
  const file = join(root, "coinShop", "plans.json");
  async function profile(qq: string, id: number, account = "123", fp = "fake-device-fingerprint") {
    await writeFile(join(root, `${qq}${id === 1 ? "" : `-${id}`}.yaml`), Bun.YAML.stringify({
      version: 1, user: { qq }, profile: { id }, account: {
        stuid: account, ltuid: account, cookie: "fake-cookie-for-tests", stoken: "fake-token-for-tests", updated_at: "2026-01-01",
        current_uid: { gs: uid },
      }, device: { id: "fake-device-id", fp },
    }));
  }
  try {
    await profile(target.qq, target.profileId);
    await profile(other.qq, other.profileId);
    await run({ file, profileDirectory: root, profile });
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function inspection(good: MiyousheShopInspection["good"] = mockGood) {
  return { good, balance: 500, roles: [planRole] };
}

function gate() { return Promise.withResolvers<void>(); }

test("只有原快捷兑换会话能接续。重启不认领其待提交计划，普通预约维持原流程", async () => {
  await fixture(async ({ file, profileDirectory }) => {
    const relay = createManualCaptchaRelay({ publicUrl: "https://fixture.example.invalid" });
    try {
      const session = { sessionId: "browser-fixture", signal: new AbortController().signal, async verify() {} };
      let now = startTime;
      let submissions = 0;
      const options = { file, profileDirectory, now: () => now, inspect: () => inspection(), manualRelay: () => relay,
        async submit(_plan: unknown, _signal?: AbortSignal, _verify?: () => Promise<void>, manual?: unknown) {
          expect(manual).toBeUndefined();
          submissions++;
          return "succeeded" as const;
        } };
      const first = createMiyousheShopPlans(options);
      const immediate = await first.reserve(target, { ...body, intentId: crypto.randomUUID() }, undefined, undefined, session);
      const restarted = createMiyousheShopPlans(options);
      await restarted.scan();
      expect(submissions).toBe(0);
      now += 31_000;
      await restarted.scan();
      expect((await restarted.list(target)).plans.find(plan => plan.id === immediate.id)).toMatchObject({ status: "cancelled", attempts: 0 });
      expect(submissions).toBe(0);
      const scheduled = await restarted.reserve(target, { ...body, immediate: false, intentId: crypto.randomUUID() }, undefined, undefined, session);
      restarted.endWebSession(session.sessionId);
      await restarted.scan();
      expect(submissions).toBe(1);
      expect((await restarted.list(target)).plans.find(plan => plan.id === scheduled.id)).toMatchObject({ status: "succeeded", attempts: 1 });
    } finally { relay.close(); }
  });
});

test("导入两个旧目录的兑换计划后保留未确认记录，阻止已有同商品预约提交", async () => {
  await fixture(async ({ file, profileDirectory }) => {
    let submits = 0;
    const options = { file, profileDirectory, now: () => startTime, inspect: () => inspection(),
      async submit() { submits++; return "succeeded" as const; } };
    const original = createMiyousheShopPlans(options);
    const reservation = await original.reserve(target, body);
    const { bindingStamp: _stamp, ...originalPlan } = JSON.parse(await readFile(file, "utf8")).plans[0];
    const previous = { ...originalPlan, id: "123456789abc", status: "submitting", attempts: 1 };
    const finished = { ...originalPlan, id: "abcdef123456", status: "succeeded", goodsId: "31" };
    const legacyFiles = ["Lotus-Plugin", "Lotus-ReFactor"].map(id => ({ id, file: join(profileDirectory, id, "plans.json") }));
    const legacyBytes = [JSON.stringify({ version: 1, plans: [previous] }) + "\r\n",
      JSON.stringify({ version: 2, plans: [finished], trackers: [{ id: "111111111111", legacyField: true }] }) + "\n"];
    await Promise.all(legacyFiles.map(async (source, index) => {
      await mkdir(dirname(source.file), { recursive: true });
      await writeFile(source.file, legacyBytes[index]!);
    }));
    const migrated = createMiyousheShopPlans({ ...options, legacyFiles });
    await Promise.all([migrated.scan(), createMiyousheShopPlans({ ...options, legacyFiles }).scan()]);
    expect(submits).toBe(0);
    const { plans } = await migrated.list(target);
    expect(plans).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: previous.id, status: "unknown", attempts: 1 }),
      expect.objectContaining({ id: finished.id, status: "succeeded" }),
      expect.objectContaining({ id: reservation.id, status: "cancelled", message: expect.stringContaining("有兑换结果待确认") }),
    ]));
    await expect(migrated.reserve(other, body)).rejects.toMatchObject({ status: 409 });
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ importedLegacy: legacyFiles.map(source => source.id),
      trackers: [{ id: "111111111111", legacyField: true }] });
    expect(await Promise.all(legacyFiles.map(source => readFile(source.file, "utf8")))).toEqual(legacyBytes);
    await migrated.resolve(target, previous.id, false);
    const restarted = createMiyousheShopPlans({ ...options, legacyFiles });
    expect((await restarted.list(target)).plans.find(plan => plan.id === previous.id)?.status).toBe("failed");
  });
});

test("现用和旧兑换账本相同编号内容冲突时保留两份原文件", async () => {
  await fixture(async ({ file, profileDirectory }) => {
    let submits = 0;
    const options = { file, profileDirectory, now: () => startTime, inspect: () => inspection(),
      async submit() { submits++; return "succeeded" as const; } };
    await createMiyousheShopPlans(options).reserve(target, body);
    const primary = await readFile(file, "utf8");
    const legacy = join(profileDirectory, "legacy.json");
    const prior = JSON.parse(primary);
    prior.plans[0].status = "submitting";
    const legacyBytes = JSON.stringify(prior);
    await writeFile(legacy, legacyBytes);
    const migrated = createMiyousheShopPlans({ ...options, legacyFiles: [{ id: "Lotus-ReFactor", file: legacy }] });
    await expect(migrated.scan()).rejects.toThrow("现用与旧版兑换计划有冲突");
    expect(submits).toBe(0);
    expect(await readFile(file, "utf8")).toBe(primary);
    expect(await readFile(legacy, "utf8")).toBe(legacyBytes);
  });
});

test("预约需要明确确认，同一账号跨档案去重，同一意图在完成后重试仍复用记录", async () => {
  await fixture(async ({ file, profileDirectory }) => {
    let submits = 0;
    const options = { file, profileDirectory, now: () => startTime, inspect: () => inspection(),
      async submit() { submits++; return "succeeded" as const; } };
    const first = createMiyousheShopPlans(options);
    const second = createMiyousheShopPlans(options);
    await expect(first.reserve(target, { ...body, confirmed: false })).rejects.toMatchObject({ status: 400 });
    await expect(first.reserve(target, { ...body, uid: "99" })).rejects.toMatchObject({ status: 400 });
    await expect(first.reserve(target, { ...body, expectedPrice: 200 })).rejects.toMatchObject({ status: 409 });
    const confirmed = { ...body, intentId: crypto.randomUUID() };
    const [one, two] = await Promise.all([first.reserve(target, confirmed), second.reserve(target, confirmed)]);
    expect(one).toEqual(two);
    await expect(second.reserve(other, confirmed)).rejects.toMatchObject({ status: 409 });
    expect((await second.list(other)).plans).toEqual([]);
    await expect(second.cancel(other, one.id)).rejects.toMatchObject({ status: 404 });
    await Promise.all([first.scan(), second.scan()]);
    expect(submits).toBe(1);
    const retried = await createMiyousheShopPlans(options).reserve(target, confirmed);
    expect(retried).toMatchObject({ id: one.id, status: "succeeded", attempts: 1 });
    await expect(first.reserve(target, { ...confirmed, uid: "99" })).rejects.toMatchObject({ status: 409 });
    expect(await stat(file).then(result => result.mode & 0o777)).toBe(0o600);
    expect(await readFile(file, "utf8")).not.toMatch(/fake-(cookie|token|device)/u);
    expect(Object.keys(retried)).not.toContain("accountId");
    expect(Object.keys(retried)).not.toContain("intentId");
  });
});

test("提交前落盘，活跃提交不会被其他进程误判，结果不明时只允许人工确认", async () => {
  await fixture(async ({ file, profileDirectory }) => {
    const posting = gate(), lostResponse = gate();
    let submits = 0;
    const options = { file, profileDirectory, now: () => startTime, inspect: () => inspection(),
      async submit(_plan: unknown, _signal?: AbortSignal, verifyBinding?: () => Promise<void>): Promise<"succeeded"> {
        await verifyBinding?.();
        submits++;
        posting.resolve();
        await lostResponse.promise;
        throw new Error("transport failure with fake-cookie-for-tests");
      } };
    const first = createMiyousheShopPlans(options);
    const second = createMiyousheShopPlans(options);
    const booked = await first.reserve(target, body);
    const postingJob = first.scan();
    try {
      await posting.promise;
      expect(JSON.parse(await readFile(file, "utf8")).plans[0].status).toBe("submitting");
      expect((await second.list(target)).plans[0]?.status).toBe("submitting");
      await expect(second.cancel(target, booked.id)).rejects.toMatchObject({ status: 409 });
      await second.scan();
      expect(submits).toBe(1);
    } finally {
      lostResponse.resolve();
      await postingJob;
    }
    const restarted = createMiyousheShopPlans(options);
    await restarted.scan();
    expect((await restarted.list(target)).plans[0]).toMatchObject({ status: "unknown", attempts: 1 });
    expect(await readFile(file, "utf8")).not.toContain("fake-cookie-for-tests");
    expect(submits).toBe(1);
    await expect(restarted.reserve(target, body)).rejects.toMatchObject({ status: 409 });
    await expect(restarted.resolve(other, booked.id, false)).rejects.toMatchObject({ status: 404 });
    await expect(restarted.resolve(target, booked.id, "false")).rejects.toMatchObject({ status: 400 });
    expect(await restarted.resolve(target, booked.id, false)).toMatchObject({ status: "failed", finishedAt: startTime });
    expect(await restarted.reserve(target, body)).toMatchObject({ status: "scheduled", attempts: 0 });
  });
});

test("旧版本保留预约，重启恢复时待确认中断的提交并暂停对应追踪规则", async () => {
  await fixture(async ({ file, profileDirectory }) => {
    const options = { file, profileDirectory, now: () => startTime, inspect: () => inspection() };
    const plan = {
      id: "123456789abc", ...target, accountId: "123", botId: "99", goodsId: "27", goodsName: "旧预约", gameBiz: "hk4e_cn",
      type: 2, price: 300, role: { ...planRole, nickname: "旧昵称" }, addressId: "", addressLabel: "", immediate: true,
      createdAt: startTime, opensAt: startTime, attempts: 1, message: "旧字段", status: "submitting",
    };
    const noSubmit = createMiyousheShopPlans(options);
    await expect(noSubmit.reserve(target, body)).rejects.toMatchObject({ status: 503 });
    await expect(noSubmit.cancel(target, plan.id)).rejects.toMatchObject({ status: 404 });
    await writeFile(file, JSON.stringify({ version: 1, plans: [plan] }));
    expect((await noSubmit.list(target)).plans[0]).toMatchObject({ id: plan.id, status: "unknown" });
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ version: 2, trackers: [] });
    const trackingId = "abcdef123456";
    const trackers = [{ id: trackingId, enabled: true, customOldField: ["keep"] }];
    await writeFile(file, JSON.stringify({ version: 2, plans: [{ ...plan, trackingId },
      { ...plan, id: "123456789abd", goodsId: "28", status: "preparing" }], trackers }));
    await noSubmit.scan();
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved.plans.map((item: { status: string }) => item.status)).toEqual(["unknown", "scheduled"]);
    expect(saved.trackers).toMatchObject([{ enabled: false, customOldField: ["keep"] }]);
    const recovered = (await noSubmit.list(target)).plans[0]!;
    expect(recovered.role).toEqual(planRole);
    expect(recovered).not.toHaveProperty("botId");
    expect(await noSubmit.resolve(target, recovered.id, true)).toMatchObject({ status: "succeeded" });
  });
});

test("进程在调用兑换执行器时被杀后，重启只恢复待确认记录", async () => {
  await fixture(async ({ file, profileDirectory }) => {
    const path = new URL("../lib/miyoushe-shop-plans.ts", import.meta.url).href;
    const child = Bun.spawn([process.execPath, "-e", `
      import { createMiyousheShopPlans } from ${JSON.stringify(path)};
      const shop = createMiyousheShopPlans({
        file: ${JSON.stringify(file)}, profileDirectory: ${JSON.stringify(profileDirectory)}, now: () => ${startTime},
        async inspect() { return ${JSON.stringify(await inspection())}; },
        async submit() { console.log("submitting"); await new Promise(() => setInterval(() => {}, 1000)); },
      });
      await shop.reserve(${JSON.stringify(target)}, ${JSON.stringify(body)});
      await shop.scan();
    `], { stdout: "pipe", stderr: "inherit" });
    const output = child.stdout.getReader();
    try {
      const ready = await output.read();
      expect(new TextDecoder().decode(ready.value).trim()).toBe("submitting");
      expect(JSON.parse(await readFile(file, "utf8")).plans[0].status).toBe("submitting");
    } finally {
      child.kill("SIGKILL");
      await child.exited;
      output.releaseLock();
    }
    let repeated = false;
    const restarted = createMiyousheShopPlans({ file, profileDirectory, now: () => startTime, inspect: () => inspection(),
      async submit() { repeated = true; return "succeeded"; } });
    await restarted.scan();
    expect((await restarted.list(target)).plans[0]).toMatchObject({ status: "unknown", attempts: 1 });
    expect(repeated).toBe(false);
  });
});

test("预约后的账号或设备换绑会阻止提交，预约中的换绑阻止落盘", async () => {
  await fixture(async ({ file, profileDirectory, profile }) => {
    let submits = 0;
    const options = { file, profileDirectory, now: () => startTime, inspect: () => inspection(),
      async submit() { submits++; return "succeeded" as const; } };
    const service = createMiyousheShopPlans(options);
    const initial = await service.reserve(target, body);
    await profile(target.qq, target.profileId, "555");
    await service.scan();
    expect((await service.list(target)).plans.find(item => item.id === initial.id)).toMatchObject({ status: "failed", attempts: 0 });
    const afterRebind = await service.reserve(target, body);
    await profile(target.qq, target.profileId, "555", "fake-other-fp");
    await service.scan();
    expect((await service.list(target)).plans.find(item => item.id === afterRebind.id)).toMatchObject({ status: "failed", attempts: 0 });
    const changedDuringRead = createMiyousheShopPlans({ ...options, async inspect(_target, _id, _signal, verify) {
      await verify?.();
      await profile(target.qq, target.profileId, "666");
      await verify?.();
      return inspection();
    } });
    await expect(changedDuringRead.reserve(target, body)).rejects.toMatchObject({ status: 409 });
    expect((await service.list(target)).plans).toHaveLength(2);
    expect(submits).toBe(0);
  });
});

test("官方改期后更新预约，取消核验中的计划不会提交，错过预约时不补发", async () => {
  await fixture(async ({ file, profileDirectory }) => {
    let now = startTime, submits = 0, opensAt = now + 3_000;
    const examining = gate(), cancellation = gate();
    let inspectMain = false;
    const service = createMiyousheShopPlans({ file, profileDirectory, now: () => now, async inspect() {
      if (inspectMain) { examining.resolve(); await cancellation.promise; }
      return inspection({ ...mockGood, status: "scheduled", opensAt });
    }, async submit() { submits++; return "succeeded"; } });
    const first = await service.reserve(target, { ...body, immediate: false });
    opensAt += 20_000;
    await service.scan();
    expect((await service.list(target)).plans[0]).toMatchObject({ status: "scheduled", opensAt });
    now = opensAt;
    inspectMain = true;
    const scan = service.scan();
    await examining.promise;
    try {
      expect(await service.cancel(target, first.id)).toMatchObject({ status: "cancelled" });
    } finally {
      cancellation.resolve();
      await scan;
    }
    opensAt += 2_000;
    const missed = await service.reserve(target, { ...body, immediate: false });
    now = opensAt + 30_001;
    await service.scan();
    expect((await service.list(target)).plans.find(item => item.id === missed.id)).toMatchObject({ status: "missed", attempts: 0 });
    expect(submits).toBe(0);
  });
});

const trackedGood = { ...mockGood, game: "hk4e", limitCycle: "day" };
const trackingBody = { confirmed: true, game: "hk4e", itemType: 2, mode: "goods", goodsIds: ["27"], keywords: [],
  followSameName: true, maxPrice: 300, spendLimit: 600, addressId: "", pollMinutes: 1, leadSeconds: 5, intervalMs: 500 };

test("持续追踪按官方周期、同名选项和累计预算兑换，并在并行实例中只提交一次", async () => {
  await fixture(async ({ file, profileDirectory }) => {
    let now = startTime;
    let favorite: MiyousheShopInspection["good"] = trackedGood;
    const submits: string[] = [];
    const options = { file, profileDirectory, now: () => now,
      inspect: async (_target: unknown, id: string) => inspection({ ...favorite, id }),
      tracking: { async catalog() { return [favorite, { ...favorite, id: "28", name: "其他商品" }]; },
        async destinations() { return { roles: [planRole] }; } },
      async submit(plan: { goodsId: string }) { submits.push(plan.goodsId); return "succeeded" as const; },
    };
    const service = createMiyousheShopPlans(options);
    const parallel = createMiyousheShopPlans(options);
    await expect(service.createTracker(target, { ...trackingBody, confirmed: false })).rejects.toMatchObject({ status: 400 });
    const rule = await service.createTracker(target, trackingBody);
    await expect(parallel.createTracker(target, trackingBody)).rejects.toMatchObject({ status: 409 });
    await expect(parallel.setTracker(other, rule.id, false, undefined)).rejects.toMatchObject({ status: 404 });
    expect((await service.listTrackers(other)).trackers).toEqual([]);
    await Promise.all([service.scan(), parallel.scan()]);
    expect(submits).toEqual(["27"]);
    now += 60_000;
    await service.scan();
    expect(submits).toEqual(["27"]);
    now += 86_400_000;
    favorite = { ...trackedGood, id: "31" };
    await service.scan();
    expect(submits).toEqual(["27", "31"]);
    now += 86_400_000;
    await service.scan();
    expect(submits).toEqual(["27", "31"]);
    expect((await service.listTrackers(target)).trackers[0]).toMatchObject({ spent: 600, held: 0, successes: 2 });
  });
});

test("慢速追踪目录不占用同账号已确认预约的执行窗口", async () => {
  await fixture(async ({ file, profileDirectory }) => {
    const catalogStarted = gate(), releaseCatalog = gate();
    const posts: string[] = [];
    const service = createMiyousheShopPlans({ file, profileDirectory, now: () => startTime,
      async inspect(_target, id) { return inspection({ ...trackedGood, id }); },
      tracking: { async catalog() { catalogStarted.resolve(); await releaseCatalog.promise; return [trackedGood]; },
        async destinations() { return { roles: [planRole] }; } },
      async submit(plan) { posts.push(plan.goodsId); return "succeeded"; } });
    await service.createTracker(target, trackingBody);
    const poll = service.scan();
    try {
      await catalogStarted.promise;
      const manual = await service.reserve(target, { ...body, goodsId: "28" });
      const lifecycle = new AbortController();
      try {
        service.start(lifecycle.signal);
        const deadline = Date.now() + 1800;
        let status;
        do {
          await Bun.sleep(50);
          status = (await service.list(target)).plans.find(row => row.id === manual.id)?.status;
        } while (status !== "succeeded" && Date.now() < deadline);
        expect(posts).toEqual(["28"]);
        expect(status).toBe("succeeded");
      } finally { lifecycle.abort(); }
    } finally {
      releaseCatalog.resolve();
      await poll;
    }
  });
});

test("追踪在官方开场前遇到零库存仍检查，开场后明确零库存则不提交", async () => {
  for (const availableAfterOpening of [true, false]) {
    await fixture(async ({ file, profileDirectory }) => {
      let reads = 0, posts = 0, now = startTime;
      const opensAt = startTime + 5;
      const scheduled = { ...trackedGood, status: "scheduled", opensAt, stock: 0, serverNow: startTime } as const;
      const service = createMiyousheShopPlans({ file, profileDirectory, now: () => now,
        async inspect() {
          reads++;
          if (reads <= 2) return inspection(scheduled);
          if (reads === 3) return inspection({ ...trackedGood, status: "sold_out", stock: 0, serverNow: startTime });
          now = opensAt;
          return inspection({ ...trackedGood, stock: availableAfterOpening ? 1 : 0, serverNow: now,
            status: availableAfterOpening ? "available" : "unknown" });
        },
        tracking: { async catalog() { return [scheduled]; }, async destinations() { return { roles: [planRole] }; } },
        async submit() { posts++; return "succeeded"; } });
      await service.createTracker(target, trackingBody);
      const keepAlive = setInterval(() => {}, 100);
      try { await service.scan(); } finally { clearInterval(keepAlive); }
      expect(reads).toBe(4);
      expect(posts).toBe(availableAfterOpening ? 1 : 0);
      expect((await service.list(target)).plans[0]?.status).toBe(availableAfterOpening ? "succeeded" : "failed");
    });
  }
});

test("旧规则仍显示预算和历史，未确认或遗留提交待核对时不兑换", async () => {
  await fixture(async ({ file, profileDirectory }) => {
    let posts = 0, polls = 0;
    const options = { file, profileDirectory, now: () => startTime, inspect: () => inspection(trackedGood),
      tracking: { async catalog() { polls++; return [trackedGood]; }, async destinations() { return { roles: [planRole] }; } },
      async submit() { posts++; return "succeeded" as const; },
    };
    const service = createMiyousheShopPlans(options);
    await expect(service.cancel(target, "123456789abc")).rejects.toMatchObject({ status: 404 });
    const old = { ...target, id: "aaaaaaaaaaaa", accountId: "123", botId: "7", mode: "goods", game: "hk4e", itemType: 2,
      goodsIds: ["27"], names: [trackedGood.name], keywords: [], followSameName: true, maxPrice: 300, spendLimit: 600,
      role: planRole, gameBiz: "hk4e_cn", addressId: "", addressLabel: "", pollMs: 1000, leadMs: 5000,
      intervalMs: 500, afterMs: 83, enabled: true, createdAt: startTime, message: "旧记录", extra: "保留" };
    const oldPlan = { ...target, id: "123456789abc", accountId: "123", botId: "7", trackingId: old.id, goodsId: "27",
      goodsName: trackedGood.name, gameBiz: "hk4e_cn", type: 2, price: 300, role: planRole, addressId: "", addressLabel: "",
      immediate: false, opensAt: startTime, createdAt: startTime, status: "submitting", message: "旧记录", attempts: 1 };
    const incompatible = { ...old, id: "bbbbbbbbbbbb", maxPrice: "", spendLimit: { units: 500 }, extra: "旧数据原样保留" };
    await writeFile(file, JSON.stringify({ version: 2, plans: [oldPlan], trackers: [old, incompatible] }));
    await service.scan();
    expect(posts).toBe(0);
    expect(polls).toBe(0);
    expect((await service.listTrackers(target)).trackers[0]).toMatchObject({
      id: old.id, needsConfirmation: true, enabled: false, held: 300, pollMs: 1_800_000,
    });
    expect((await service.listTrackers(target)).trackers[1]).toMatchObject({ id: incompatible.id, migrationBlocked: true, enabled: false });
    await expect(service.setTracker(target, incompatible.id, true, true)).rejects.toMatchObject({ status: 409 });
    await expect(service.setTracker(target, old.id, true, false)).rejects.toMatchObject({ status: 400 });
    await expect(service.setTracker(target, old.id, true, true)).rejects.toMatchObject({ status: 409 });
    await service.resolve(target, oldPlan.id, true);
    expect(await service.setTracker(target, old.id, true, true)).toMatchObject({ enabled: true, spent: 300 });
    await service.scan();
    expect(polls).toBe(1);
    expect(posts).toBe(0);
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved.trackers[0]).toMatchObject({ pollUnit: "minutes", pollMs: 1_800_000, extra: "保留" });
    expect(saved.trackers[0]).not.toHaveProperty("afterMs");
    expect(saved.trackers[1]).toEqual(incompatible);
  });
});

test("旧实物规则可核对非游戏目录分区，目标仍限原档案地址", async () => {
  await fixture(async ({ file, profileDirectory }) => {
    const goods = { ...trackedGood, game: "bbs", gameBiz: "", type: 1 };
    const address = { id: "83", label: "李** ****8231" };
    const posts: string[] = [];
    const service = createMiyousheShopPlans({ file, profileDirectory, now: () => startTime,
      async inspect() { return { good: goods, balance: 600, addresses: [address] }; },
      tracking: { async catalog(_target, game) { expect(game).toBe("bbs"); return [goods]; },
        async destinations() { return { addresses: [address] }; } },
      async submit(plan) { posts.push(plan.addressId); return "succeeded"; } });
    await expect(service.cancel(target, "123456789abc")).rejects.toMatchObject({ status: 404 });
    const old = { ...target, id: "cccccccccccc", accountId: "123", botId: "7", mode: "category", game: "bbs", itemType: 1,
      goodsIds: [], names: [], keywords: [], followSameName: true, maxPrice: 300, spendLimit: 300,
      role: null, gameBiz: "", addressId: address.id, addressLabel: address.label, pollMs: 60_000, pollUnit: "minutes",
      leadMs: 5000, intervalMs: 500, enabled: true, createdAt: startTime, message: "旧记录" };
    await writeFile(file, JSON.stringify({ version: 2, plans: [], trackers: [old] }));
    await service.scan();
    expect(posts).toEqual([]);
    expect(await service.setTracker(target, old.id, true, true)).toMatchObject({ enabled: true, game: "bbs", addressLabel: address.label });
    await service.scan();
    expect(posts).toEqual([address.id]);
  });
});

test("追踪提交结果不明后暂停账号规则，人工确认前重启不会继续换币", async () => {
  await fixture(async ({ file, profileDirectory }) => {
    let now = startTime, posts = 0;
    const options = { file, profileDirectory, now: () => now, inspect: () => inspection(trackedGood),
      tracking: { async catalog() { return [trackedGood]; }, async destinations() { return { roles: [planRole] }; } },
      async submit() { posts++; return "unknown" as const; },
    };
    const service = createMiyousheShopPlans(options);
    const rule = await service.createTracker(target, trackingBody);
    await service.scan();
    expect(posts).toBe(1);
    const restarted = createMiyousheShopPlans(options);
    now += 86_400_000;
    await restarted.scan();
    expect(posts).toBe(1);
    expect((await restarted.listTrackers(target)).trackers[0]).toMatchObject({ enabled: false, held: 300 });
    await expect(restarted.setTracker(target, rule.id, true, true)).rejects.toMatchObject({ status: 409 });
  });
});
