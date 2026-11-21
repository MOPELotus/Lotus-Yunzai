import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createProfileStore } from "@lotus-yunzai/account";
import { createCheckinAudit } from "../lib/checkin-audit.ts";
import { stageLegacyShopAudit } from "../lib/migration-shop-audit.ts";
import { createMiyousheShopPlans } from "../lib/miyoushe-shop-plans.ts";

const historyPath = "data/audit/checkin.jsonl";
const old = "plugins/Lotus-Plugin";
const shopPath = "data/coinShop/plans.json";
const previewPath = "data/coinShop/preview-plans.json";
const owner = { qq: "42", profileId: 1 };
const role = { uid: "100001234", region: "cn_gf01", gameBiz: "hk4e_cn" };
const day = Date.parse("2026-11-21T14:00:00+08:00");
const safeTime = day + 120_000;

async function put(root: string, path: string, value: string | object) {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
}

const ledger = (plans: readonly object[] = [], trackers: readonly object[] = []) => ({ version: 2, plans, trackers });
function purchase(id: string, status: string, fields: object = {}) {
  return {
    id: id.padStart(12, "0"), ...owner, accountId: "882", botId: "99", status,
    goodsId: "9", goodsName: "合成旧商品", gameBiz: "hk4e_cn", type: 2,
    price: 200, role, addressId: "", addressLabel: "", createdAt: day, opensAt: day,
    immediate: false, attempts: 0, message: "严禁带入的旧服务错误与 cookie=fixture", ...fields,
  };
}

function tracking(id: string, fields: object = {}) {
  return { id: id.padStart(12, "0"), ...owner, accountId: "882", botId: "99", game: "hk4e", gameBiz: "hk4e_cn",
    itemType: 2, mode: "goods", goodsIds: ["9"], names: ["旧合成追踪"], keywords: [], maxPrice: 200, spendLimit: 400,
    followSameName: false, role, addressId: "", enabled: true, createdAt: day, pollMs: 60_000, pollUnit: "minutes",
    leadMs: 5000, intervalMs: 500, message: "旧的等待跳转信息", ...fields };
}

test("暂存按已知来源冻结旧商城写入，向原读取服务交付本人审计及可信现代计划", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-migration-shop-audit-"));
  const source = join(root, "source");
  const stage = join(root, "stage");
  const modernFile = join(source, shopPath);
  const profilePath = "data/users/42.yaml";
  const profile = Bun.YAML.stringify({
    user: { qq: "42" }, profile: { id: 1 },
    account: { stuid: "882", ltuid: "882", cookie: "account_id=882;cookie_token=fixture", stoken: "fixture-token" },
    device: { id: "fixture-device", fp: "fixture-fingerprint", bound: true },
  });
  let now = day;
  const outbound: string[] = [];
  const inspect: Parameters<typeof createMiyousheShopPlans>[0]["inspect"] = async (_, id) => {
    outbound.push("inspect:" + id);
    return { good: { id, name: "合成现代商品", type: 2, gameBiz: "hk4e_cn", price: 200,
      status: now < safeTime ? "scheduled" : "available", opensAt: safeTime }, balance: 2000, roles: [role] };
  };
  const submit: NonNullable<Parameters<typeof createMiyousheShopPlans>[0]["submit"]> = async ({ goodsId }) => {
    outbound.push("submit:" + goodsId);
    return "succeeded";
  };
  try {
    await put(source, profilePath, profile);
    await put(stage, profilePath, profile);
    const otherOwner = { qq: "44", profileId: 1 };
    const otherProfile = profile.replace('qq: "42"', 'qq: "44"').replaceAll("882", "883");
    await put(stage, "data/users/44.yaml", otherProfile);
    const store = createProfileStore(join(stage, "data/users"));
    const login = await store.loginIdentity(otherOwner.qq, otherOwner.profileId);
    const otherProof = createHash("sha256").update(JSON.stringify([login, "fixture-device", "fixture-fingerprint"])).digest("hex");
    const runtime = createMiyousheShopPlans({
      file: modernFile, profileDirectory: join(source, "data/users"), inspect, submit, now: () => now,
    });
    const booked = await runtime.reserve(owner, {
      goodsId: "8", expectedPrice: 200, immediate: false, confirmed: true, uid: role.uid, region: role.region,
    });
    expect(booked.status).toBe("scheduled");
    const originalModern = JSON.parse(await readFile(modernFile, "utf8"));
    const proof = originalModern.plans[0].bindingStamp;
    await put(source, shopPath, ledger([
      ...originalModern.plans,
      purchase("b", "scheduled", { bindingStamp: proof, goodsId: "9" }),
      purchase("c", "preparing", { bindingStamp: proof, goodsId: "10", opensAt: safeTime + 60_000 }),
      purchase("d", "scheduled", { bindingStamp: proof, goodsId: "11", immediate: true, manualSessionExpected: true }),
    ], [
      tracking("e", { confirmation: { bindingStamp: proof, at: day } }),
      tracking("f", { ...otherOwner, accountId: "883", confirmation: { bindingStamp: otherProof, at: day }, nextPollAt: safeTime + 120_000 }),
    ]));
    const oldPlanFile = ledger([
      purchase("1", "submitting", { attempts: 1, trackingId: "000000000000" }),
      purchase("2", "preparing", { attempts: 2, goodsId: "12" }),
      purchase("3", "scheduled", { goodsId: "13" }),
      purchase("4", "succeeded"),
      purchase("5", "failed"),
    ], [tracking("0")]);
    await put(source, join(old, shopPath), oldPlanFile);
    await put(source, join(old, previewPath), ledger([purchase("3", "scheduled")], [tracking("0")]));
    const audit = (source: string, time: string, qq = "42") => JSON.stringify({
      qq, profileId: 1, time, source, stage: "checkin", ok: false,
      message: "旧错误含 Cookie=fixture 和可能的 QQ 群文字", counts: { unconfirmed: 1, bogus: 11 },
    });
    const first = audit("manual_community_retry", "2026-11-21T14:00:00+08:00");
    await put(source, historyPath, first + "\n");
    await put(source, join(old, historyPath), first + "\n" +
      audit("scheduled_signin_retry", "2026-11-21T14:30:00+08:00") + "\n" + '{"message":"partial and private"');
    await put(source, join(old, "data/audit/remote.jsonl"), "不在迁移范围");

    outbound.length = 0;
    const report = await stageLegacyShopAudit(source, stage);
    expect(report.audit).toEqual({ files: 2, rows: 2, duplicates: 1, invalid: 1 });
    expect(report.plans).toMatchObject({
      files: 2, plans: 9, trackers: 3, frozen: 3, unknown: 2, paused: 2, activePlans: 2, activeTrackers: 1,
      reasons: { legacyBinding: 1, sessionEnded: 1, accountPending: 1, submitting: 1, priorAttempt: 1, trackerBinding: 1, trackerAccountPending: 1 },
    });
    expect(report.preview).toMatchObject({ files: 1, plans: 1, trackers: 1, frozen: 1, paused: 1, activePlans: 0, activeTrackers: 0 });
    expect(outbound).toEqual([]);
    expect((await stat(join(stage, shopPath))).mode & 0o777).toBe(0o600);
    expect((await stat(join(stage, historyPath))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(source, old, shopPath), "utf8"))).toEqual(oldPlanFile);
    expect(await readFile(join(stage, historyPath), "utf8")).not.toMatch(/Cookie|partial|bogus/);
    expect(await readFile(join(stage, shopPath), "utf8")).not.toMatch(/cookie=|等待跳转|manualSessionExpected/);
    expect(await Bun.file(join(stage, "data/audit/remote.jsonl")).exists()).toBe(false);
    const auditReader = createCheckinAudit(join(stage, historyPath));
    expect(await auditReader.read({ qq: "43" })).toEqual([]);
    expect((await auditReader.read({ qq: "42" })).map(row => [row.source, row.counts?.unconfirmed]))
      .toEqual([["scheduled_retry", 1], ["manual", 1]]);

    const staged = createMiyousheShopPlans({ file: join(stage, shopPath), profileDirectory: join(stage, "data/users"), now: () => now,
      inspect, submit,
      tracking: { async catalog() { throw new Error("应暂停旧、未知及预览追踪"); }, async destinations() { return { roles: [role] }; } },
    });
    const rules = await staged.listTrackers(owner);
    expect(rules.trackers).toHaveLength(2);
    expect(rules.trackers.every(rule => !rule.enabled)).toBe(true);
    expect((await staged.listTrackers(otherOwner)).trackers).toMatchObject([
      { enabled: true, needsConfirmation: false, migrationBlocked: false, nextPollAt: safeTime + 120_000 },
    ]);
    expect((await staged.list(owner)).plans.filter(item => item.status === "unknown")).toHaveLength(2);
    await staged.scan();
    expect(outbound).toEqual([]);
    now = safeTime;
    await staged.scan();
    expect(outbound.filter(item => item.startsWith("submit:"))).toEqual(["submit:8"]);
    expect((await staged.list(owner)).plans.find(item => item.id === booked.id)?.status).toBe("succeeded");
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("暂存遇商城冲突、链接或目标已存在时拒绝覆盖，保留副本", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-migration-shop-conflict-"));
  const source = join(root, "source");
  const stage = join(root, "stage");
  try {
    await mkdir(stage);
    await put(source, shopPath, ledger([purchase("1", "failed")]));
    await put(source, join(old, shopPath), ledger([purchase("1", "succeeded")]));
    await expect(stageLegacyShopAudit(source, stage)).rejects.toThrow("记录有冲突");
    expect(await Bun.file(join(stage, shopPath)).exists()).toBe(false);
    await put(source, shopPath, { ...ledger([purchase("1", "failed")]), importedLegacy: ["Lotus-Plugin"] });
    await put(stage, shopPath, "existing-stage");
    await expect(stageLegacyShopAudit(source, stage)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(join(stage, shopPath), "utf8")).toBe("existing-stage");
    await rm(join(stage, shopPath));
    expect((await stageLegacyShopAudit(source, stage)).plans.alreadyImportedFiles).toBe(1);
    await rm(join(source, shopPath));
    await symlink(join(stage, shopPath), join(source, shopPath));
    await expect(stageLegacyShopAudit(source, stage)).rejects.toThrow("普通文件");
    await expect(stageLegacyShopAudit(source, source)).rejects.toThrow("必须分离");
  } finally { await rm(root, { recursive: true, force: true }); }
});
