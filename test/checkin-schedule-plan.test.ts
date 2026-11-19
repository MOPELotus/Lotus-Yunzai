import { expect, test } from "bun:test";
import {
  addLateCheckinScheduleProfile, checkinScheduleClock, checkinScheduleMinute, generateCheckinSchedulePlan,
  isCheckinScheduleDate, parseCheckinSchedulePlan, reconcileCheckinSchedulePlan,
  type CheckinCommunityWriteStatus, type CheckinScheduleConfig, type CheckinScheduleEntry, type CheckinScheduleProfile,
} from "../lib/checkin-schedule-plan.ts";

const now = new Date("2026-11-19T00:10:00+08:00");
const stamp = "2026-11-19T00:10:00.000+08:00";
const today = "2026-11-19";
const tomorrow = "2026-11-20";

function profile(qq: string, overrides: Partial<CheckinScheduleProfile> = {}): CheckinScheduleProfile {
  return { qq, enabled: true, ...overrides };
}

function entry(qq: string, overrides: Partial<CheckinScheduleEntry> = {}): CheckinScheduleEntry {
  return { qq, profileId: 1, name: "", time: "06:30", mode: "fixed", notified: false, done: false, ...overrides };
}

test("中国签到日独立于宿主时区，公历日期正确跨年和闰日", () => {
  expect(checkinScheduleClock(new Date("2026-12-31T15:59:44.100Z"))).toEqual({
    date: "2026-12-31", tomorrow: "2027-01-01", time: "23:59", minute: 1439, iso: "2026-12-31T23:59:44.100+08:00",
  });
  expect(checkinScheduleClock(Date.parse("2024-02-28T16:00:00Z"))).toEqual({
    date: "2024-02-29", tomorrow: "2024-03-01", time: "00:00", minute: 0, iso: "2024-02-29T00:00:00.000+08:00",
  });
  expect(isCheckinScheduleDate("2000-02-29")).toBe(true);
  for (const invalid of ["0000-01-01", "1900-02-29", "2026-02-29", "2026-04-31", "2026-11-00", "2026-11-9"]) {
    expect(isCheckinScheduleDate(invalid)).toBe(false);
    expect(() => generateCheckinSchedulePlan({ date: invalid, now })).toThrow(TypeError);
  }
  for (const invalid of ["24:00", "12:60", "04:7", "7:04", "04:30 ", 430]) {
    expect(checkinScheduleMinute(invalid)).toBeNaN();
  }
  expect(() => checkinScheduleClock(Number.NaN)).toThrow(TypeError);
});

test("生成默认明日固定计划，显式档案时间和旧随机开关按原优先级", () => {
  const profiles = [
    profile("777", { name: "档案", profileId: 3 }), profile("42", { enabled: false }),
    profile("777", { name: "不保留的重复", profileId: 3 }),
    profile("888", { schedule: { mode: "fixed", fixedTime: "14:05" } }),
    profile("999", { schedule: { mode: "random", allowRandom: false } }),
  ];
  expect(generateCheckinSchedulePlan({ now, profiles, random: () => { throw new Error("不需要随机数"); } })).toEqual({
    version: 1, date: tomorrow, mode: "fixed", generatedAt: stamp,
    window: { window_start: "00:00", window_end: "23:30", notify_before: true },
    entries: [entry("777", { profileId: 3, name: "档案", time: "04:30" }),
      entry("999", { time: "04:30" }), entry("888", { time: "14:05" })],
  });
  expect(generateCheckinSchedulePlan({
    now, profiles: [profile("42"), profile("42", { enabled: false }), profile("42")],
  }).entries).toEqual([]);
  for (const config of [
    { fixed_time: "04:99" }, { random: { window_start: "24:00" } },
    { late_registration: { window_start: "23:55", window_end: "23:50" } },
  ]) expect(() => generateCheckinSchedulePlan({ now, config })).toThrow(TypeError);
});

test("按旧算法等分窗口并抖动，密集档案不会取无效随机数或越界", () => {
  const config = { mode: "random", random: { window_start: "02:30", window_end: "03:00", notify_before: false } } as const;
  const profiles = [profile("10"), profile("20"), profile("30", { schedule: { mode: "random", allowRandom: false } })];
  const samples = [0.91, 0, 0.99];
  const plan = generateCheckinSchedulePlan({ date: today, now, config, profiles, random: () => samples.shift()! });
  expect(plan.entries.map(entry => [entry.qq, entry.time, entry.mode])).toEqual([
    ["10", "02:39", "random"], ["20", "02:40", "random"], ["30", "02:59", "random"],
  ]);
  expect(plan.window.notify_before).toBe(false);
  const singleton = generateCheckinSchedulePlan({
    now, profiles, config: { ...config, random: { window_start: "23:59", window_end: "23:59" } },
    random: () => { throw new Error("单分钟窗口不取抖动"); },
  });
  expect(singleton.entries.map(entry => entry.time)).toEqual(["23:59", "23:59", "23:59"]);
  expect(() => generateCheckinSchedulePlan({ now, profiles, config, random: () => 1 })).toThrow(TypeError);
});

test("同一天对账保持已分配随机时段、已通知和在途结果，去除关闭的待执行档案", () => {
  const done = entry("20", { done: true, doneAt: stamp, ok: true, stage: "checkin", message: "旧回执" });
  const running = entry("30", { runningAt: stamp });
  const retry = entry("40", { communityRetry: { forums: ["6"], nextAt: stamp, attempts: 2, otherFailure: false, initialMessage: "旧回执" } });
  const retained = entry("10", { mode: "random", time: "01:00", notified: true });
  const before = {
    ...generateCheckinSchedulePlan({ date: today, now }),
    entries: [done, running, retained, retry, entry("50"), entry("60"), entry("80")],
  };
  const profiles = [
    profile("10", { schedule: { mode: "random" } }), profile("20", { enabled: false }), profile("30", { enabled: false }),
    profile("40", { enabled: false }), profile("50", { enabled: false }), profile("60", { schedule: { mode: "fixed", fixedTime: "20:00" } }),
    profile("70", { schedule: { mode: "random" } }),
  ];
  const config: CheckinScheduleConfig = { random: { window_start: "10:00", window_end: "12:00" } };
  const after = reconcileCheckinSchedulePlan(before, { now, config, profiles });
  expect(after.entries).toEqual([retained, done, running, retry, entry("60", { time: "20:00" }),
    entry("70", { time: "23:30", mode: "late_random", late: true, lateRegisteredAt: stamp })]);
  expect(after.generatedAt).toBe(before.generatedAt);
  expect(after.window).toEqual({ window_start: "10:00", window_end: "12:00", notify_before: true });
  expect(before.entries).toHaveLength(7);
  expect(reconcileCheckinSchedulePlan(after, { config, profiles, now: new Date("2026-11-19T18:22:00+08:00") })).toEqual(after);
});

test("已有档案从固定切到随机走常规槽位，晚登记截止不会移除它", () => {
  const retained = entry("10", { mode: "random", time: "06:50", notified: true });
  const before = { ...generateCheckinSchedulePlan({ date: today, now }),
    entries: [retained, entry("20", { time: "07:30", notified: true })] };
  const config = {
    mode: "random", random: { window_start: "08:00", window_end: "10:00" },
    late_registration: { window_start: "19:00", window_end: "20:00" },
  } as const;
  const late = Date.parse("2026-11-19T20:01:00+08:00");
  const profiles = [profile("10"), profile("20"), profile("30")];
  let samples = 0;
  const after = reconcileCheckinSchedulePlan(before, { now: late, config, profiles, random: () => { samples++; return 0.5; } });
  expect(samples).toBe(1);
  expect(after.entries).toEqual([retained, entry("20", { mode: "random", time: "09:00" })]);
  expect(reconcileCheckinSchedulePlan(after, {
    now: late, config, profiles, random: () => { throw new Error("重启不重抽时段"); },
  })).toEqual(after);
});

test("晚登记窗口截止分钟包含，槽位轮转，明日可独立登记", () => {
  const config = { mode: "random", late_registration: { window_start: "20:29", window_end: "20:30" } } as const;
  const atEnd = Date.parse("2026-11-19T20:30:59+08:00");
  const pastEnd = Date.parse("2026-11-19T20:31:00+08:00");
  const before = generateCheckinSchedulePlan({ date: today, now, config });
  let plan = before;
  for (const [qq, expected] of [["40", "20:29"], ["50", "20:30"], ["60", "20:29"]]) {
    const result = addLateCheckinScheduleProfile(plan, profile(qq!), { now: atEnd, config });
    if (!("entry" in result)) throw new Error(result.reason);
    expect(result.entry.time).toBe(expected!);
    plan = result.plan;
  }
  expect(plan.entries.map(entry => [entry.time, entry.qq])).toEqual([["20:29", "40"], ["20:29", "60"], ["20:30", "50"]]);
  expect(before.entries).toEqual([]);
  expect(addLateCheckinScheduleProfile(plan, profile("40"), { now: atEnd, config })).toEqual({ plan, reason: "entry_exists" });
  expect(addLateCheckinScheduleProfile(plan, profile("70"), { now: pastEnd, config })).toEqual({ plan, reason: "late_window_expired" });
  const context = { now: pastEnd, config, profiles: [profile("70"), profile("80", { schedule: { mode: "fixed", fixedTime: "07:18" } })] };
  expect(reconcileCheckinSchedulePlan(before, context).entries).toEqual([entry("80", { time: "07:18" })]);
  expect(addLateCheckinScheduleProfile(generateCheckinSchedulePlan({ now, config }), profile("70"), { now: pastEnd, config })).toMatchObject({
    entry: { qq: "70", time: "20:29", mode: "late_random" },
    plan: { date: tomorrow },
  });
  expect(addLateCheckinScheduleProfile(null, profile("70"), { now: atEnd, config })).toEqual({ plan: null, reason: "plan_not_found" });
  expect(addLateCheckinScheduleProfile(before, profile("70", { enabled: false }), { now: atEnd, config }).reason).toBe("profile_disabled");
  expect(addLateCheckinScheduleProfile(before, profile("70"), {
    now: atEnd, config: { ...config, late_registration: { enable: false } },
  }).reason).toBe("late_registration_disabled");
});

test("读取旧 v1 时补必要缺省值，重复记录选已完成或在途，保留原字段", () => {
  const before = generateCheckinSchedulePlan({ now });
  const retry = { forums: ["6"], nextAt: "2026-11-19T12:00:00.000Z", attempts: 2, otherFailure: false, initialMessage: "旧回执" };
  const planned = entry("101");
  const running = entry("101", { runningAt: stamp, notified: true });
  const done = entry("102", { done: true, doneAt: stamp, ok: false, stage: "checkin", message: "旧提醒" });
  const late = { ...entry("103", { mode: "late_random", late: true, lateRegisteredAt: stamp, communityRetry: retry }),
    communityRetry: { ...retry, randomExtra: "舍弃" } };
  const parsed = parseCheckinSchedulePlan({
    ...before, arbitrary: "舍弃", window: { ...before.window, arbitrary: "舍弃" },
    entries: [planned, { ...running, arbitrary: "舍弃" }, { ...done, arbitrary: "舍弃" }, { ...done, done: false }, late,
      { qq: "104", time: "09:10", mode: "fixed" }],
  });
  expect(parsed).toEqual({ ...before,
    entries: [running, done, { ...late, communityRetry: retry }, entry("104", { time: "09:10" })] });
  expect(parseCheckinSchedulePlan(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  for (const invalid of [
    { ...before, version: 2 }, { ...before, generatedAt: "2026-02-29T02:00:00+08:00" },
    { ...before, entries: [{ ...planned, profileId: null }] },
    { ...before, entries: [{ ...planned, time: "23:60" }] },
    { ...before, entries: [{ ...running, runningAt: "" }] },
    { ...before, entries: [{ ...late, communityRetry: { ...retry, attempts: -1 } }] },
  ]) expect(() => parseCheckinSchedulePlan(invalid)).toThrow(TypeError);
});

test("v1 社区写入记录只接收已知分区与固定状态，旧计划保持兼容", () => {
  const before = generateCheckinSchedulePlan({ now });
  const writes = {
    "1": "pending", "2": "accepted", "3": "already", "4": "rejected", "5": "blocked",
    "6": "unconfirmed", "8": "pending", "9": "accepted", "10": "already",
  } as const satisfies Readonly<Record<string, CheckinCommunityWriteStatus>>;
  const old = entry("50");
  const wrote = entry("51", { communityWrites: writes });
  const plan = { ...before, entries: [old, wrote] };
  expect(parseCheckinSchedulePlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
  expect(parseCheckinSchedulePlan({ ...before, entries: [entry("51", { notified: true }), wrote] }).entries).toEqual([wrote]);
  expect(parseCheckinSchedulePlan({ ...before, entries: [entry("52", { communityWrites: {} })] }).entries[0]?.communityWrites)
    .toEqual({});
  for (const invalid of [
    null, [], "pending", new Map([["2", "pending"]]), { "2": { status: "pending" } },
    { "2": "上游错误" }, { "2": "PENDING" }, { "2": 1 }, { "2": undefined },
    { "7": "accepted" }, { "02": "pending" }, { ...writes, "11": "pending" },
    JSON.parse('{"__proto__":"pending"}'), { [Symbol("2")]: "pending" },
  ]) {
    expect(() => parseCheckinSchedulePlan({ ...before, entries: [{ ...wrote, communityWrites: invalid }] })).toThrow(TypeError);
  }
});

test("清除在途标记后，社区写入记录保留原时段、通知状态和关闭档案的恢复证据", () => {
  const active = entry("51", { time: "06:00", notified: true, communityWrites: { "2": "pending", "6": "accepted" } });
  const disabled = entry("52", { time: "06:05", noticeAttemptedAt: stamp, communityWrites: { "1": "unconfirmed" } });
  const removed = entry("53", { time: "06:10", communityWrites: { "8": "already" } });
  const before = { ...generateCheckinSchedulePlan({ now, date: today }), entries: [active, disabled, removed] };
  const config = { mode: "random", random: { window_start: "08:00", window_end: "10:00" } } as const;
  const profiles = [profile("51"), profile("52", { enabled: false })];
  const random = () => { throw new Error("恢复记录不应重新分配时段"); };
  const after = reconcileCheckinSchedulePlan(parseCheckinSchedulePlan(before), { now, config, profiles, random });
  expect(after.entries).toEqual([active, disabled, removed]);
  expect(after.generatedAt).toBe(before.generatedAt);
  expect(reconcileCheckinSchedulePlan(after, {
    now, profiles: [profile("51", { schedule: { mode: "fixed", fixedTime: "05:00" } })],
  }).entries).toEqual([active, disabled, removed]);
});
