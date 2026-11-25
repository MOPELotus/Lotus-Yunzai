import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createProfileStore, MAX_PROFILE_ID, profileCookieAccountId } from "@lotus-yunzai/account";
import { isStoredCheckinAuditTime, storedCheckinAuditSource, type CheckinAuditEntry } from "./checkin-audit.ts";
import { legacyLotusDirectories } from "./lotus-global-config.ts";
import type { MiyousheShopPlan } from "./miyoushe-shop-plans.ts";
import { asTrackerRecord as record, trackerId, trackingRule } from "./miyoushe-shop-tracking.ts";

const stores = [
  { path: "data", id: undefined },
  ...legacyLotusDirectories.map(id => ({ path: `plugins/${id}/data`, id })),
];
const auditFile = "audit/checkin.jsonl";
const activeShopFile = "coinShop/plans.json";
const previewShopFile = "coinShop/preview-plans.json";
const numericId = /^[1-9]\d{0,19}$/u;
const qqId = /^[1-9]\d{0,18}$/u;
const code = /^[a-zA-Z0-9_]{1,32}$/u;
const stamp = /^[a-f0-9]{64}$/u;
const stages = ["refresh", "precheck", "runner", "checkin", "schedule"] as const;
const countKeys = ["signed", "already", "first-bind", "unconfirmed", "failed", "skipped", "community-accepted", "community-already"] as const;
const statuses = ["scheduled", "preparing", "submitting", "unknown", "cancelled", "missed", "succeeded", "failed"] as const;
const terminal = ["cancelled", "missed", "succeeded", "failed"] as const;
const frozen = $t("lib.migration-shop-audit.text_b5ccbdf88f");
const awaiting = $t("lib.migration-shop-audit.text_5aed717c7d");

function valid(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

function natural(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function profileId(value: unknown): value is number {
  return natural(value) && value >= 1 && value <= MAX_PROFILE_ID;
}

function safeText(value: unknown, limit: number) {
  return typeof value === "string" ? value.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, limit) : "";
}

function maskedAddress(value: unknown) {
  return valid(value, /^[^\p{Cc}\p{Cf}*]\*\* \*{4}\d{0,4}$/u) ? value : "";
}

async function state(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
}

function sameFile(a: Stats, b: Stats | undefined) {
  return !!b && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function within(parent: string, path: string) {
  const local = relative(parent, path);
  return local !== ".." && !local.startsWith(".." + sep) && !isAbsolute(local);
}

async function readFrozen(path: string, max: number, inventories: Map<string, Stats>) {
  const info = await state(path);
  if (!info) return;
  if (!info.isFile() || info.nlink !== 1 || info.size > max || await realpath(path) !== path) {
    throw new Error($t("lib.migration-shop-audit.text_176845705c"));
  }
  const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!sameFile(info, await input.stat())) throw new Error($t("lib.migration-shop-audit.text_497b7f3621"));
    const bytes = await input.readFile();
    if (!sameFile(info, await input.stat()) || bytes.byteLength !== info.size) {
      throw new Error($t("lib.migration-shop-audit.text_497b7f3621"));
    }
    inventories.set(path, info);
    return bytes;
  } finally { await input.close(); }
}

function auditRow(line: string) {
  if (Buffer.byteLength(line, "utf8") > 4096) return;
  let data: ReturnType<typeof record>;
  try { data = record(JSON.parse(line)); } catch { return; }
  const stage = stages.find(item => item === data?.stage);
  const source = storedCheckinAuditSource(data?.source);
  const qq = data?.qq;
  const time = data?.time;
  if (!data || !stage || !source || !valid(qq, qqId) || !profileId(data.profileId) || typeof data.ok !== "boolean" ||
      !isStoredCheckinAuditTime(time)) return;
  let counts: CheckinAuditEntry["counts"];
  if (data.counts !== undefined) {
    const raw = record(data.counts);
    if (!raw) return;
    const values: Partial<Record<typeof countKeys[number], number>> = {};
    for (const key of countKeys) {
      if (!Object.hasOwn(raw, key)) continue;
      const value = raw[key];
      if (!natural(value)) return;
      values[key] = value;
    }
    counts = values;
  }
  return { time: new Date(time).toISOString(), qq, profileId: data.profileId, ok: data.ok, stage, source,
    ...(counts && { counts }), message: $t("lib.migration-shop-audit.text_b0f9000340") };
}

function normalizeRole(value: unknown) {
  const role = record(value);
  if (!role || !valid(role.uid, numericId) || !valid(role.region, code) || !valid(role.gameBiz, code)) return null;
  return { uid: role.uid, region: role.region, gameBiz: role.gameBiz };
}

function shopIdentity(value: unknown) {
  const row = record(value);
  if (!row || !valid(row.id, trackerId) || !valid(row.qq, numericId) || !valid(row.accountId, numericId) ||
      !profileId(row.profileId)) throw new Error($t("lib.migration-shop-audit.text_0476a03d29"));
  return { row, id: row.id, qq: row.qq, profileId: row.profileId, accountId: row.accountId };
}

function planFrom(value: unknown) {
  const { row, ...identity } = shopIdentity(value);
  const status = statuses.find(item => item === row.status);
  if (!status || !valid(row.goodsId, numericId) || (row.type !== 1 && row.type !== 2) ||
      !natural(row.price) || !natural(row.createdAt) || !natural(row.opensAt) || !natural(row.attempts) ||
      typeof row.immediate !== "boolean" || typeof row.goodsName !== "string") throw new Error($t("lib.migration-shop-audit.text_219fcb8781"));
  const plan: MiyousheShopPlan = {
    ...identity, botId: valid(row.botId, numericId) ? row.botId : "", goodsId: row.goodsId,
    goodsName: safeText(row.goodsName, 240), type: row.type, price: row.price,
    gameBiz: valid(row.gameBiz, code) ? row.gameBiz : "", role: normalizeRole(row.role),
    addressId: valid(row.addressId, numericId) ? row.addressId : "", addressLabel: maskedAddress(row.addressLabel),
    createdAt: row.createdAt, opensAt: row.opensAt, attempts: row.attempts, immediate: row.immediate, status, message: "",
    ...(natural(row.finishedAt) ? { finishedAt: row.finishedAt } : {}),
    ...(valid(row.trackingId, trackerId) ? { trackingId: row.trackingId } : {}),
    ...(valid(row.cycleKey, /^[a-zA-Z0-9_:-]{1,120}$/u) ? { cycleKey: row.cycleKey } : {}),
    ...(natural(row.preStartMs) ? { preStartMs: row.preStartMs } : {}),
    ...(natural(row.retryIntervalMs) ? { retryIntervalMs: row.retryIntervalMs } : {}),
    ...(valid(row.bindingStamp, stamp) ? { bindingStamp: row.bindingStamp } : {}),
    ...(valid(row.intentId, /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u) && valid(row.intentFingerprint, stamp)
      ? { intentId: row.intentId, intentFingerprint: row.intentFingerprint } : {}),
  };
  return { plan, dispatchEvidence: row.attempts > 0 || row.firstAttemptAt !== undefined, sessionExpected: row.manualSessionExpected === true };
}

function trackerFrom(value: unknown) {
  const { row, ...identity } = shopIdentity(value);
  const list = (input: unknown, limit: number, each: (entry: unknown) => string) =>
    Array.isArray(input) ? input.slice(0, limit).map(each).filter(Boolean) : [];
  const confirmation = record(row.confirmation);
  const fields = {
    ...identity, enabled: row.enabled === true, game: valid(row.game, code) ? row.game : "",
    gameBiz: valid(row.gameBiz, code) ? row.gameBiz : "", mode: row.mode === "goods" || row.mode === "category" ? row.mode : "",
    itemType: row.itemType === 1 || row.itemType === 2 ? row.itemType : null,
    goodsIds: list(row.goodsIds, 20, id => valid(id, numericId) ? id : ""), names: list(row.names, 20, name => safeText(name, 240)),
    keywords: list(row.keywords, 10, word => safeText(word, 80)), followSameName: row.followSameName === true,
    maxPrice: row.maxPrice === null || natural(row.maxPrice) ? row.maxPrice : undefined,
    spendLimit: row.spendLimit === null || natural(row.spendLimit) ? row.spendLimit : undefined,
    role: normalizeRole(row.role), addressId: valid(row.addressId, numericId) ? row.addressId : "", addressLabel: maskedAddress(row.addressLabel),
    createdAt: natural(row.createdAt) ? row.createdAt : 0, pollUnit: row.pollUnit === "minutes" ? "minutes" : undefined,
    pollMs: natural(row.pollMs) ? row.pollMs : undefined, leadMs: natural(row.leadMs) ? row.leadMs : undefined,
    intervalMs: natural(row.intervalMs) ? row.intervalMs : undefined, nextPollAt: natural(row.nextPollAt) ? row.nextPollAt : undefined,
    lastPolledAt: natural(row.lastPolledAt) ? row.lastPolledAt : undefined, nextOpenAt: natural(row.nextOpenAt) ? row.nextOpenAt : undefined,
    matchedCount: natural(row.matchedCount) ? row.matchedCount : undefined,
    ...(confirmation && valid(confirmation.bindingStamp, stamp) && natural(confirmation.at)
      ? { confirmation: { bindingStamp: confirmation.bindingStamp, at: confirmation.at } } : {}),
  };
  return { fields, validOriginal: trackingRule(row) !== undefined };
}

function collect<T extends { id: string }>(items: Map<string, T>, value: T) {
  const earlier = items.get(value.id);
  if (earlier && !isDeepStrictEqual(earlier, value)) throw new Error($t("lib.migration-shop-audit.text_d91fa93b02"));
  if (!earlier) items.set(value.id, value);
}

async function dataDirectory(path: string) {
  const known = await state(path);
  if (!known) {
    await dataDirectory(dirname(path));
    await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
  } else if (!known.isDirectory()) throw new Error($t("lib.migration-shop-audit.text_f2bd732f65"));
  if (await realpath(path) !== path) throw new Error($t("lib.migration-shop-audit.text_15aa9a2ffc"));
}

export async function stageLegacyShopAudit(sourcePath: string, stagePath: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const source = await realpath(sourcePath);
  const stage = await realpath(stagePath);
  if (within(source, stage) || within(stage, source)) throw new Error($t("lib.migration-shop-audit.text_d2eb07a017"));
  const inventory = new Map<string, Stats>();
  const output = new Map<string, string>();
  const profiles = createProfileStore(join(stage, "data", "users"));
  const bindings = new Map<string, Promise<{ accountId: string; bindingStamp: string } | undefined>>();
  async function binding(qq: string, profileId: number) {
    const key = `${qq}/${profileId}`;
    let cached = bindings.get(key);
    if (!cached) {
      cached = (async () => {
        const { account, device, revision } = await profiles.accountContext(qq, profileId);
        const accountId = profileCookieAccountId(account);
        if (!accountId || accountId !== (account.stuid || account.ltuid) || !device.id || !device.fp) return;
        const login = await profiles.loginIdentity(qq, profileId);
        if ((await profiles.accountContext(qq, profileId)).revision !== revision) return;
        return { accountId, bindingStamp: createHash("sha256").update(JSON.stringify([login, device.id, device.fp])).digest("hex") };
      })().catch(() => undefined);
      bindings.set(key, cached);
    }
    return cached;
  }

  const audit = { files: 0, rows: 0, duplicates: 0, invalid: 0 };
  const accepted: { text: string; at: number }[] = [];
  const previousAudits = new Map<string, number>();
  for (const location of stores) {
    const bytes = await readFrozen(join(source, location.path, auditFile), 64 * 1024 * 1024, inventory);
    if (!bytes) continue;
    audit.files++;
    const currentAudits = new Map<string, number>();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (let start = 0; start < bytes.length;) {
      signal?.throwIfAborted();
      const newline = bytes.indexOf(10, start);
      const line = bytes.subarray(start, newline === -1 ? bytes.length : newline);
      start = newline === -1 ? bytes.length : newline + 1;
      if (!line.length || (line.length === 1 && line[0] === 13)) continue;
      let row: ReturnType<typeof auditRow>;
      try { row = newline < 0 || line.length > 4096 ? undefined : auditRow(decoder.decode(line)); } catch { row = undefined; }
      if (!row) { audit.invalid++; continue; }
      const text = JSON.stringify(row);
      const count = (currentAudits.get(text) ?? 0) + 1;
      currentAudits.set(text, count);
      if (count <= (previousAudits.get(text) ?? 0)) { audit.duplicates++; continue; }
      accepted.push({ text, at: Date.parse(row.time) });
    }
    for (const [text, count] of currentAudits) previousAudits.set(text, Math.max(count, previousAudits.get(text) ?? 0));
  }
  audit.rows = accepted.length;
  if (accepted.length) output.set(auditFile, accepted.sort((a, b) => a.at - b.at).map(row => row.text + "\n").join(""));

  async function shop(path: string, preview: boolean) {
    const reasons = { legacyBinding: 0, sessionEnded: 0, accountPending: 0, trackingInactive: 0, missingTarget: 0, preview: 0,
      existingUnknown: 0, submitting: 0, priorAttempt: 0, trackerBinding: 0, trackerAccountPending: 0, trackerPreview: 0, trackerInvalid: 0 };
    const summary = { files: 0, alreadyImportedFiles: 0, plans: 0, trackers: 0, frozen: 0, unknown: 0, paused: 0,
      activePlans: 0, activeTrackers: 0, reasons };
    const imported = new Set<string>();
    const plans = new Map<string, ReturnType<typeof planFrom> & { id: string }>();
    const trackers = new Map<string, ReturnType<typeof trackerFrom> & { id: string }>();
    for (const { path: folder, id } of stores) {
      signal?.throwIfAborted();
      const bytes = await readFrozen(join(source, folder, path), 16 * 1024 * 1024, inventory);
      if (!bytes) continue;
      summary.files++;
      if (id && imported.has(id)) { summary.alreadyImportedFiles++; continue; }
      let data: ReturnType<typeof record>;
      try { data = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); } catch {}
      if (!data || (data.version !== 1 && data.version !== 2) || !Array.isArray(data.plans) ||
          (data.version === 2 && !Array.isArray(data.trackers)) || (data.trackers !== undefined && !Array.isArray(data.trackers))) {
        throw new Error($t("lib.migration-shop-audit.text_c86e87bf54"));
      }
      if (id) imported.add(id);
      if (!id && Array.isArray(data.importedLegacy)) {
        for (const known of legacyLotusDirectories) if (data.importedLegacy.includes(known)) imported.add(known);
      }
      const localPlans = new Set<string>();
      const localTrackers = new Set<string>();
      for (const value of data.plans) {
        const result = planFrom(value);
        if (localPlans.has(result.plan.id)) throw new Error($t("lib.migration-shop-audit.text_27a5f72705"));
        localPlans.add(result.plan.id);
        collect(plans, { id: result.plan.id, ...result });
      }
      for (const value of data.trackers ?? []) {
        const result = trackerFrom(value);
        if (localTrackers.has(result.fields.id)) throw new Error($t("lib.migration-shop-audit.text_2279cd9b85"));
        localTrackers.add(result.fields.id);
        collect(trackers, { id: result.fields.id, ...result });
      }
    }
    if (!summary.files) return summary;

    const unknownAccounts = new Set<string>();
    const unknownProducts = new Set<string>();
    for (const { plan, dispatchEvidence } of plans.values()) {
      if (plan.status === "unknown" || plan.status === "submitting" ||
          (dispatchEvidence && (plan.status === "preparing" || plan.status === "scheduled"))) {
        reasons[plan.status === "unknown" ? "existingUnknown" : plan.status === "submitting" ? "submitting" : "priorAttempt"]++;
        plan.status = "unknown";
        plan.message = awaiting;
        unknownAccounts.add(plan.accountId);
        unknownProducts.add(`${plan.accountId}/${plan.goodsId}`);
        summary.unknown++;
      }
    }
    const trackRows = [];
    const activeTrackers = new Map<string, ReturnType<typeof trackerFrom>["fields"]>();
    for (const { fields, validOriginal } of trackers.values()) {
      signal?.throwIfAborted();
      const bound = !preview && validOriginal && fields.confirmation && await binding(fields.qq, fields.profileId);
      const verified = bound && bound.accountId === fields.accountId && bound.bindingStamp === fields.confirmation?.bindingStamp;
      const { confirmation, ...raw } = fields;
      const enabled = Boolean(verified && fields.enabled && !unknownAccounts.has(fields.accountId));
      if (enabled) { activeTrackers.set(fields.id, fields); summary.activeTrackers++; }
      else if (fields.enabled) {
        summary.paused++;
        reasons[preview ? "trackerPreview" : !validOriginal ? "trackerInvalid" : !verified ? "trackerBinding" : "trackerAccountPending"]++;
      }
      trackRows.push({ ...raw, ...(!validOriginal && { maxPrice: undefined }), enabled,
        ...(verified && { confirmation }), message: enabled ? "" : $t("lib.migration-shop-audit.text_4260e08276") });
    }
    for (const { plan, sessionExpected } of plans.values()) {
      signal?.throwIfAborted();
      if (plan.status === "unknown" || terminal.some(status => status === plan.status)) continue;
      const bound = !preview && !sessionExpected && !plan.immediate && plan.bindingStamp && await binding(plan.qq, plan.profileId);
      const linked = plan.trackingId ? activeTrackers.get(plan.trackingId) : undefined;
      const reason = preview ? "preview" : sessionExpected || plan.immediate ? "sessionEnded"
        : !bound || bound.accountId !== plan.accountId || bound.bindingStamp !== plan.bindingStamp ? "legacyBinding"
        : unknownProducts.has(`${plan.accountId}/${plan.goodsId}`) ? "accountPending"
        : (plan.type === 1 ? !plan.addressId : !plan.role) ? "missingTarget"
        : plan.trackingId && (!linked || linked.qq !== plan.qq || linked.profileId !== plan.profileId ||
          linked.accountId !== plan.accountId || linked.confirmation?.bindingStamp !== plan.bindingStamp) ? "trackingInactive"
        : undefined;
      if (!reason) {
        plan.status = "scheduled";
        summary.activePlans++;
      } else {
        plan.status = "cancelled";
        plan.message = reason === "sessionEnded" ? $t("lib.migration-shop-audit.text_6327bf1d6b")
          : reason === "accountPending" ? $t("lib.migration-shop-audit.text_c8bdd66b9e") : frozen;
        summary.frozen++;
        reasons[reason]++;
      }
    }
    const savedPlans = [...plans.values()].map(({ plan }) => plan);
    summary.plans = savedPlans.length;
    summary.trackers = trackRows.length;
    output.set(path, JSON.stringify({ version: 2, plans: savedPlans, trackers: trackRows, importedLegacy: [...imported] }, null, 2) + "\n");
    return summary;
  }

  const plans = await shop(activeShopFile, false);
  const preview = await shop(previewShopFile, true);
  for (const [path, expected] of inventory) {
    if (!sameFile(expected, await state(path)) || await realpath(path) !== path) throw new Error($t("lib.migration-shop-audit.text_81b2cfe1a9"));
  }
  const created: string[] = [];
  try {
    for (const [path, contents] of output) {
      signal?.throwIfAborted();
      const file = join(stage, "data", path);
      await dataDirectory(dirname(file));
      const destination = await open(file, "wx", 0o600);
      created.push(file);
      try { await destination.writeFile(contents); await destination.sync(); } finally { await destination.close(); }
    }
    signal?.throwIfAborted();
  } catch (error) {
    await Promise.all(created.map(file => unlink(file)));
    throw error;
  }
  return { audit, plans, preview };
}
