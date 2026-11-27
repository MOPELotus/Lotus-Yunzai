import { withCaptchaInteraction } from "../packages/hoyo-client/captcha.ts";
import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { createProfileStore, profileCookieAccountId } from "@lotus-yunzai/account";
import { MiyousheExchangeError, type MiyousheShopExchangeResult, type ShopManualVerification } from "@lotus-yunzai/hoyo-client/miyoushe-exchange";
import type { createManualCaptchaRelay } from "./captcha/manual-relay.ts";
import { lockFile } from "./file-lock.ts";
import type { MiyousheOverviewTarget } from "./miyoushe-overview.ts";
import { miyousheShopRegionName } from "./miyoushe-shop-catalog.ts";
import { asTrackerRecord, confirmedTracker, matchesTrackingGood, readTrackingInput, trackingCycle, trackingGame, trackingGames,
  trackingProfileGames, trackingRule, trackingSection, type ShopTracker, type TrackingGood, type TrackingRole } from "./miyoushe-shop-tracking.ts";

const planId = /^[a-f0-9]{12}$/u;
const historyCursor = /^(\d{1,16})\.([a-f0-9]{12})$/u;
const shopHistoryPageSize = 30;
const numericId = /^[1-9]\d{0,19}$/u;
const code = /^[a-zA-Z0-9_]{1,32}$/u;
const intentPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
const preparingLead = 15_000;
const maxDelay = 30_000;
const manualVerificationTimeout = 185_000;
const receiptLifetime = 24 * 3_600_000;
const receiptPollInterval = 15_000;

const statusMessage = {
  scheduled: $t("lib.miyoushe-shop-plans.text_3702391dc1"),
  preparing: $t("lib.miyoushe-shop-plans.text_1b0a988dd8"),
  submitting: $t("lib.miyoushe-shop-plans.text_903171463e"),
  unknown: $t("lib.miyoushe-shop-plans.text_5aed717c7d"),
  cancelled: $t("lib.miyoushe-shop-plans.text_a37778f17c"),
  missed: $t("lib.miyoushe-shop-plans.text_0033a9c2ef"),
  succeeded: $t("lib.miyoushe-shop-plans.text_ea53cc2f96"),
  failed: $t("lib.miyoushe-shop-plans.text_62ac729f8d"),
};
const details = {
  changed: $t("lib.miyoushe-shop-plans.text_60620706e9"),
  resolveAccount: $t("lib.miyoushe-shop-plans.text_99df87f028"),
  trackerRoleChanged: $t("lib.miyoushe-shop-plans.text_d52cd6d878"),
  legacy: $t("lib.miyoushe-shop-plans.text_b5ccbdf88f"),
  updated: $t("lib.miyoushe-shop-plans.text_f14e66b405"),
  conditions: $t("lib.miyoushe-shop-plans.text_1d0e18f115"),
  unavailable: $t("lib.miyoushe-shop-plans.text_6864aeab48"),
  redeemed: $t("lib.miyoushe-shop-plans.text_1dca1b9bff"),
  unredeemed: $t("lib.miyoushe-shop-plans.text_23f6f07b19"),
  stockEmpty: $t("lib.miyoushe-shop-plans.text_cef8499b57"),
  accountQuota: $t("lib.miyoushe-shop-plans.text_21edea8478"),
  pending: $t("lib.miyoushe-shop-plans.text_c8bdd66b9e"),
  verification: $t("lib.miyoushe-shop-plans.text_0a3657e4e9"),
  sessionEnded: $t("lib.miyoushe-shop-plans.text_6327bf1d6b"),
  "rate-limited": $t("lib.miyoushe-shop-plans.text_a9463ba8a0"),
} as const;
const trackerMessages = {
  start: $t("lib.miyoushe-shop-plans.text_e1cadb0b59"),
  resume: $t("lib.miyoushe-shop-plans.text_912b21fbc4"),
  pause: $t("lib.miyoushe-shop-plans.text_4260e08276"),
  booked: $t("lib.miyoushe-shop-plans.text_cfa6341ffb"),
  watching: $t("lib.miyoushe-shop-plans.text_39d1c108a8"),
  accountQuota: $t("lib.miyoushe-shop-plans.text_bddddd02c2"),
  retry: $t("lib.miyoushe-shop-plans.text_d6b3390407"),
  changed: $t("lib.miyoushe-shop-plans.text_72ab655a67"),
  unknown: $t("lib.miyoushe-shop-plans.text_defc2e6590"),
} as const;
const publicTrackerMessages = new Set<string>([...Object.values(trackerMessages), details.verification, details["rate-limited"], statusMessage.unknown]);
const publicMessages = new Set([...Object.values(statusMessage), ...Object.values(details)]);
type Status = keyof typeof statusMessage;
type Role = { readonly uid: string; readonly region: string; readonly gameBiz: string };
export type MiyousheShopReceiptRoute = { readonly adapter: "onebot" | "milky"; readonly botId: number };

export function parseMiyousheShopReceiptRoute(value: unknown): MiyousheShopReceiptRoute | undefined {
  const match = typeof value === "string" ? /^(onebot|milky):([1-9]\d*)$/u.exec(value) : null;
  if (!match || !Number.isSafeInteger(Number(match[2]))) return;
  return { adapter: match[1] === "milky" ? "milky" : "onebot", botId: Number(match[2]) };
}
type ManualRelay = Pick<ReturnType<typeof createManualCaptchaRelay>, "register" | "readResult">;
interface ManualShopSession {
  readonly sessionId: string;
  readonly signal: AbortSignal;
  verify(signal: AbortSignal): Promise<void>;
}
interface ImmediateVerification {
  readonly session: ManualShopSession;
  readonly cancel: AbortController;
  ticket?: { readonly link: string; readonly expiresAt: number };
}

export interface MiyousheShopPlan extends MiyousheOverviewTarget {
  readonly id: string;
  readonly accountId: string;
  readonly botId: string;
  readonly goodsId: string;
  readonly goodsName: string;
  readonly gameBiz: string;
  readonly type: 1 | 2;
  readonly price: number;
  readonly role: Role | null;
  readonly addressId: string;
  readonly addressLabel: string;
  readonly immediate: boolean;
  readonly createdAt: number;
  readonly receiptRoute?: string;
  readonly trackingId?: string;
  readonly cycleKey?: string;
  readonly preStartMs?: number;
  readonly retryIntervalMs?: number;
  readonly bindingStamp?: string;
  readonly intentId?: string;
  readonly intentFingerprint?: string;
  readonly manualSessionExpected?: true;
  status: Status;
  opensAt: number;
  message: string;
  attempts: number;
  finishedAt?: number;
  receipt?: "pending" | "claimed";
}

export interface MiyousheShopInspection {
  readonly good: TrackingGood;
  readonly balance: number;
  readonly roles?: readonly { readonly uid: string; readonly region: string }[];
  readonly addresses?: readonly { readonly id: string; readonly label: string }[];
}

interface Options {
  readonly file: string;
  readonly legacyFiles?: readonly { readonly id: string; readonly file: string }[];
  readonly profileDirectory?: string | URL;
  readonly now?: () => number;
  readonly inspect: (target: MiyousheOverviewTarget, goodsId: string, signal?: AbortSignal,
    verifyBinding?: () => Promise<void>) => Promise<MiyousheShopInspection>;
  readonly submit?: (plan: Readonly<MiyousheShopPlan>, signal?: AbortSignal,
    verifyBinding?: () => Promise<void>, manual?: ShopManualVerification,
    firstDispatchAllowed?: () => boolean) => Promise<MiyousheShopExchangeResult>;
  readonly manualRelay?: () => ManualRelay | undefined;
  readonly receiptRoute?: (qq: string, route: MiyousheShopReceiptRoute, signal?: AbortSignal) =>
    Promise<((message: string) => Promise<unknown>) | undefined>;
  readonly tracking?: {
    readonly accountQuota?: (target: MiyousheOverviewTarget, good: TrackingGood, signal?: AbortSignal,
      verifyBinding?: () => Promise<void>) => Promise<{ readonly limit: number; readonly used: number } | undefined>;
    readonly catalog: (target: MiyousheOverviewTarget, game: string, signal?: AbortSignal,
      verifyBinding?: () => Promise<void>) => Promise<readonly TrackingGood[]>;
    readonly destinations: (target: MiyousheOverviewTarget, game: string, itemType: 1 | 2, signal?: AbortSignal,
      verifyBinding?: () => Promise<void>) => Promise<{
        roles?: readonly (TrackingRole & { readonly regionName?: string })[];
        addresses?: readonly { readonly id: string; readonly label: string }[];
      }>;
  };
}

export class MiyousheShopPlanError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 503, message: string) { super(message); }
}

function bad(message: string): never { throw new MiyousheShopPlanError(400, message); }
function conflict(message: string): never { throw new MiyousheShopPlanError(409, message); }
function trackerBindingChanged(error: unknown): error is MiyousheShopPlanError {
  return error instanceof MiyousheShopPlanError &&
    (error.message === details.changed || error.message === details.trackerRoleChanged);
}
function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function matching(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}
function natural(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function clean(value: string, limit: number) {
  return value.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, limit);
}
function active(status: Status) { return status === "scheduled" || status === "preparing" || status === "submitting"; }

function localSaleEnd(good: TrackingGood, now: number) {
  return natural(good.endsAt) ? now + good.endsAt - (natural(good.serverNow) ? good.serverNow : now) : Infinity;
}

function validPlan(value: unknown): value is MiyousheShopPlan {
  const plan = asRecord(value);
  return !!plan && matching(plan.id, planId) && matching(plan.qq, numericId) && matching(plan.accountId, numericId) &&
    natural(plan.profileId) && plan.profileId >= 1 && plan.profileId <= 255 &&
    matching(plan.goodsId, numericId) && typeof plan.goodsName === "string" && typeof plan.gameBiz === "string" &&
    (plan.type === 1 || plan.type === 2) && natural(plan.price) && natural(plan.opensAt) &&
    natural(plan.createdAt) && natural(plan.attempts) && typeof plan.status === "string" &&
    Object.hasOwn(statusMessage, plan.status) && typeof plan.immediate === "boolean" &&
    (plan.bindingStamp === undefined || matching(plan.bindingStamp, /^[a-f0-9]{64}$/u));
}

function publicPlan(plan: MiyousheShopPlan) {
  const { id, profileId, goodsId, goodsName, price, type, status, opensAt, immediate, createdAt, attempts } = plan;
  const role = plan.role && matching(plan.role.uid, numericId) && matching(plan.role.region, code)
    ? { uid: plan.role.uid, region: plan.role.region, gameBiz: matching(plan.role.gameBiz, code) ? plan.role.gameBiz : "",
      regionName: miyousheShopRegionName(plan.role.gameBiz || plan.gameBiz, plan.role.region) } : null;
  return { id, profileId, goodsId, goodsName: clean(goodsName, 240), price, type, status, opensAt, immediate, createdAt, attempts,
    role, addressLabel: addressLabel(plan.addressLabel), message: publicMessages.has(plan.message) ? plan.message : statusMessage[status],
    ...(natural(plan.finishedAt) ? { finishedAt: plan.finishedAt } : {}),
    ...(matching(plan.trackingId, planId) ? { trackingId: plan.trackingId } : {}) };
}

function addressLabel(label: unknown) {
  return matching(label, /^(?:[^\p{Cc}\p{Cf}*])\*\* \*\*\*\*\d{0,4}$/u) ? label : "";
}

interface Store { version: 1 | 2; plans: MiyousheShopPlan[]; trackers?: unknown[]; importedLegacy?: string[] }

function createStore(file: string, legacyFiles: NonNullable<Options["legacyFiles"]>) {
  const directory = dirname(file);
  let migrated: Promise<void> | undefined;

  async function readFile(path: string): Promise<Store | undefined> {
    try {
      const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!(await input.stat()).isFile()) throw new Error($t("lib.miyoushe-shop-plans.text_a865bdf958"));
        const data = asRecord(JSON.parse(await input.readFile("utf8")));
        if (!data || (data.version !== 1 && data.version !== 2) ||
            !Array.isArray(data.plans) || !data.plans.every(validPlan) ||
            new Set(data.plans.map(plan => plan.id)).size !== data.plans.length ||
            (data.version === 2 && !Array.isArray(data.trackers)) ||
            (data.trackers !== undefined && !Array.isArray(data.trackers)) ||
            (data.importedLegacy !== undefined && (!Array.isArray(data.importedLegacy) ||
              !data.importedLegacy.every(id => typeof id === "string")))) throw new Error($t("lib.miyoushe-shop-plans.text_5a7d144534"));
        return data as unknown as Store;
      } finally { await input.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }

  async function readPrimary(): Promise<Store> {
    return await readFile(file) ?? { version: 2, plans: [], trackers: [] };
  }

  async function changePrimary<T>(edit: (data: Store) => T | Promise<T>): Promise<T> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const guard = await lockFile(join(directory, `.${basename(file)}.sqlite`), $t("lib.miyoushe-shop-plans.text_220d263cae"));
    try {
      const data = await readPrimary();
      const previous = JSON.stringify(data);
      const result = await edit(data);
      if (previous === JSON.stringify(data)) return result;
      const stage = join(directory, `.${basename(file)}.${randomUUID()}.tmp`);
      try {
        const output = await open(stage, "wx", 0o600);
        try {
          await output.writeFile(`${JSON.stringify({ ...data, version: 2, trackers: data.trackers ?? [] }, null, 2)}\n`);
          await output.sync();
        } finally { await output.close(); }
        await rename(stage, file);
        const anchor = await open(directory, constants.O_DIRECTORY);
        try { await anchor.sync(); } finally { await anchor.close(); }
      } finally { await rm(stage, { force: true }); }
      return result;
    } finally { guard.close(); }
  }

  function ensureMigrated() {
    return migrated ??= (async () => {
      if (!legacyFiles.length) return;
      const known = (await readPrimary()).importedLegacy ?? [];
      const unchecked = legacyFiles.filter(source => !known.includes(source.id));
      const sources = await Promise.all(unchecked.map(async source => ({ ...source, data: await readFile(source.file) })));
      if (!sources.some(source => source.data)) return;
      await changePrimary(data => {
        const imported = data.importedLegacy ??= [];
        const trackers = data.trackers ??= [];
        const plansById = new Map(data.plans.map(plan => [plan.id, plan]));
        for (const source of sources) {
          if (!source.data || imported.includes(source.id)) continue;
          for (const plan of source.data.plans) {
            const existing = plansById.get(plan.id);
            if (existing && !isDeepStrictEqual(existing, plan)) throw new Error($t("lib.miyoushe-shop-plans.text_b7c5b2161e"));
            if (!existing) {
              data.plans.push(plan);
              plansById.set(plan.id, plan);
            }
          }
          for (const tracker of source.data.trackers ?? []) {
            const id = asTrackerRecord(tracker)?.id;
            if (trackers.some(item => isDeepStrictEqual(item, tracker))) continue;
            if (typeof id === "string" && trackers.some(item => asTrackerRecord(item)?.id === id)) {
              throw new Error($t("lib.miyoushe-shop-plans.text_30a159b5df"));
            }
            trackers.push(tracker);
          }
          imported.push(source.id);
        }
      });
    })().catch(error => { migrated = undefined; throw error; });
  }

  async function read() {
    await ensureMigrated();
    return readPrimary();
  }

  async function change<T>(edit: (data: Store) => T | Promise<T>) {
    await ensureMigrated();
    return changePrimary(edit);
  }

  async function withAccount<T>(accountId: string, action: () => Promise<T>) {
    const account = createHash("sha256").update(accountId).digest("hex");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const guard = await lockFile(join(directory, `.${basename(file)}.account-${account}.sqlite`), $t("lib.miyoushe-shop-plans.text_4ca181643f"), 0).catch(error => {
      if (error instanceof Error && error.message === "账号兑换正在更新，请稍后重试。") return undefined;
      throw error;
    });
    if (!guard) return;
    try { return await action(); } finally { guard.close(); }
  }
  return { read, change, withAccount };
}

function reservationInput(value: unknown) {
  const input = asRecord(value);
  if (!input || input.confirmed !== true || !matching(input.goodsId, numericId) || typeof input.immediate !== "boolean" ||
    (input.uid !== undefined && input.uid !== "" && !matching(input.uid, numericId)) ||
    (input.region !== undefined && input.region !== "" && !matching(input.region, code)) ||
    (input.addressId !== undefined && input.addressId !== "" && !matching(input.addressId, numericId)) ||
    (input.intentId !== undefined && !matching(input.intentId, intentPattern)) ||
    (input.expectedPrice !== undefined && !natural(input.expectedPrice)) ||
    Object.keys(input).some(key => !["confirmed", "goodsId", "immediate", "uid", "region", "addressId", "intentId", "expectedPrice"].includes(key))) {
    bad($t("lib.miyoushe-shop-plans.text_248a15aeb9"));
  }
  return { goodsId: input.goodsId, immediate: input.immediate, uid: input.uid, region: input.region, addressId: input.addressId,
    intentId: typeof input.intentId === "string" ? input.intentId : undefined, expectedPrice: input.expectedPrice };
}

function validateInspection({ good, balance }: MiyousheShopInspection, goodsId: string, immediate: boolean) {
  if (good.id !== goodsId || !natural(good.price) || (good.type !== 1 && good.type !== 2) ||
      !clean(good.name, 240) || (good.type === 2 && !matching(good.gameBiz, code))) bad($t("lib.miyoushe-shop-plans.text_55e60ed08a"));
  if (good.status !== "available" && (immediate || good.status !== "scheduled" || !natural(good.opensAt))) {
    conflict($t("lib.miyoushe-shop-plans.text_efba80c86d"));
  }
  if (!natural(balance) || balance < good.price) conflict($t("lib.miyoushe-shop-plans.text_b2a19a448e"));
  return { ...good, type: good.type as 1 | 2 };
}

function communityAccountGood(good: TrackingGood) {
  return good.type === 2 && good.game === "bbs" && good.gameBiz === "bbs_cn";
}

function inspectionHasDestination(plan: MiyousheShopPlan, snapshot: MiyousheShopInspection) {
  if (communityAccountGood(snapshot.good)) return plan.type === 2 && plan.role === null && plan.addressId === "";
  return plan.type === 2
    ? !!plan.role && !plan.addressId && !!snapshot.roles?.some(role => role.uid === plan.role?.uid && role.region === plan.role.region)
    : !plan.role && !!snapshot.addresses?.some(address => address.id === plan.addressId);
}

function conflictsWithCycle(plan: MiyousheShopPlan, cycleKey: string | undefined) {
  if (plan.status !== "succeeded") return false;
  if (!plan.cycleKey || plan.cycleKey === cycleKey) return true;
  // An older engine keyed some rules on the account's limit alone. Different
  // period types cannot establish that its successful order is in a past period.
  return !plan.bindingStamp && plan.cycleKey.split(":")[1] !== cycleKey?.split(":")[1];
}

function trackedStock(good: TrackingGood, opensAt: number, now: number) {
  if (good.status === "available" || good.status === "ended") return false;
  const zeroStock = good.status === "sold_out" || (good.stock === 0 && !good.unlimited);
  if (zeroStock) return (good.serverNow ?? now) < opensAt ? "wait" : "sold-out";
  return good.status === "unknown" && "wait";
}

function owned(data: Store, target: MiyousheOverviewTarget, id: string) {
  const plan = planId.test(id) && data.plans.find(item => item.id === id && item.qq === target.qq && item.profileId === target.profileId);
  if (!plan) throw new MiyousheShopPlanError(404, $t("lib.miyoushe-shop-plans.text_815b886014"));
  return plan;
}

export function createMiyousheShopPlans({
  file, legacyFiles = [], profileDirectory, now = Date.now, inspect, submit, manualRelay, receiptRoute, tracking,
}: Options) {
  const store = createStore(resolvePath(file), legacyFiles);
  const profiles = createProfileStore(profileDirectory);
  const immediateVerification = new Map<string, ImmediateVerification>();
  type Verify = () => Promise<void>;

  async function binding(target: MiyousheOverviewTarget) {
    const { account, device, revision } = await profiles.accountContext(target.qq, target.profileId);
    const { stuid, ltuid } = account;
    const accountId = stuid || ltuid;
    if (!matching(accountId, numericId) || (stuid && ltuid && stuid !== ltuid) || !device.id || !device.fp) {
      conflict($t("lib.miyoushe-shop-plans.text_ce67fba632"));
    }
    const login = await profiles.loginIdentity(target.qq, target.profileId);
    if (revision !== (await profiles.accountContext(target.qq, target.profileId)).revision) conflict(details.changed);
    return { accountId, stamp: createHash("sha256").update(JSON.stringify([login, device.id, device.fp])).digest("hex") };
  }

  async function verifyCurrent(target: MiyousheOverviewTarget, expected: Awaited<ReturnType<typeof binding>>) {
    const current = await binding(target);
    if (current.accountId !== expected.accountId || current.stamp !== expected.stamp) {
      conflict(details.changed);
    }
  }

  function finish(plan: MiyousheShopPlan, status: Status, message = statusMessage[status]) {
    Object.assign(plan, { status, message, finishedAt: now() });
    if (status !== "cancelled" && parseMiyousheShopReceiptRoute(plan.receiptRoute)) plan.receipt = "pending";
  }

  function pendingReceipt(plan: MiyousheShopPlan) {
    return plan.receipt === "pending" && (plan.status === "succeeded" || plan.status === "failed" ||
      plan.status === "missed" || plan.status === "unknown") && natural(plan.finishedAt) &&
      now() - plan.finishedAt < receiptLifetime;
  }

  async function ownsReceiptAccount(plan: MiyousheShopPlan) {
    const profile = await profiles.accountContext(plan.qq, plan.profileId).catch(() => undefined);
    return !!profile && profileCookieAccountId(profile.account) === plan.accountId;
  }

  let deliveringReceipts: Promise<void> | undefined;
  function deliverReceipts(signal?: AbortSignal) {
    if (!receiptRoute || signal?.aborted) return;
    return deliveringReceipts ??= (async () => {
      for (const candidate of (await store.read()).plans.filter(pendingReceipt)) {
        if (signal?.aborted) return;
        const route = parseMiyousheShopReceiptRoute(candidate.receiptRoute);
        if (!route || !await ownsReceiptAccount(candidate)) continue;
        const send = await receiptRoute(candidate.qq, route, signal).catch(() => undefined);
        if (!send || signal?.aborted) continue;
        const claimed = await store.change(async data => {
          const plan = data.plans.find(item => item.id === candidate.id);
          if (!plan || !pendingReceipt(plan) || plan.status !== candidate.status || plan.finishedAt !== candidate.finishedAt ||
              !await ownsReceiptAccount(plan) || signal?.aborted) return;
          // After this durable claim a crash or uncertain delivery must never send a duplicate.
          plan.receipt = "claimed";
          return plan;
        });
        if (!claimed || signal?.aborted || !await ownsReceiptAccount(claimed) || signal?.aborted) continue;
        const { goodsName, profileId, id, message } = publicPlan(claimed);
        await send($t("lib.miyoushe-shop-plans.text_670d287a55", { "goodsName": goodsName, "profileId": profileId, "id": id, "message": message })).catch(() => undefined);
      }
    })().finally(() => { deliveringReceipts = undefined; });
  }

  async function update(id: string, expected: Status, edit: (plan: MiyousheShopPlan, data: Store) => void) {
    return store.change(data => {
      const plan = data.plans.find(item => item.id === id && item.status === expected);
      if (!plan) return;
      edit(plan, data);
      return plan;
    });
  }

  function findTracker(data: Store, id: string) {
    return (data.trackers ?? []).find(value => asTrackerRecord(value)?.id === id);
  }

  function trackerIsCurrent(data: Store, plan: MiyousheShopPlan) {
    if (!plan.trackingId) return true;
    const rule = trackingRule(findTracker(data, plan.trackingId));
    return confirmedTracker(rule) && rule.enabled && rule.accountId === plan.accountId &&
      rule.qq === plan.qq && rule.profileId === plan.profileId && rule.confirmation.bindingStamp === plan.bindingStamp &&
      !data.plans.some(item => item.accountId === plan.accountId && (item.status === "unknown" ||
        (item.id !== plan.id && item.goodsId === plan.goodsId && conflictsWithCycle(item, plan.cycleKey))));
  }

  function pauseTracks(data: Store, accountId: string, message: string, id?: string) {
    for (const value of data.trackers ?? []) {
      const rule = asTrackerRecord(value);
      if (!rule || rule.accountId !== accountId || (id && rule.id !== id) || rule.enabled === false || !trackingRule(rule)) continue;
      rule.enabled = false;
      rule.message = message;
    }
    for (const plan of data.plans) {
      if (plan.accountId === accountId && plan.trackingId && (!id || plan.trackingId === id) &&
          (plan.status === "scheduled" || plan.status === "preparing")) finish(plan, "cancelled");
    }
  }

  async function recoverAccount(accountId: string) {
    await store.change(data => {
      const uncertain = new Set<string>();
      let accountUncertain = false;
      for (const plan of data.plans) {
        if (plan.accountId !== accountId) continue;
        if (plan.status === "submitting") finish(plan, "unknown");
        if (plan.status === "preparing") Object.assign(plan, { status: "scheduled", message: statusMessage.scheduled });
        if (plan.status === "unknown") {
          accountUncertain = true;
          if (plan.trackingId) uncertain.add(plan.trackingId);
        }
      }
      for (const value of data.trackers ?? []) {
        const rule = asRecord(value);
        if (typeof rule?.id === "string" && uncertain.has(rule.id) && rule.enabled !== false) {
          rule.enabled = false;
          rule.message = trackerMessages.unknown;
        }
      }
      if (accountUncertain) pauseTracks(data, accountId, trackerMessages.unknown);
    });
  }

  function trackerUsage(data: Store, id: string) {
    let spent = 0, held = 0, successes = 0;
      for (const plan of data.plans) {
      if (plan.trackingId !== id) continue;
      if (plan.status === "succeeded") { spent += plan.price; successes++; }
      else if (active(plan.status) || plan.status === "unknown") held += plan.price;
    }
    return { spent, held, successes };
  }

  function publicTracker(rule: ShopTracker, data: Store) {
    const { id, profileId, mode, game, itemType, goodsIds, names, keywords, followSameName, maxPrice, spendLimit,
      pollMs, leadMs, intervalMs } = rule;
    const confirmed = confirmedTracker(rule);
    return { id, profileId, mode, game, itemType, goodsIds, names, keywords, followSameName, maxPrice, spendLimit,
      pollMs, leadMs, intervalMs, nextOpenAt: natural(rule.nextOpenAt) ? rule.nextOpenAt : undefined,
      nextPollAt: natural(rule.nextPollAt) ? rule.nextPollAt : undefined,
      lastPolledAt: natural(rule.lastPolledAt) ? rule.lastPolledAt : undefined,
      matchedCount: natural(rule.matchedCount) ? rule.matchedCount : undefined, enabled: confirmed && rule.enabled,
      needsConfirmation: !confirmed, role: rule.role && { uid: rule.role.uid, region: rule.role.region,
        regionName: miyousheShopRegionName(rule.role.gameBiz, rule.role.region) },
      addressLabel: addressLabel(rule.addressLabel), ...trackerUsage(data, rule.id),
      message: !confirmed ? $t("lib.miyoushe-shop-plans.text_dd4575a47d") :
        publicTrackerMessages.has(rule.message) ? rule.message : (rule.enabled ? trackerMessages.watching : trackerMessages.pause) };
  }

  function ownsTracker(data: Store, target: MiyousheOverviewTarget, id: string) {
    const raw = asTrackerRecord(findTracker(data, id));
    if (!raw || raw.qq !== target.qq || raw.profileId !== target.profileId) {
      throw new MiyousheShopPlanError(404, $t("lib.miyoushe-shop-plans.text_ebf3089f2d"));
    }
    const rule = trackingRule(raw);
    if (!rule) conflict($t("lib.miyoushe-shop-plans.text_5efc7b1ce3"));
    return { raw, rule };
  }

  async function verifyRole(target: MiyousheOverviewTarget, rule: Pick<ShopTracker, "game" | "role">) {
    if (!rule.role) return;
    if (!trackingGame(rule.game)) conflict($t("lib.miyoushe-shop-plans.text_e52ba3da2e"));
    const selected = await profiles.selectedShopRoleUid(target.qq, target.profileId, trackingProfileGames[rule.game]);
    if (selected !== rule.role.uid) conflict(details.trackerRoleChanged);
  }

  async function verifyTrackerTarget(target: MiyousheOverviewTarget, rule: Pick<ShopTracker, "game" | "itemType" | "role" | "addressId">,
    signal?: AbortSignal, verify?: Verify) {
    const destinations = await tracking!.destinations(target, rule.game, rule.itemType, signal, verify);
    if (rule.itemType === 2 ? !destinations.roles?.some(role => role.uid === rule.role?.uid && role.region === rule.role.region &&
        role.gameBiz === rule.role.gameBiz) : !destinations.addresses?.some(address => address.id === rule.addressId)) {
      conflict($t("lib.miyoushe-shop-plans.text_ceed3cab98"));
    }
    await verifyRole(target, rule);
  }

  async function reachedAccountQuota(target: MiyousheOverviewTarget, good: TrackingGood, signal?: AbortSignal, verify?: Verify) {
    if (!good.accountLimit || !good.limitCycle || good.limitCycle === "not_limit") return false;
    const quota = await tracking?.accountQuota?.(target, good, signal, verify);
    return quota !== undefined && quota.limit === good.accountLimit && quota.used >= quota.limit;
  }

  async function pollRule(rule: ShopTracker & { confirmation: { bindingStamp: string; at: number } }, signal?: AbortSignal) {
    const target = { qq: rule.qq, profileId: rule.profileId };
    const pollRunId = randomUUID();
    const ownsCurrent = (data: Store) => {
      const raw = asTrackerRecord(findTracker(data, rule.id));
      const current = trackingRule(raw);
      if (raw && confirmedTracker(current) && current.enabled && current.confirmation.at === rule.confirmation.at &&
        current.confirmation.bindingStamp === rule.confirmation.bindingStamp) return raw;
    };
    const pendingReservation = (data: Store) => data.plans.some(plan => plan.accountId === rule.accountId && !plan.trackingId &&
      active(plan.status) && plan.opensAt <= now() + preparingLead);
    const started = await store.change(data => {
      const current = ownsCurrent(data);
      if (!current || (natural(current.nextPollAt) && current.nextPollAt > now()) || pendingReservation(data)) return false;
      if (data.plans.some(plan => plan.accountId === rule.accountId && plan.status === "unknown")) {
        pauseTracks(data, rule.accountId, trackerMessages.unknown);
        return false;
      }
      Object.assign(current, { pollRunId, lastPolledAt: now(), nextPollAt: now() + rule.pollMs, matchedCount: 0, nextOpenAt: null });
      return true;
    });
    if (!started) return;
    const currentPoll = (data: Store) => {
      const current = ownsCurrent(data);
      return current?.pollRunId === pollRunId ? current : undefined;
    };
    let phase: "binding" | "catalog" = "binding";
    try {
      const booked = await binding(target);
      if (booked.accountId !== rule.accountId || booked.stamp !== rule.confirmation.bindingStamp) conflict(details.changed);
      await verifyRole(target, rule);
      phase = "catalog";
      const verifyBinding = async () => {
        signal?.throwIfAborted();
        await verifyCurrent(target, booked);
        signal?.throwIfAborted();
      };
      const goods = (await tracking!.catalog(target, rule.game, signal, verifyBinding))
        .filter(good => matchesTrackingGood(rule, good));
      let nearest: number | undefined;
      let nextWake: number | undefined;
      let quotaReached = false;
      function watchOpening(opensAt: number | null, limitReached = false) {
        if (opensAt === null || opensAt <= now()) return;
        nearest = Math.min(nearest ?? opensAt, opensAt);
        const wake = limitReached ? opensAt + 1000 : Math.max(now() + 1000, opensAt - Math.max(preparingLead, rule.leadMs));
        nextWake = Math.min(nextWake ?? wake, wake);
      }

      for (const candidate of goods) {
        signal?.throwIfAborted();
        if (candidate.status !== "available" && candidate.status !== "scheduled") continue;
        const opening = candidate.status === "scheduled" ? candidate.opensAt : null;
        if (opening !== null && opening > now() + Math.max(preparingLead, rule.leadMs + 10_000)) {
          watchOpening(opening);
          continue;
        }
        const snapshot = await inspect(target, candidate.id, signal, verifyBinding);
        const { good, balance } = snapshot;
        if (good.id !== candidate.id || !matchesTrackingGood(rule, good) || !natural(good.price) || !natural(balance) || balance < good.price ||
          (good.status !== "available" && (good.status !== "scheduled" || !natural(good.opensAt))) ||
          (rule.role ? !snapshot.roles?.some(role => role.uid === rule.role?.uid && role.region === rule.role.region)
            : !snapshot.addresses?.some(address => address.id === rule.addressId))) {
          watchOpening(opening);
          continue;
        }
        const full = await reachedAccountQuota(target, good, signal, verifyBinding);
        watchOpening(good.status === "scheduled" ? good.opensAt : opening, full);
        if (full) {
          quotaReached = true;
          continue;
        }
        const cycleKey = trackingCycle(good, now());
        if (!cycleKey) continue;
        const created = await store.change(async data => {
          const current = currentPoll(data);
          if (!current) return false;
          if (pendingReservation(data)) {
            current.nextPollAt = Math.min(now() + 1000, Number(current.nextPollAt));
            return false;
          }
          const { spent, held } = trackerUsage(data, rule.id);
          if ((rule.spendLimit !== null && spent + held + good.price > rule.spendLimit) ||
              data.plans.some(item => item.accountId === rule.accountId && (item.status === "unknown" ||
                (item.goodsId === good.id && (active(item.status) || conflictsWithCycle(item, cycleKey)))))) return false;
          const previous = data.plans.find(item => item.trackingId === rule.id && item.goodsId === good.id &&
            item.status === "cancelled" && item.cycleKey === cycleKey);
          if (previous) return false;
          await verifyBinding();
          await verifyRole(target, rule);
          const createdAt = now();
          const opensAt = good.status === "available" ? createdAt : good.opensAt!;
          if (opensAt < createdAt) return false;
          let id: string;
          do { id = randomUUID().replaceAll("-", "").slice(0, 12); } while (data.plans.some(item => item.id === id));
          const route = parseMiyousheShopReceiptRoute(rule.receiptRoute);
          data.plans.push({ id, ...target, accountId: rule.accountId, botId: route ? String(route.botId) : "", bindingStamp: booked.stamp,
            ...(route && { receiptRoute: rule.receiptRoute }),
            trackingId: rule.id, cycleKey, preStartMs: rule.leadMs, retryIntervalMs: rule.intervalMs,
            goodsId: good.id, goodsName: clean(good.name, 240), gameBiz: good.gameBiz,
            type: rule.itemType, price: good.price, role: rule.role, addressId: rule.addressId || "",
            addressLabel: addressLabel(rule.addressLabel), immediate: false, createdAt, opensAt, status: "scheduled",
            message: statusMessage.scheduled, attempts: 0 });
          current.message = trackerMessages.booked;
          current.matchedCount = goods.length;
          return true;
        });
        if (created) return;
      }
      await store.change(data => {
        const current = currentPoll(data);
        if (!current) return;
        current.matchedCount = goods.length;
        current.message = quotaReached ? trackerMessages.accountQuota : trackerMessages.watching;
        if (nearest !== undefined && nextWake !== undefined) {
          current.nextOpenAt = nearest;
          current.nextPollAt = Math.min(now() + rule.pollMs, Math.max(now() + 1000, nextWake));
        }
      });
    } catch (error) {
      if (signal?.aborted) return;
      await store.change(data => {
        const current = currentPoll(data);
        if (!current) return;
        const reason = asRecord(error)?.reason;
        if (reason === "verification" || reason === "rate-limited" || asRecord(error)?.status === 429) {
          pauseTracks(data, rule.accountId, reason === "verification" ? details.verification : details["rate-limited"]);
        } else if (phase === "binding" || trackerBindingChanged(error)) {
          pauseTracks(data, rule.accountId, trackerMessages.changed, rule.id);
        } else {
          current.message = trackerMessages.retry;
        }
      });
    }
  }

  let polling: Promise<void> | undefined;
  function poll(signal?: AbortSignal) {
    return polling ??= (async () => {
      if (!tracking || !submit || signal?.aborted) return;
      for (const row of (await store.read()).trackers ?? []) {
        if (signal?.aborted) return;
        const rule = trackingRule(row);
        if (confirmedTracker(rule) && rule.enabled && !(natural(rule.nextPollAt) && rule.nextPollAt > now())) await pollRule(rule, signal);
      }
    })().finally(() => { polling = undefined; });
  }

  async function recover(match: (plan: MiyousheShopPlan) => boolean) {
    const { plans } = await store.read();
    const accounts = new Set(plans.filter(plan => match(plan) && (plan.status === "submitting" ||
      plan.status === "preparing" || (plan.status === "unknown" && plan.trackingId))).map(plan => plan.accountId));
    await Promise.all([...accounts].map(accountId => store.withAccount(accountId, () => recoverAccount(accountId))));
  }

  async function run(plan: MiyousheShopPlan, signal?: AbortSignal) {
    if (!submit || signal?.aborted || (plan.trackingId && (!tracking || !plan.bindingStamp))) return;
    const target = { qq: plan.qq, profileId: plan.profileId };
    await store.withAccount(plan.accountId, async () => {
      const claimed = await update(plan.id, "scheduled", (current, data) => {
        if (!trackerIsCurrent(data, current)) finish(current, "cancelled");
        else if (data.plans.some(other => other.accountId === current.accountId && other.goodsId === current.goodsId &&
            (other.status === "unknown" || other.status === "submitting"))) finish(current, "cancelled", details.pending);
        else Object.assign(current, { status: "preparing", message: statusMessage.preparing });
      });
      const immediate = immediateVerification.get(plan.id);
      if (claimed?.status !== "preparing") {
        immediate?.cancel.abort();
        immediateVerification.delete(plan.id);
        return;
      }
      const activeSignal = immediate ? AbortSignal.any([immediate.session.signal, immediate.cancel.signal, ...(signal ? [signal] : [])]) : signal;
      let started = false;
      let submitting = false;
      let message: string = details.unavailable;
      let resumeDeadline: number | undefined;
      let saleClose = Infinity;
      let firstSaleClose = Infinity;
      const firstDispatchAllowed = () => {
        const time = now();
        return time <= plan.opensAt + maxDelay && time < firstSaleClose;
      };
      try {
        signal?.throwIfAborted();
        if (plan.manualSessionExpected && (!immediate || activeSignal?.aborted)) {
          await update(plan.id, "preparing", current => finish(current, "cancelled", details.sessionEnded));
          return;
        }
        if (now() > plan.opensAt + maxDelay) {
          await update(plan.id, "preparing", current => finish(current, "missed"));
          return;
        }
        message = details.changed;
        const booked = await binding(target);
        if (!plan.bindingStamp) {
          await update(plan.id, "preparing", current => finish(current, "failed", details.legacy));
          return;
        }
        if (booked.accountId !== plan.accountId || booked.stamp !== plan.bindingStamp) conflict(details.changed);
        const verifyBinding = async () => {
          activeSignal?.throwIfAborted();
          if (!immediate && now() >= Math.min(plan.opensAt + maxDelay, saleClose)) conflict(details.verification);
          if (resumeDeadline !== undefined && now() >= resumeDeadline) conflict(details.verification);
          if (immediate && activeSignal) await immediate.session.verify(activeSignal);
          await verifyCurrent(target, booked);
          if (plan.trackingId) {
            const data = await store.read();
            if (!trackerIsCurrent(data, plan)) conflict($t("lib.miyoushe-shop-plans.text_02050baad6"));
            await verifyRole(target, trackingRule(findTracker(data, plan.trackingId))!);
          }
          activeSignal?.throwIfAborted();
          if (resumeDeadline !== undefined && now() >= resumeDeadline) conflict(details.verification);
        };
        const inspectCurrent = async () => {
          message = details.unavailable;
          const inspectedAt = now();
          const snapshot = await inspect(target, plan.goodsId, activeSignal, verifyBinding);
          saleClose = localSaleEnd(snapshot.good, now());
          firstSaleClose = localSaleEnd(snapshot.good, inspectedAt);
          message = details.conditions;
          const trackingStatus = plan.trackingId && (snapshot.good.status === "unknown" || snapshot.good.status === "sold_out");
          const good = trackingStatus ? snapshot.good : validateInspection(snapshot, plan.goodsId, plan.immediate);
          if (good.price !== plan.price || good.type !== plan.type || good.gameBiz !== plan.gameBiz ||
            (plan.trackingId && (good.id !== plan.goodsId || !natural(snapshot.balance) || snapshot.balance < plan.price ||
              (!trackingStatus && trackingCycle(good, now()) !== plan.cycleKey))) ||
            !inspectionHasDestination(plan, snapshot)) conflict(details.conditions);
          message = details.changed;
          await verifyBinding();
          return good;
        };
        let good = await inspectCurrent();
        if (good.status === "scheduled" && good.opensAt !== null && Math.abs(good.opensAt - plan.opensAt) > 1000 &&
            good.opensAt > now()) {
          await update(plan.id, "preparing", current => {
            Object.assign(current, { status: "scheduled", opensAt: good.opensAt, message: details.updated });
          });
          return;
        }
        if (now() < plan.opensAt) {
          await delay(plan.opensAt - now(), undefined, { signal, ref: false });
          if (!(await store.read()).plans.some(item => item.id === plan.id && item.status === "preparing")) return;
          good = await inspectCurrent();
          if (good.status === "scheduled" && good.opensAt !== null && good.opensAt > now()) {
            await update(plan.id, "preparing", current => {
              Object.assign(current, { status: "scheduled", opensAt: good.opensAt, message: details.updated });
            });
            return;
          }
        }
        while (plan.trackingId && trackedStock(good, plan.opensAt, now()) === "wait" && now() < plan.opensAt + maxDelay) {
          const interval = natural(plan.retryIntervalMs) ? Math.max(250, Math.min(5000, plan.retryIntervalMs)) : 500;
          await delay(Math.min(interval, plan.opensAt + maxDelay - now()), undefined, { signal, ref: false });
          if (!(await store.read()).plans.some(item => item.id === plan.id && item.status === "preparing")) return;
          good = await inspectCurrent();
        }
        if (plan.trackingId && trackedStock(good, plan.opensAt, now()) === "sold-out") {
          await update(plan.id, "preparing", current => finish(current, "failed", details.stockEmpty));
          return;
        }
        if (good.status !== "available" || !firstDispatchAllowed()) {
          await update(plan.id, "preparing", current => finish(current, "missed"));
          return;
        }
        if (plan.trackingId && await reachedAccountQuota(target, good, activeSignal, verifyBinding)) {
          await update(plan.id, "preparing", current => finish(current, "failed", details.accountQuota));
          return;
        }
        const purchaseCycle = immediate ? trackingCycle(good, now()) : undefined;
        const manual: ShopManualVerification | undefined = activeSignal ? {
          allowManual: Boolean(immediate),
          async waitForProof(challenge, requestSignal) {
            const relay = manualRelay?.();
            if (!immediate || !relay || now() > plan.opensAt + maxDelay) return;
            const time = now();
            const deadline = Math.min(resumeDeadline ?? time + manualVerificationTimeout, saleClose);
            if (deadline <= time) return;
            const scope = AbortSignal.any([requestSignal, AbortSignal.timeout(deadline - time)]);
            const registration = await relay.register(challenge, scope);
            if (!registration) return;
            const expiresAt = Math.min(deadline, registration.expiresAt);
            resumeDeadline = expiresAt;
            immediate.ticket = { link: registration.link, expiresAt };
            try {
              while (now() < expiresAt && !scope.aborted) {
                await verifyBinding();
                const read = await relay.readResult(registration.ticket);
                if (read.status === "complete" && "captchaId" in read.result && now() < expiresAt) return read.result;
                if (read.status !== "pending") return;
                await delay(500, undefined, { signal: scope, ref: false });
              }
            } finally {
              immediate.ticket = undefined;
            }
          },
          async prepareResume() {
            const updated = await inspectCurrent();
            if (updated.status !== "available" ||
                (purchaseCycle !== undefined && trackingCycle(updated, now()) !== purchaseCycle)) conflict(details.conditions);
            const time = now();
            resumeDeadline = Math.min(resumeDeadline ?? plan.opensAt + maxDelay, saleClose);
            if (time >= resumeDeadline) conflict(details.verification);
            const marked = await update(plan.id, "submitting", current => { current.attempts++; });
            if (!marked) conflict(details.conditions);
          },
        } : undefined;
        const submitted = await update(plan.id, "preparing", (current, data) => {
          if (!trackerIsCurrent(data, current)) finish(current, "cancelled");
          else if (!firstDispatchAllowed()) finish(current, "missed");
          else Object.assign(current, { status: "submitting", message: statusMessage.submitting, attempts: current.attempts + 1 });
        });
        if (submitted?.status !== "submitting") return;
        submitting = true;
        await verifyBinding();
        let result: MiyousheShopExchangeResult = "missed";
        if (firstDispatchAllowed()) {
          started = true;
          result = await withCaptchaInteraction(() => Boolean(immediate && !activeSignal?.aborted),
            () => submit(Object.freeze(submitted), activeSignal, verifyBinding, manual, firstDispatchAllowed));
        }
        await update(plan.id, "submitting", (current, data) => {
          if (result === "missed") {
            current.attempts--;
            finish(current, "missed");
            return;
          }
          if (result === "verification" || result === "rate-limited") finish(current, "failed", details[result]);
          else finish(current, result === "succeeded" || result === "failed" ? result : "unknown");
          if (current.status === "unknown" || result === "verification" || result === "rate-limited") {
            pauseTracks(data, current.accountId, current.message);
          }
        });
      } catch (error) {
        await update(plan.id, submitting ? "submitting" : "preparing", (current, data) => {
          if (started) {
            finish(current, "unknown");
            pauseTracks(data, current.accountId, current.message);
          }
          else if (plan.manualSessionExpected && activeSignal?.aborted) finish(current, "cancelled", details.sessionEnded);
          else if (signal?.aborted) {
            Object.assign(current, { status: "scheduled", message: statusMessage.scheduled });
          } else if (error instanceof MiyousheExchangeError && (error.reason === "verification" || error.reason === "rate-limited")) {
            finish(current, "failed", details[error.reason]);
            pauseTracks(data, current.accountId, current.message);
          } else if (current.trackingId && trackerBindingChanged(error)) {
            finish(current, "failed", error.message);
            if (trackerIsCurrent(data, current)) pauseTracks(data, current.accountId, trackerMessages.changed, current.trackingId);
          } else finish(current, "failed", message);
        });
      } finally {
        immediate?.cancel.abort();
        immediateVerification.delete(plan.id);
      }
    });
  }

  let selecting: Promise<Promise<void>[]> | undefined;
  const running = new Map<string, Promise<void>>();
  function select(signal?: AbortSignal) {
    return selecting ??= (async () => {
      await recover(() => true);
      if (!submit || signal?.aborted) return [];
      for (const plan of (await store.read()).plans.sort((a, b) => a.opensAt - b.opensAt)) {
        if (plan.status === "scheduled" && (!plan.trackingId || (tracking && plan.bindingStamp)) &&
            (!plan.manualSessionExpected || immediateVerification.has(plan.id) || now() > plan.opensAt + maxDelay) &&
            plan.opensAt <= now() + (plan.trackingId && natural(plan.preStartMs) ? Math.max(preparingLead, Math.min(30_000, plan.preStartMs)) : preparingLead) &&
            !running.has(plan.accountId)) {
          const job = run(plan, signal).finally(() => { running.delete(plan.accountId); });
          running.set(plan.accountId, job);
        }
      }
      return [...running.values()];
    })().finally(() => { selecting = undefined; });
  }

  async function scan(signal?: AbortSignal) {
    const initial = select(signal).then(jobs => Promise.allSettled(jobs));
    const following = poll(signal).then(() => select(signal)).then(jobs => Promise.allSettled(jobs));
    const results = (await Promise.all([initial, following])).flat();
    await deliverReceipts(signal);
    const failed = results.find(result => result.status === "rejected");
    if (failed) throw failed.reason;
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    start(signal: AbortSignal, onError?: (error: unknown) => void) {
      if (timer || signal.aborted) return;
      const seen = new WeakSet<Promise<void>>();
      let nextReceiptPoll = 0;
      const tick = () => {
        if (!polling) void poll(signal).catch(error => onError?.(error));
        if (receiptRoute && !deliveringReceipts && now() >= nextReceiptPoll) {
          nextReceiptPoll = now() + receiptPollInterval;
          void deliverReceipts(signal)?.catch(error => onError?.(error));
        }
        void select(signal).then(jobs => {
          for (const job of jobs) if (!seen.has(job)) {
            seen.add(job);
            void job.catch(error => onError?.(error));
          }
        }).catch(error => onError?.(error));
      };
      if (submit || receiptRoute) {
        timer = setInterval(tick, 1_000);
        timer.unref();
        signal.addEventListener("abort", () => { clearInterval(timer); timer = undefined; }, { once: true });
      }
      tick();
    },
    scan,
    async trackerTargets(target: MiyousheOverviewTarget, game: unknown, itemType: unknown, signal?: AbortSignal, verifyLogin?: Verify) {
      if (!tracking) throw new MiyousheShopPlanError(503, $t("lib.miyoushe-shop-plans.text_af95a03d02"));
      if (!trackingSection(game) || (itemType !== 1 && itemType !== 2) || (itemType === 2 && !trackingGame(game)) || game === "all") {
        bad($t("lib.miyoushe-shop-plans.text_6df92e0a38"));
      }
      await verifyLogin?.();
      const result = await tracking.destinations(target, game, itemType, signal, verifyLogin);
      await verifyLogin?.();
      if (itemType === 1) return { type: "address" as const,
        items: (result.addresses ?? []).filter(item => matching(item.id, numericId)).map(item => ({ id: item.id, label: addressLabel(item.label) })) };
      if (!trackingGame(game)) bad($t("lib.miyoushe-shop-plans.text_d49364119f"));
      const selected = await profiles.selectedShopRoleUid(target.qq, target.profileId, trackingProfileGames[game]);
      return { type: "role" as const, items: (result.roles ?? []).filter(role => role.gameBiz === trackingGames[game] &&
        role.uid === selected && matching(role.region, code)).map(role => ({ uid: role.uid, region: role.region,
        regionName: miyousheShopRegionName(role.gameBiz, role.region, role.regionName) })) };
    },
    async listTrackers(target: MiyousheOverviewTarget, verifyLogin?: Verify) {
      await verifyLogin?.();
      const belongs = (item: MiyousheOverviewTarget) => item.qq === target.qq && item.profileId === target.profileId;
      await recover(belongs);
      const data = await store.read();
      await verifyLogin?.();
      const trackers = (data.trackers ?? []).map(row => {
        const raw = asTrackerRecord(row);
        if (!raw || raw.qq !== target.qq || raw.profileId !== target.profileId || !matching(raw.id, planId)) return;
        const rule = trackingRule(row);
        const createdAt = natural(raw.createdAt) ? raw.createdAt : 0;
        if (rule) return { ...publicTracker(rule, data), createdAt, migrationBlocked: false };
        return { id: raw.id, profileId: target.profileId, createdAt, migrationBlocked: true, enabled: false,
          needsConfirmation: true, game: trackingSection(raw.game) ? raw.game : "",
          itemType: raw.itemType === 1 || raw.itemType === 2 ? raw.itemType : null, ...trackerUsage(data, raw.id),
          message: $t("lib.miyoushe-shop-plans.text_5efc7b1ce3") };
      }).filter(row => row !== undefined).sort((a, b) => b.createdAt - a.createdAt);
      return { now: now(), canTrack: Boolean(tracking && submit), trackers };
    },
    async createTracker(target: MiyousheOverviewTarget, value: unknown, signal?: AbortSignal, verifyLogin?: Verify, origin?: string) {
      if (!tracking || !submit) throw new MiyousheShopPlanError(503, $t("lib.miyoushe-shop-plans.text_af95a03d02"));
      const input = readTrackingInput(value);
      if (!input) bad($t("lib.miyoushe-shop-plans.text_69d3c22154"));
      await verifyLogin?.();
      const booked = await binding(target);
      const verify = async () => {
        signal?.throwIfAborted();
        await verifyLogin?.();
        await verifyCurrent(target, booked);
      };
      const destinations = await tracking.destinations(target, input.game, input.itemType, signal, verify);
      const profileGame = input.itemType === 2 && trackingGame(input.game) ? input.game : undefined;
      const selected = profileGame && await profiles.selectedShopRoleUid(target.qq, target.profileId, trackingProfileGames[profileGame]);
      const role = profileGame && destinations.roles?.find(role => role.uid === selected && role.gameBiz === trackingGames[profileGame] &&
        matching(role.region, code));
      const address = destinations.addresses?.find(address => address.id === input.addressId);
      if (input.itemType === 2 ? !role : !address) bad($t("lib.miyoushe-shop-plans.text_38f45acc8f"));
      const names: string[] = [];
      for (const goodsId of input.goodsIds) {
        const { good } = await inspect(target, goodsId, signal, verify);
        if (good.id !== goodsId || !matchesTrackingGood({ ...input, names: [] }, good)) bad($t("lib.miyoushe-shop-plans.text_13ea7eb73f"));
        names.push(clean(good.name, 240));
      }
      return store.change(async data => {
        await verify();
        if (data.plans.some(plan => plan.accountId === booked.accountId && plan.status === "unknown")) {
          conflict($t("lib.miyoushe-shop-plans.text_23e808d8da"));
        }
        const rows = data.trackers ??= [];
        let id: string;
        do { id = randomUUID().replaceAll("-", "").slice(0, 12); } while (findTracker(data, id));
        const rule: ShopTracker = { ...input, ...target, id, accountId: booked.accountId, names,
          ...(parseMiyousheShopReceiptRoute(origin) && { receiptRoute: origin }),
          role: role ? { uid: role.uid, region: role.region, gameBiz: role.gameBiz } : null,
          gameBiz: role?.gameBiz ?? "", addressId: address?.id ?? "", addressLabel: addressLabel(address?.label),
          enabled: true, createdAt: now(), confirmation: { bindingStamp: booked.stamp, at: now() },
          message: $t("lib.miyoushe-shop-plans.text_e1cadb0b59") };
        await verifyRole(target, rule);
        const exists = rows.map(trackingRule).some(item => item && item.qq === rule.qq && item.profileId === rule.profileId &&
          item.accountId === rule.accountId && item.mode === rule.mode && item.game === rule.game && item.itemType === rule.itemType &&
          JSON.stringify([...item.goodsIds].sort()) === JSON.stringify([...rule.goodsIds].sort()) &&
          JSON.stringify([...item.keywords].sort()) === JSON.stringify([...rule.keywords].sort()) &&
          item.addressId === rule.addressId && item.role?.uid === rule.role?.uid && item.maxPrice === rule.maxPrice &&
          item.spendLimit === rule.spendLimit && item.followSameName === rule.followSameName);
        if (exists) conflict($t("lib.miyoushe-shop-plans.text_797658d8ba"));
        rows.push(rule);
        return publicTracker(rule, data);
      });
    },
    async setTracker(target: MiyousheOverviewTarget, id: string, enabled: boolean, confirmed: unknown, signal?: AbortSignal, verifyLogin?: Verify) {
      await verifyLogin?.();
      if (!enabled) return store.change(async data => {
        await verifyLogin?.();
        const { raw, rule } = ownsTracker(data, target, id);
        pauseTracks(data, rule.accountId, $t("lib.miyoushe-shop-plans.text_4260e08276"), rule.id);
        return publicTracker(trackingRule(raw)!, data);
      });
      if (!tracking || !submit) throw new MiyousheShopPlanError(503, $t("lib.miyoushe-shop-plans.text_af95a03d02"));
      if (confirmed !== true) bad($t("lib.miyoushe-shop-plans.text_b3db3f8f0f"));
      const { rule } = ownsTracker(await store.read(), target, id);
      const booked = await binding(target);
      if (booked.accountId !== rule.accountId || (confirmedTracker(rule) && booked.stamp !== rule.confirmation.bindingStamp)) {
        conflict($t("lib.miyoushe-shop-plans.text_220c4e6513"));
      }
      const verify = async () => {
        signal?.throwIfAborted();
        await verifyLogin?.();
        await verifyCurrent(target, booked);
      };
      await verifyTrackerTarget(target, rule, signal, verify);
      return store.change(async data => {
        await verify();
        if (data.plans.some(plan => plan.accountId === booked.accountId &&
            (plan.status === "unknown" || plan.status === "submitting"))) conflict($t("lib.miyoushe-shop-plans.text_23e808d8da"));
        const { raw, rule: current } = ownsTracker(data, target, id);
        if (raw.enabled && confirmedTracker(current)) return publicTracker(current, data);
        Object.assign(raw, { enabled: true, confirmation: { bindingStamp: booked.stamp, at: now() },
          message: $t("lib.miyoushe-shop-plans.text_912b21fbc4"), pollUnit: current.pollUnit, pollMs: current.pollMs,
          leadMs: current.leadMs, intervalMs: current.intervalMs, nextPollAt: 0 });
        delete raw.afterMs;
        delete raw.pollRunId;
        for (const plan of data.plans) {
          if (plan.trackingId === id && !plan.bindingStamp && (plan.status === "scheduled" || plan.status === "preparing")) finish(plan, "cancelled");
        }
        return publicTracker(trackingRule(raw)!, data);
      });
    },
    async list(target: MiyousheOverviewTarget, verifyLogin?: Verify, sessionId?: string, before?: string) {
      const matches = (plan: MiyousheShopPlan) => plan.qq === target.qq && plan.profileId === target.profileId;
      const cursor = before === undefined ? undefined : historyCursor.exec(before);
      const cursorAt = Number(cursor?.[1]);
      if (before !== undefined && (!cursor || !natural(cursorAt))) bad($t("lib.miyoushe-shop-plans.text_9f95a611fb"));
      await verifyLogin?.();
      if (!cursor) await recover(matches);
      const plans = (await store.read()).plans.filter(matches)
        .sort((a, b) => b.createdAt - a.createdAt);
      await verifyLogin?.();
      const actionable = (plan: MiyousheShopPlan) => active(plan.status) || plan.status === "unknown";
      const history = plans.filter(plan => {
        if (actionable(plan)) return false;
        return !cursor || plan.createdAt < cursorAt || plan.createdAt === cursorAt && plan.id < cursor[2]!;
      }).sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
      const page = history.slice(0, shopHistoryPageSize);
      const recent = new Set(page.map(plan => plan.id));
      const older = history.length > shopHistoryPageSize ? history[shopHistoryPageSize - 1] : undefined;
      const visible = cursor ? page : plans.filter(plan => actionable(plan) || recent.has(plan.id));
      return { now: now(), canSubmit: Boolean(submit), ...(older && { older: `${older.createdAt}.${older.id}` }), plans: visible.map(plan => {
        const immediate = immediateVerification.get(plan.id);
        const scoped = immediate && immediate.session.sessionId === sessionId && !immediate.cancel.signal.aborted &&
          !immediate.session.signal.aborted ? immediate : undefined;
        const ticket = scoped?.ticket;
        return { ...publicPlan(plan), ...(scoped && { verificationPending: true }),
          ...(ticket && ticket.expiresAt > now() ? { verification: ticket } : {}) };
      }) };
    },
    endWebSession(sessionId: string) {
      for (const immediate of immediateVerification.values()) {
        if (immediate.session.sessionId === sessionId) immediate.cancel.abort();
      }
    },
    async reserve(target: MiyousheOverviewTarget, value: unknown, signal?: AbortSignal, verifyLogin?: Verify, session?: ManualShopSession,
      origin?: string) {
      const input = reservationInput(value);
      if (!submit) throw new MiyousheShopPlanError(503, $t("lib.miyoushe-shop-plans.text_bba5b8d55c"));
      await verifyLogin?.();
      const intentFingerprint = input.intentId && createHash("sha256")
        .update(JSON.stringify([input.goodsId, input.immediate, input.uid || "", input.region || "", input.addressId || "",
          input.expectedPrice ?? null])).digest("hex");
      const previousIntent = (data: Store) => {
        if (!input.intentId) return;
        const prior = data.plans.find(plan => plan.qq === target.qq && plan.profileId === target.profileId && plan.intentId === input.intentId);
        if (prior && prior.intentFingerprint !== intentFingerprint) conflict($t("lib.miyoushe-shop-plans.text_ef18e18316"));
        return prior;
      };
      if (input.intentId) {
        const prior = previousIntent(await store.read());
        if (prior) {
          await verifyLogin?.();
          return publicPlan(prior);
        }
      }
      const booked = await binding(target);
      const verifyBinding = async () => {
        signal?.throwIfAborted();
        await verifyLogin?.();
        await verifyCurrent(target, booked);
        signal?.throwIfAborted();
      };
      const snapshot = await inspect(target, input.goodsId, signal, verifyBinding);
      const good = validateInspection(snapshot, input.goodsId, input.immediate);
      if (input.expectedPrice !== undefined && input.expectedPrice !== good.price) conflict($t("lib.miyoushe-shop-plans.text_e6e8dac841"));
      const community = communityAccountGood(good);
      const role = good.type === 2 && !community ? snapshot.roles?.find(item => item.uid === input.uid &&
        (!input.region || item.region === input.region) && matching(item.region, code)) : undefined;
      const address = good.type === 1 ? snapshot.addresses?.find(item => item.id === input.addressId) : undefined;
      if (community ? input.uid !== undefined || input.region !== undefined || input.addressId !== undefined
        : good.type === 2 ? !role || input.addressId : !address || input.uid || input.region) bad($t("lib.miyoushe-shop-plans.text_aee01a382c"));
      let createdSessionPlan: string | undefined;
      const plan = await store.change(async data => {
        await verifyBinding();
        const prior = previousIntent(data);
        if (prior) return prior;
        if (data.plans.some(item => item.accountId === booked.accountId && item.goodsId === good.id &&
            (active(item.status) || item.status === "unknown"))) conflict($t("lib.miyoushe-shop-plans.text_8fc0e34d17"));
        const createdAt = now();
        const opensAt = good.status === "available" ? createdAt : good.opensAt!;
        if (opensAt < createdAt) conflict($t("lib.miyoushe-shop-plans.text_dbe173a82b"));
        let id: string;
        do { id = randomUUID().replaceAll("-", "").slice(0, 12); } while (data.plans.some(item => item.id === id));
        const manualSessionExpected = input.immediate && input.intentId && session && manualRelay?.() ? true : undefined;
        const route = parseMiyousheShopReceiptRoute(origin);
        const plan: MiyousheShopPlan = {
          id, qq: target.qq, profileId: target.profileId, accountId: booked.accountId, botId: route ? String(route.botId) : "", bindingStamp: booked.stamp,
          ...(route && { receiptRoute: origin }),
          ...(input.intentId ? { intentId: input.intentId, intentFingerprint } : {}),
          ...(manualSessionExpected ? { manualSessionExpected } : {}),
          goodsId: good.id, goodsName: clean(good.name, 240), gameBiz: good.gameBiz, price: good.price, type: good.type,
          role: role ? { uid: role.uid, region: role.region, gameBiz: good.gameBiz } : null,
          addressId: address?.id ?? "", addressLabel: addressLabel(address?.label), immediate: input.immediate,
          createdAt, opensAt, status: "scheduled", message: statusMessage.scheduled, attempts: 0,
        };
        if (manualSessionExpected) createdSessionPlan = id;
        data.plans.push(plan);
        return plan;
      });
      if (createdSessionPlan && session) immediateVerification.set(createdSessionPlan, { session, cancel: new AbortController() });
      return publicPlan(plan);
    },
    async cancel(target: MiyousheOverviewTarget, id: string, verifyLogin?: Verify) {
      return store.change(async data => {
        await verifyLogin?.();
        const plan = owned(data, target, id);
        if (plan.status !== "scheduled" && plan.status !== "preparing") conflict($t("lib.miyoushe-shop-plans.text_d8197ccc57"));
        finish(plan, "cancelled");
        immediateVerification.get(id)?.cancel.abort();
        immediateVerification.delete(id);
        return publicPlan(plan);
      });
    },
    async resolve(target: MiyousheOverviewTarget, id: string, redeemed: unknown, verifyLogin?: Verify) {
      if (typeof redeemed !== "boolean") bad($t("lib.miyoushe-shop-plans.text_42a74d663f"));
      return store.change(async data => {
        await verifyLogin?.();
        const plan = owned(data, target, id);
        if (plan.status !== "unknown") conflict($t("lib.miyoushe-shop-plans.text_6f55cccfac"));
        const current = await profiles.accountContext(target.qq, target.profileId).catch(() => undefined);
        if (!current || (current.account.stuid || current.account.ltuid) !== plan.accountId ||
            profileCookieAccountId(current.account) !== plan.accountId) conflict(details.resolveAccount);
        await verifyLogin?.();
        const latest = await profiles.accountContext(target.qq, target.profileId).catch(() => undefined);
        if (latest?.revision !== current.revision) conflict(details.resolveAccount);
        finish(plan, redeemed ? "succeeded" : "failed", redeemed ? details.redeemed : details.unredeemed);
        delete plan.receipt;
        return publicPlan(plan);
      });
    },
  };
}
