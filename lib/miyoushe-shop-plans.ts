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
import { asTrackerRecord, confirmedTracker, matchesTrackingGood, readTrackingInput, trackingCycle, trackingGame, trackingGames,
  trackingProfileGames, trackingRule, trackingSection, type ShopTracker, type TrackingGood, type TrackingRole } from "./miyoushe-shop-tracking.ts";

const planId = /^[a-f0-9]{12}$/u;
const numericId = /^[1-9]\d{0,19}$/u;
const code = /^[a-zA-Z0-9_]{1,32}$/u;
const intentPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
const preparingLead = 15_000;
const maxDelay = 30_000;
const manualVerificationTimeout = 185_000;

const statusMessage = {
  scheduled: "等待开放兑换",
  preparing: "正在检查登录状态、余额和兑换目标",
  submitting: "正在提交兑换请求",
  unknown: "兑换结果待确认，请查米游社兑换记录。请勿在确认前重新兑换。",
  cancelled: "已取消",
  missed: "已经错过预约场次，请重新预约。",
  succeeded: "兑换成功，请查看米游社兑换记录或游戏内邮件。",
  failed: "本次兑换未成功。",
};
const details = {
  changed: "档案绑定的米游社账号或设备已变化，请重新预约。",
  resolveAccount: "请在当前档案登录原米游社账号，再核对这笔兑换记录。",
  legacy: "旧版预约缺少账号绑定核验，请重新确认商品后预约。",
  updated: "官方调整了开放时间，预约已同步。",
  conditions: "商品、余额或兑换目标已变化，请重新预约。",
  unavailable: "暂时无法核验兑换条件，请重新预约。",
  redeemed: "用户核对官方兑换记录后确认已兑换。",
  unredeemed: "用户核对官方兑换记录后确认未兑换，可重新预约。",
  stockEmpty: "官方库存已售罄，本轮追踪结束。",
  pending: "该账号此商品有兑换结果待确认，请先核对米游社兑换记录再预约。",
  verification: "米游社要求验证，请在官方客户端完成验证后重新预约。",
  sessionEnded: "发起立即兑换的网页会话已结束，未提交兑换。",
  "rate-limited": "米游社商城请求频繁，请稍后重新预约。",
} as const;
const trackerMessages = {
  start: "持续追踪已开启，等待符合条件的库存及场次。",
  resume: "持续追踪已恢复，等待符合条件的库存及场次。",
  pause: "持续追踪已暂停。",
  booked: "已预约匹配商品，等待官方开放。",
  watching: "等待符合条件的库存及场次。",
  retry: "暂时无法核验官方商品状态，将在下次轮询重试。",
  changed: "档案绑定已变更，请重新建立追踪。",
  unknown: "有兑换结果待确认，请先核对米游社兑换记录。",
} as const;
const publicTrackerMessages = new Set<string>([...Object.values(trackerMessages), details.verification, details["rate-limited"], statusMessage.unknown]);
const publicMessages = new Set([...Object.values(statusMessage), ...Object.values(details)]);
type Status = keyof typeof statusMessage;
type Role = { readonly uid: string; readonly region: string; readonly gameBiz: string };
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
    verifyBinding?: () => Promise<void>, manual?: ShopManualVerification) => Promise<MiyousheShopExchangeResult>;
  readonly manualRelay?: () => ManualRelay | undefined;
  readonly tracking?: {
    readonly catalog: (target: MiyousheOverviewTarget, game: string, signal?: AbortSignal,
      verifyBinding?: () => Promise<void>) => Promise<readonly TrackingGood[]>;
    readonly destinations: (target: MiyousheOverviewTarget, game: string, itemType: 1 | 2, signal?: AbortSignal,
      verifyBinding?: () => Promise<void>) => Promise<{
        roles?: readonly TrackingRole[]; addresses?: readonly { readonly id: string; readonly label: string }[];
      }>;
  };
}

export class MiyousheShopPlanError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 503, message: string) { super(message); }
}

function bad(message: string): never { throw new MiyousheShopPlanError(400, message); }
function conflict(message: string): never { throw new MiyousheShopPlanError(409, message); }
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
    ? { uid: plan.role.uid, region: plan.role.region, gameBiz: matching(plan.role.gameBiz, code) ? plan.role.gameBiz : "" } : null;
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
        if (!(await input.stat()).isFile()) throw new Error("米游币兑换计划须为普通文件。");
        const data = asRecord(JSON.parse(await input.readFile("utf8")));
        if (!data || (data.version !== 1 && data.version !== 2) ||
            !Array.isArray(data.plans) || !data.plans.every(validPlan) ||
            new Set(data.plans.map(plan => plan.id)).size !== data.plans.length ||
            (data.version === 2 && !Array.isArray(data.trackers)) ||
            (data.trackers !== undefined && !Array.isArray(data.trackers)) ||
            (data.importedLegacy !== undefined && (!Array.isArray(data.importedLegacy) ||
              !data.importedLegacy.every(id => typeof id === "string")))) throw new Error("米游币兑换计划文件格式异常。");
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
    const guard = await lockFile(join(directory, `.${basename(file)}.sqlite`), "兑换计划");
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
            if (existing && !isDeepStrictEqual(existing, plan)) throw new Error("现用与旧版兑换计划有冲突。");
            if (!existing) {
              data.plans.push(plan);
              plansById.set(plan.id, plan);
            }
          }
          for (const tracker of source.data.trackers ?? []) {
            const id = asTrackerRecord(tracker)?.id;
            if (trackers.some(item => isDeepStrictEqual(item, tracker))) continue;
            if (typeof id === "string" && trackers.some(item => asTrackerRecord(item)?.id === id)) {
              throw new Error("现用与旧版兑换追踪有冲突。");
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
    const guard = await lockFile(join(directory, `.${basename(file)}.account-${account}.sqlite`), "账号兑换", 0).catch(error => {
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
    bad("请明确确认兑换 1 件商品并选择当前档案的兑换目标。");
  }
  return { goodsId: input.goodsId, immediate: input.immediate, uid: input.uid, region: input.region, addressId: input.addressId,
    intentId: typeof input.intentId === "string" ? input.intentId : undefined, expectedPrice: input.expectedPrice };
}

function validateInspection({ good, balance }: MiyousheShopInspection, goodsId: string, immediate: boolean) {
  if (good.id !== goodsId || !natural(good.price) || (good.type !== 1 && good.type !== 2) ||
      !clean(good.name, 240) || (good.type === 2 && !matching(good.gameBiz, code))) bad("暂不支持该商品。");
  if (good.status !== "available" && (immediate || good.status !== "scheduled" || !natural(good.opensAt))) {
    conflict("商品当前没有可用的兑换场次。");
  }
  if (!natural(balance) || balance < good.price) conflict("无法确认米游币余额足够兑换此商品。");
  return { ...good, type: good.type as 1 | 2 };
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
  if (!plan) throw new MiyousheShopPlanError(404, "未找到当前档案的兑换计划。");
  return plan;
}

export function createMiyousheShopPlans({ file, legacyFiles = [], profileDirectory, now = Date.now, inspect, submit, manualRelay, tracking }: Options) {
  const store = createStore(resolvePath(file), legacyFiles);
  const profiles = createProfileStore(profileDirectory);
  const immediateVerification = new Map<string, ImmediateVerification>();
  type Verify = () => Promise<void>;

  async function binding(target: MiyousheOverviewTarget) {
    const { account, device, revision } = await profiles.accountContext(target.qq, target.profileId);
    const { stuid, ltuid } = account;
    const accountId = stuid || ltuid;
    if (!matching(accountId, numericId) || (stuid && ltuid && stuid !== ltuid) || !device.id || !device.fp) {
      conflict("请先核验当前档案绑定的米游社账号和设备。");
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
      needsConfirmation: !confirmed, role: rule.role && { uid: rule.role.uid, region: rule.role.region },
      addressLabel: addressLabel(rule.addressLabel), ...trackerUsage(data, rule.id),
      message: !confirmed ? "旧追踪规则，重新确认后才会兑换。" :
        publicTrackerMessages.has(rule.message) ? rule.message : (rule.enabled ? trackerMessages.watching : trackerMessages.pause) };
  }

  function ownsTracker(data: Store, target: MiyousheOverviewTarget, id: string) {
    const raw = asTrackerRecord(findTracker(data, id));
    if (!raw || raw.qq !== target.qq || raw.profileId !== target.profileId) {
      throw new MiyousheShopPlanError(404, "未找到当前档案的追踪规则。");
    }
    const rule = trackingRule(raw);
    if (!rule) conflict("旧规则的范围或限额无法核验，请核对原始记录后重新建立规则。");
    return { raw, rule };
  }

  async function verifyRole(target: MiyousheOverviewTarget, rule: Pick<ShopTracker, "game" | "role">) {
    if (!rule.role) return;
    if (!trackingGame(rule.game)) conflict("无法核验该分区的游戏角色。");
    const selected = await profiles.selectedShopRoleUid(target.qq, target.profileId, trackingProfileGames[rule.game]);
    if (selected !== rule.role.uid) conflict("当前档案的游戏 UID 已换绑，请重新建立追踪。");
  }

  async function verifyTrackerTarget(target: MiyousheOverviewTarget, rule: Pick<ShopTracker, "game" | "itemType" | "role" | "addressId">,
    signal?: AbortSignal, verify?: Verify) {
    const destinations = await tracking!.destinations(target, rule.game, rule.itemType, signal, verify);
    if (rule.itemType === 2 ? !destinations.roles?.some(role => role.uid === rule.role?.uid && role.region === rule.role.region &&
        role.gameBiz === rule.role.gameBiz) : !destinations.addresses?.some(address => address.id === rule.addressId)) {
      conflict("原兑换目标不属于当前档案，请重新建立追踪。");
    }
    await verifyRole(target, rule);
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
      for (const candidate of goods) {
        signal?.throwIfAborted();
        if (candidate.status !== "available" && candidate.status !== "scheduled") continue;
        if (candidate.status === "scheduled" && candidate.opensAt !== null) {
          nearest = Math.min(nearest ?? candidate.opensAt, candidate.opensAt);
          if (candidate.opensAt > now() + Math.max(preparingLead, rule.leadMs + 10_000)) continue;
        }
        const snapshot = await inspect(target, candidate.id, signal, verifyBinding);
        const { good, balance } = snapshot;
        if (good.id !== candidate.id || !matchesTrackingGood(rule, good) || !natural(good.price) || !natural(balance) || balance < good.price ||
          (good.status !== "available" && (good.status !== "scheduled" || !natural(good.opensAt))) ||
          (rule.role ? !snapshot.roles?.some(role => role.uid === rule.role?.uid && role.region === rule.role.region)
            : !snapshot.addresses?.some(address => address.id === rule.addressId))) continue;
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
          data.plans.push({ id, ...target, accountId: rule.accountId, botId: "", bindingStamp: booked.stamp,
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
        current.message = trackerMessages.watching;
        if (nearest !== undefined && nearest > now()) {
          current.nextOpenAt = nearest;
          current.nextPollAt = Math.min(now() + rule.pollMs, Math.max(now() + 1000, nearest - Math.max(preparingLead, rule.leadMs)));
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
        } else if (phase === "binding" || (error instanceof MiyousheShopPlanError && error.message === details.changed)) {
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
          if (resumeDeadline !== undefined && now() >= resumeDeadline) conflict(details.verification);
          if (immediate && activeSignal) await immediate.session.verify(activeSignal);
          await verifyCurrent(target, booked);
          if (plan.trackingId) {
            const data = await store.read();
            if (!trackerIsCurrent(data, plan)) conflict("持续追踪已暂停或当前商品已兑换。");
            await verifyRole(target, trackingRule(findTracker(data, plan.trackingId))!);
          }
          activeSignal?.throwIfAborted();
          if (resumeDeadline !== undefined && now() >= resumeDeadline) conflict(details.verification);
        };
        const inspectCurrent = async () => {
          message = details.unavailable;
          const snapshot = await inspect(target, plan.goodsId, activeSignal, verifyBinding);
          saleClose = localSaleEnd(snapshot.good, now());
          message = details.conditions;
          const trackingStatus = plan.trackingId && (snapshot.good.status === "unknown" || snapshot.good.status === "sold_out");
          const good = trackingStatus ? snapshot.good : validateInspection(snapshot, plan.goodsId, plan.immediate);
          if (good.price !== plan.price || good.type !== plan.type || good.gameBiz !== plan.gameBiz ||
            (plan.trackingId && (good.id !== plan.goodsId || !natural(snapshot.balance) || snapshot.balance < plan.price ||
              (!trackingStatus && trackingCycle(good, now()) !== plan.cycleKey))) ||
            (plan.role ? !snapshot.roles?.some(role => role.uid === plan.role?.uid && role.region === plan.role?.region)
              : !snapshot.addresses?.some(address => address.id === plan.addressId))) conflict(details.conditions);
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
        if (good.status !== "available" || now() > plan.opensAt + maxDelay) {
          await update(plan.id, "preparing", current => finish(current, "missed"));
          return;
        }
        const purchaseCycle = immediate ? trackingCycle(good, now()) : undefined;
        const manual: ShopManualVerification | undefined = immediate && activeSignal ? {
          async waitForProof(challenge, requestSignal) {
            const relay = manualRelay?.();
            if (!relay || now() > plan.opensAt + maxDelay) return;
            const time = now();
            const deadline = Math.min(time + manualVerificationTimeout, saleClose);
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
            resumeDeadline = Math.min(resumeDeadline ?? time, saleClose);
            if (time >= resumeDeadline) conflict(details.verification);
            const marked = await update(plan.id, "submitting", current => { current.attempts++; });
            if (!marked) conflict(details.conditions);
          },
        } : undefined;
        const submitted = await update(plan.id, "preparing", (current, data) => {
          if (!trackerIsCurrent(data, current)) finish(current, "cancelled");
          else Object.assign(current, { status: "submitting", message: statusMessage.submitting, attempts: current.attempts + 1 });
        });
        if (submitted?.status !== "submitting") return;
        submitting = true;
        await verifyBinding();
        started = true;
        const result = await submit(Object.freeze(submitted), activeSignal, verifyBinding, manual);
        await update(plan.id, "submitting", (current, data) => {
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
    const failed = results.find(result => result.status === "rejected");
    if (failed) throw failed.reason;
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    start(signal: AbortSignal, onError?: (error: unknown) => void) {
      if (timer || signal.aborted) return;
      const seen = new WeakSet<Promise<void>>();
      const tick = () => {
        if (!polling) void poll(signal).catch(error => onError?.(error));
        void select(signal).then(jobs => {
          for (const job of jobs) if (!seen.has(job)) {
            seen.add(job);
            void job.catch(error => onError?.(error));
          }
        }).catch(error => onError?.(error));
      };
      if (submit) {
        timer = setInterval(tick, 1_000);
        timer.unref();
        signal.addEventListener("abort", () => { clearInterval(timer); timer = undefined; }, { once: true });
      }
      tick();
    },
    scan,
    async trackerTargets(target: MiyousheOverviewTarget, game: unknown, itemType: unknown, signal?: AbortSignal, verifyLogin?: Verify) {
      if (!tracking) throw new MiyousheShopPlanError(503, "持续追踪服务暂未启用。");
      if (!trackingSection(game) || (itemType !== 1 && itemType !== 2) || (itemType === 2 && !trackingGame(game)) || game === "all") {
        bad("请选择游戏分区和商品类型。");
      }
      await verifyLogin?.();
      const result = await tracking.destinations(target, game, itemType, signal, verifyLogin);
      await verifyLogin?.();
      if (itemType === 1) return { type: "address" as const,
        items: (result.addresses ?? []).filter(item => matching(item.id, numericId)).map(item => ({ id: item.id, label: addressLabel(item.label) })) };
      if (!trackingGame(game)) bad("请选择支持角色兑换的游戏分区。");
      const selected = await profiles.selectedShopRoleUid(target.qq, target.profileId, trackingProfileGames[game]);
      return { type: "role" as const, items: (result.roles ?? []).filter(role => role.gameBiz === trackingGames[game] &&
        role.uid === selected && matching(role.region, code)).map(role => ({ uid: role.uid, region: role.region })) };
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
          message: "旧规则的范围或限额无法核验，请核对原始记录后重新建立规则。" };
      }).filter(row => row !== undefined).sort((a, b) => b.createdAt - a.createdAt);
      return { now: now(), canTrack: Boolean(tracking && submit), trackers };
    },
    async createTracker(target: MiyousheOverviewTarget, value: unknown, signal?: AbortSignal, verifyLogin?: Verify) {
      if (!tracking || !submit) throw new MiyousheShopPlanError(503, "持续追踪服务暂未启用。");
      const input = readTrackingInput(value);
      if (!input) bad("请核对追踪范围、预算并确认持续兑换。");
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
      if (input.itemType === 2 ? !role : !address) bad("未找到当前档案的兑换目标。");
      const names: string[] = [];
      for (const goodsId of input.goodsIds) {
        const { good } = await inspect(target, goodsId, signal, verify);
        if (good.id !== goodsId || !matchesTrackingGood({ ...input, names: [] }, good)) bad("所选商品不属于指定的分区和类型，或超过价格上限。");
        names.push(clean(good.name, 240));
      }
      return store.change(async data => {
        await verify();
        if (data.plans.some(plan => plan.accountId === booked.accountId && plan.status === "unknown")) {
          conflict("请先核对该账号待确认的兑换记录。");
        }
        const rows = data.trackers ??= [];
        let id: string;
        do { id = randomUUID().replaceAll("-", "").slice(0, 12); } while (findTracker(data, id));
        const rule: ShopTracker = { ...input, ...target, id, accountId: booked.accountId, names,
          role: role ? { uid: role.uid, region: role.region, gameBiz: role.gameBiz } : null,
          gameBiz: role?.gameBiz ?? "", addressId: address?.id ?? "", addressLabel: addressLabel(address?.label),
          enabled: true, createdAt: now(), confirmation: { bindingStamp: booked.stamp, at: now() },
          message: "持续追踪已开启，等待符合条件的库存及场次。" };
        await verifyRole(target, rule);
        const exists = rows.map(trackingRule).some(item => item && item.qq === rule.qq && item.profileId === rule.profileId &&
          item.accountId === rule.accountId && item.mode === rule.mode && item.game === rule.game && item.itemType === rule.itemType &&
          JSON.stringify([...item.goodsIds].sort()) === JSON.stringify([...rule.goodsIds].sort()) &&
          JSON.stringify([...item.keywords].sort()) === JSON.stringify([...rule.keywords].sort()) &&
          item.addressId === rule.addressId && item.role?.uid === rule.role?.uid && item.maxPrice === rule.maxPrice &&
          item.spendLimit === rule.spendLimit && item.followSameName === rule.followSameName);
        if (exists) conflict("该档案已有相同追踪规则，请在列表中恢复或暂停。");
        rows.push(rule);
        return publicTracker(rule, data);
      });
    },
    async setTracker(target: MiyousheOverviewTarget, id: string, enabled: boolean, confirmed: unknown, signal?: AbortSignal, verifyLogin?: Verify) {
      await verifyLogin?.();
      if (!enabled) return store.change(async data => {
        await verifyLogin?.();
        const { raw, rule } = ownsTracker(data, target, id);
        pauseTracks(data, rule.accountId, "持续追踪已暂停。", rule.id);
        return publicTracker(trackingRule(raw)!, data);
      });
      if (!tracking || !submit) throw new MiyousheShopPlanError(503, "持续追踪服务暂未启用。");
      if (confirmed !== true) bad("请明确确认恢复持续兑换。");
      const { rule } = ownsTracker(await store.read(), target, id);
      const booked = await binding(target);
      if (booked.accountId !== rule.accountId || (confirmedTracker(rule) && booked.stamp !== rule.confirmation.bindingStamp)) {
        conflict("追踪规则的绑定已变化，请重新建立追踪。");
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
            (plan.status === "unknown" || plan.status === "submitting"))) conflict("请先核对该账号待确认的兑换记录。");
        const { raw, rule: current } = ownsTracker(data, target, id);
        if (raw.enabled && confirmedTracker(current)) return publicTracker(current, data);
        Object.assign(raw, { enabled: true, confirmation: { bindingStamp: booked.stamp, at: now() },
          message: "持续追踪已恢复，等待符合条件的库存及场次。", pollUnit: current.pollUnit, pollMs: current.pollMs,
          leadMs: current.leadMs, intervalMs: current.intervalMs, nextPollAt: 0 });
        delete raw.afterMs;
        delete raw.pollRunId;
        for (const plan of data.plans) {
          if (plan.trackingId === id && !plan.bindingStamp && (plan.status === "scheduled" || plan.status === "preparing")) finish(plan, "cancelled");
        }
        return publicTracker(trackingRule(raw)!, data);
      });
    },
    async list(target: MiyousheOverviewTarget, verifyLogin?: Verify, sessionId?: string) {
      const matches = (plan: MiyousheShopPlan) => plan.qq === target.qq && plan.profileId === target.profileId;
      await verifyLogin?.();
      await recover(matches);
      const plans = (await store.read()).plans.filter(matches);
      await verifyLogin?.();
      return { now: now(), canSubmit: Boolean(submit), plans: plans.sort((a, b) => b.createdAt - a.createdAt).slice(0, 30).map(plan => {
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
    async reserve(target: MiyousheOverviewTarget, value: unknown, signal?: AbortSignal, verifyLogin?: Verify, session?: ManualShopSession) {
      const input = reservationInput(value);
      if (!submit) throw new MiyousheShopPlanError(503, "预约兑换服务暂未启用。");
      await verifyLogin?.();
      const intentFingerprint = input.intentId && createHash("sha256")
        .update(JSON.stringify([input.goodsId, input.immediate, input.uid || "", input.region || "", input.addressId || "",
          input.expectedPrice ?? null])).digest("hex");
      const previousIntent = (data: Store) => {
        if (!input.intentId) return;
        const prior = data.plans.find(plan => plan.qq === target.qq && plan.profileId === target.profileId && plan.intentId === input.intentId);
        if (prior && prior.intentFingerprint !== intentFingerprint) conflict("该次兑换确认已用于其他商品或兑换目标。");
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
      if (input.expectedPrice !== undefined && input.expectedPrice !== good.price) conflict("商品价格已变化，请刷新后重新确认。");
      const role = good.type === 2 ? snapshot.roles?.find(item => item.uid === input.uid &&
        (!input.region || item.region === input.region) && matching(item.region, code)) : undefined;
      const address = good.type === 1 ? snapshot.addresses?.find(item => item.id === input.addressId) : undefined;
      if (good.type === 2 ? !role || input.addressId : !address || input.uid || input.region) bad("兑换目标不属于当前档案。");
      let createdSessionPlan: string | undefined;
      const plan = await store.change(async data => {
        await verifyBinding();
        const prior = previousIntent(data);
        if (prior) return prior;
        if (data.plans.some(item => item.accountId === booked.accountId && item.goodsId === good.id &&
            (active(item.status) || item.status === "unknown"))) conflict("该账号已有此商品的兑换预约或待确认结果。");
        const createdAt = now();
        const opensAt = good.status === "available" ? createdAt : good.opensAt!;
        if (opensAt < createdAt) conflict("商品开放时间已过，请刷新商品状态。");
        let id: string;
        do { id = randomUUID().replaceAll("-", "").slice(0, 12); } while (data.plans.some(item => item.id === id));
        const manualSessionExpected = input.immediate && input.intentId && session && manualRelay?.() ? true : undefined;
        const plan: MiyousheShopPlan = {
          id, qq: target.qq, profileId: target.profileId, accountId: booked.accountId, botId: "", bindingStamp: booked.stamp,
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
        if (plan.status !== "scheduled" && plan.status !== "preparing") conflict("当前状态下无法取消兑换计划。");
        finish(plan, "cancelled");
        immediateVerification.get(id)?.cancel.abort();
        immediateVerification.delete(id);
        return publicPlan(plan);
      });
    },
    async resolve(target: MiyousheOverviewTarget, id: string, redeemed: unknown, verifyLogin?: Verify) {
      if (typeof redeemed !== "boolean") bad("请先核对米游社官方兑换记录。");
      return store.change(async data => {
        await verifyLogin?.();
        const plan = owned(data, target, id);
        if (plan.status !== "unknown") conflict("只有结果待确认的计划可以人工确认。");
        const current = await profiles.accountContext(target.qq, target.profileId).catch(() => undefined);
        if (!current || (current.account.stuid || current.account.ltuid) !== plan.accountId ||
            profileCookieAccountId(current.account) !== plan.accountId) conflict(details.resolveAccount);
        await verifyLogin?.();
        const latest = await profiles.accountContext(target.qq, target.profileId).catch(() => undefined);
        if (latest?.revision !== current.revision) conflict(details.resolveAccount);
        finish(plan, redeemed ? "succeeded" : "failed", redeemed ? details.redeemed : details.unredeemed);
        return publicPlan(plan);
      });
    },
  };
}
