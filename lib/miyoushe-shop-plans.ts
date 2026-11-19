import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createProfileStore } from "@lotus-yunzai/account";
import type { MiyousheShopExchangeResult } from "@lotus-yunzai/hoyo-client/miyoushe-exchange";
import { lockFile } from "./file-lock.ts";
import type { MiyousheOverviewTarget } from "./miyoushe-overview.ts";

const planId = /^[a-f0-9]{12}$/u;
const numericId = /^[1-9]\d{0,19}$/u;
const code = /^[a-zA-Z0-9_]{1,32}$/u;
const intentPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
const preparingLead = 15_000;
const maxDelay = 30_000;

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
  legacy: "旧版预约缺少账号绑定核验，请重新确认商品后预约。",
  updated: "官方调整了开放时间，预约已同步。",
  conditions: "商品、余额或兑换目标已变化，请重新预约。",
  unavailable: "暂时无法核验兑换条件，请重新预约。",
  redeemed: "用户核对官方兑换记录后确认已兑换。",
  unredeemed: "用户核对官方兑换记录后确认未兑换，可重新预约。",
  verification: "米游社要求验证，请在官方客户端完成验证后重新预约。",
  "rate-limited": "米游社商城请求频繁，请稍后重新预约。",
} as const;
const publicMessages = new Set([...Object.values(statusMessage), ...Object.values(details)]);
type Status = keyof typeof statusMessage;
type Role = { readonly uid: string; readonly region: string; readonly gameBiz: string };

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
  readonly bindingStamp?: string;
  readonly intentId?: string;
  readonly intentFingerprint?: string;
  status: Status;
  opensAt: number;
  message: string;
  attempts: number;
  finishedAt?: number;
}

export interface MiyousheShopInspection {
  readonly good: {
    readonly id: string; readonly name: string; readonly type: number | null; readonly gameBiz: string;
    readonly price: number; readonly status: "available" | "scheduled" | "ended" | "sold_out" | "unknown";
    readonly opensAt: number | null;
  };
  readonly balance: number;
  readonly roles?: readonly { readonly uid: string; readonly region: string }[];
  readonly addresses?: readonly { readonly id: string; readonly label: string }[];
}

interface Options {
  readonly file: string;
  readonly profileDirectory?: string | URL;
  readonly now?: () => number;
  readonly inspect: (target: MiyousheOverviewTarget, goodsId: string, signal?: AbortSignal,
    verifyBinding?: () => Promise<void>) => Promise<MiyousheShopInspection>;
  readonly submit?: (plan: Readonly<MiyousheShopPlan>, signal?: AbortSignal,
    verifyBinding?: () => Promise<void>) => Promise<MiyousheShopExchangeResult>;
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

interface Store { version: 1 | 2; plans: MiyousheShopPlan[]; trackers?: unknown[] }

function createStore(file: string) {
  const directory = dirname(file);
  async function read(): Promise<Store> {
    try {
      const input = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!(await input.stat()).isFile()) throw new Error("米游币兑换计划须为普通文件。");
        const data = asRecord(JSON.parse(await input.readFile("utf8")));
        if (!data || (data.version !== 1 && data.version !== 2) ||
            !Array.isArray(data.plans) || !data.plans.every(validPlan) ||
            new Set(data.plans.map(plan => plan.id)).size !== data.plans.length ||
            (data.version === 2 && !Array.isArray(data.trackers)) ||
            (data.trackers !== undefined && !Array.isArray(data.trackers))) throw new Error("米游币兑换计划文件格式异常。");
        return data as unknown as Store;
      } finally { await input.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 2, plans: [], trackers: [] };
      throw error;
    }
  }

  async function change<T>(edit: (data: Store) => T | Promise<T>): Promise<T> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const guard = await lockFile(join(directory, `.${basename(file)}.sqlite`), "兑换计划");
    try {
      const data = await read();
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

function owned(data: Store, target: MiyousheOverviewTarget, id: string) {
  const plan = planId.test(id) && data.plans.find(item => item.id === id && item.qq === target.qq && item.profileId === target.profileId);
  if (!plan) throw new MiyousheShopPlanError(404, "未找到当前档案的兑换计划。");
  return plan;
}

export function createMiyousheShopPlans({ file, profileDirectory, now = Date.now, inspect, submit }: Options) {
  const store = createStore(resolvePath(file));
  const profiles = createProfileStore(profileDirectory);
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

  async function update(id: string, expected: Status, edit: (plan: MiyousheShopPlan) => void) {
    return store.change(data => {
      const plan = data.plans.find(item => item.id === id && item.status === expected);
      if (!plan) return;
      edit(plan);
      return plan;
    });
  }

  async function recoverAccount(accountId: string) {
    await store.change(data => {
      const uncertain = new Set<string>();
      for (const plan of data.plans) {
        if (plan.accountId !== accountId) continue;
        if (plan.status === "submitting") finish(plan, "unknown");
        if (plan.status === "preparing") Object.assign(plan, { status: "scheduled", message: statusMessage.scheduled });
        if (plan.status === "unknown" && plan.trackingId) uncertain.add(plan.trackingId);
      }
      for (const value of data.trackers ?? []) {
        const rule = asRecord(value);
        if (typeof rule?.id === "string" && uncertain.has(rule.id) && rule.enabled !== false) {
          rule.enabled = false;
          rule.message = "有兑换结果待确认，请先核对米游社兑换记录。";
        }
      }
    });
  }

  async function recover(match: (plan: MiyousheShopPlan) => boolean) {
    const { plans } = await store.read();
    const accounts = new Set(plans.filter(plan => match(plan) && (plan.status === "submitting" ||
      plan.status === "preparing" || (plan.status === "unknown" && plan.trackingId))).map(plan => plan.accountId));
    await Promise.all([...accounts].map(accountId => store.withAccount(accountId, () => recoverAccount(accountId))));
  }

  async function run(plan: MiyousheShopPlan, signal?: AbortSignal) {
    if (!submit || signal?.aborted || plan.trackingId) return;
    const target = { qq: plan.qq, profileId: plan.profileId };
    await store.withAccount(plan.accountId, async () => {
      if (!await update(plan.id, "scheduled", current => {
        current.status = "preparing";
        current.message = statusMessage.preparing;
      })) return;
      let started = false;
      let submitting = false;
      let message: string = details.unavailable;
      try {
        signal?.throwIfAborted();
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
          signal?.throwIfAborted();
          await verifyCurrent(target, booked);
          signal?.throwIfAborted();
        };
        const inspectCurrent = async () => {
          message = details.unavailable;
          const snapshot = await inspect(target, plan.goodsId, signal, verifyBinding);
          message = details.conditions;
          const good = validateInspection(snapshot, plan.goodsId, plan.immediate);
          if (good.price !== plan.price || good.type !== plan.type || good.gameBiz !== plan.gameBiz ||
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
        if (good.status !== "available" || now() > plan.opensAt + maxDelay) {
          await update(plan.id, "preparing", current => finish(current, "missed"));
          return;
        }
        const submitted = await update(plan.id, "preparing", current => {
          current.status = "submitting";
          current.message = statusMessage.submitting;
          current.attempts++;
        });
        if (!submitted) return;
        submitting = true;
        await verifyBinding();
        started = true;
        const result = await submit(Object.freeze(submitted), signal, verifyBinding);
        await update(plan.id, "submitting", current => {
          if (result === "verification" || result === "rate-limited") finish(current, "failed", details[result]);
          else finish(current, result === "succeeded" || result === "failed" ? result : "unknown");
        });
      } catch {
        await update(plan.id, submitting ? "submitting" : "preparing", current => {
          if (started) finish(current, "unknown");
          else if (signal?.aborted) {
            Object.assign(current, { status: "scheduled", message: statusMessage.scheduled });
          } else finish(current, "failed", message);
        });
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
        if (plan.status === "scheduled" && !plan.trackingId && plan.opensAt <= now() + preparingLead &&
            !running.has(plan.accountId)) {
          const job = run(plan, signal).finally(() => { running.delete(plan.accountId); });
          running.set(plan.accountId, job);
        }
      }
      return [...running.values()];
    })().finally(() => { selecting = undefined; });
  }

  async function scan(signal?: AbortSignal) {
    const results = await Promise.allSettled(await select(signal));
    const failed = results.find(result => result.status === "rejected");
    if (failed) throw failed.reason;
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    start(signal: AbortSignal, onError?: (error: unknown) => void) {
      if (timer || signal.aborted) return;
      const seen = new WeakSet<Promise<void>>();
      const tick = () => void select(signal).then(jobs => {
        for (const job of jobs) if (!seen.has(job)) {
          seen.add(job);
          void job.catch(error => onError?.(error));
        }
      }).catch(error => onError?.(error));
      if (submit) {
        timer = setInterval(tick, 1_000);
        timer.unref();
        signal.addEventListener("abort", () => { clearInterval(timer); timer = undefined; }, { once: true });
      }
      tick();
    },
    scan,
    async list(target: MiyousheOverviewTarget, verifyLogin?: Verify) {
      const matches = (plan: MiyousheShopPlan) => plan.qq === target.qq && plan.profileId === target.profileId;
      await verifyLogin?.();
      await recover(matches);
      const plans = (await store.read()).plans.filter(matches);
      await verifyLogin?.();
      return { now: now(), canSubmit: Boolean(submit), plans: plans.sort((a, b) => b.createdAt - a.createdAt).slice(0, 30).map(publicPlan) };
    },
    async reserve(target: MiyousheOverviewTarget, value: unknown, signal?: AbortSignal, verifyLogin?: Verify) {
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
        const plan: MiyousheShopPlan = {
          id, qq: target.qq, profileId: target.profileId, accountId: booked.accountId, botId: "", bindingStamp: booked.stamp,
          ...(input.intentId ? { intentId: input.intentId, intentFingerprint } : {}),
          goodsId: good.id, goodsName: clean(good.name, 240), gameBiz: good.gameBiz, price: good.price, type: good.type,
          role: role ? { uid: role.uid, region: role.region, gameBiz: good.gameBiz } : null,
          addressId: address?.id ?? "", addressLabel: addressLabel(address?.label), immediate: input.immediate,
          createdAt, opensAt, status: "scheduled", message: statusMessage.scheduled, attempts: 0,
        };
        data.plans.push(plan);
        return plan;
      });
      return publicPlan(plan);
    },
    async cancel(target: MiyousheOverviewTarget, id: string, verifyLogin?: Verify) {
      return store.change(async data => {
        await verifyLogin?.();
        const plan = owned(data, target, id);
        if (plan.status !== "scheduled" && plan.status !== "preparing") conflict("当前状态下无法取消兑换计划。");
        finish(plan, "cancelled");
        return publicPlan(plan);
      });
    },
    async resolve(target: MiyousheOverviewTarget, id: string, redeemed: unknown, verifyLogin?: Verify) {
      if (typeof redeemed !== "boolean") bad("请先核对米游社官方兑换记录。");
      return store.change(async data => {
        await verifyLogin?.();
        const plan = owned(data, target, id);
        if (plan.status !== "unknown") conflict("只有结果待确认的计划可以人工确认。");
        finish(plan, redeemed ? "succeeded" : "failed", redeemed ? details.redeemed : details.unredeemed);
        return publicPlan(plan);
      });
    },
  };
}
