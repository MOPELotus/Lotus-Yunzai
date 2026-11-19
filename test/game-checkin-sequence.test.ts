import { expect, test } from "bun:test";
import { ProfileError } from "@lotus-yunzai/account";
import { GameRecordRequestError, HoyoRequestError } from "@lotus-yunzai/hoyo-client";
import { runGameCheckinSequence } from "../lib/game-checkin-sequence.ts";

type Sequence = Parameters<typeof runGameCheckinSequence>[0];
type Info = Awaited<ReturnType<Sequence["readInfo"]>>;
type Submission = Awaited<ReturnType<Sequence["submit"]>>;
const unsigned = { signed: false, firstBind: false, totalSignDays: 7 };
const signed = { signed: true, firstBind: false, totalSignDays: 8 };

function fixture(info: (Info | Error)[], confirmation: Submission | Error = "accepted", overrides: Partial<Sequence> = {}) {
  const calls: string[] = [];
  return {
    calls,
    run: () => runGameCheckinSequence({
      async readInfo() {
        calls.push("info");
        const result = info.shift();
        if (result instanceof Error) throw result;
        if (!result) throw new Error("unexpected extra status read");
        return result;
      },
      async submit() {
        calls.push("submit");
        if (confirmation instanceof Error) throw confirmation;
        return confirmation;
      },
      async verifyCurrent() { calls.push("verify"); },
      ...overrides,
    }),
  };
}

test("初次状态已签到或首绑时均不提交", async () => {
  const already = fixture([{ ...signed, totalSignDays: 0 }]);
  expect(await already.run()).toEqual({ status: "already", totalSignDays: 0 });
  expect(already.calls).toEqual(["verify", "info", "verify"]);
  const first = fixture([{ ...unsigned, firstBind: true }]);
  expect(await first.run()).toEqual({ status: "first-bind" });
  expect(first.calls).toEqual(["verify", "info", "verify"]);
});

test("提交受理和已签回执都只经同角色回读确认成功", async () => {
  for (const [ack, status] of [["accepted", "signed"], ["already", "already"]] as const) {
    const checkin = fixture([unsigned, signed], ack);
    expect(await checkin.run()).toEqual({ status, totalSignDays: 8 });
    expect(checkin.calls).toEqual(["verify", "info", "verify", "submit", "verify", "info", "verify"]);
    const unconfirmed = fixture([unsigned, unsigned], ack);
    expect(await unconfirmed.run()).toEqual({ status: "unconfirmed" });
    expect(unconfirmed.calls.filter((step) => step === "submit")).toHaveLength(1);
  }
  const readFailure = new HoyoRequestError("response", "confirmation failed");
  expect(await fixture([unsigned, readFailure], "accepted").run()).toEqual({ status: "unconfirmed", error: readFailure });
});

test("传输错误、响应畸形或服务端状态不明只允许一趟确认读取", async () => {
  for (const error of [
    new HoyoRequestError("transport", "connection ended"),
    new HoyoRequestError("response", "bad acknowledgement"),
    new HoyoRequestError("http", "timeout", 408),
    new HoyoRequestError("http", "upstream bad gateway", 502),
  ]) {
    const confirmed = fixture([unsigned, signed], error);
    expect(await confirmed.run()).toEqual({ status: "signed", totalSignDays: 8 });
    expect(confirmed.calls.filter((step) => step !== "verify")).toEqual(["info", "submit", "info"]);
    const unconfirmed = fixture([unsigned, unsigned], error);
    expect(await unconfirmed.run()).toEqual({ status: "unconfirmed", error });
    expect(unconfirmed.calls.filter((step) => step !== "verify")).toEqual(["info", "submit", "info"]);
  }
});

test("验证、限频、过期和明确拒绝不追加确认，初读失败不提交", async () => {
  for (const error of [
    new GameRecordRequestError("签到", "risk", "http", 503),
    new GameRecordRequestError("签到", "rate-limited", "http", 429),
    new GameRecordRequestError("签到", "expired", "api", 200, -100),
    new HoyoRequestError("api", "rejected", 200, 1008),
    new HoyoRequestError("http", "forbidden", 403),
  ]) {
    const rejected = fixture([unsigned], error);
    expect(await rejected.run()).toEqual({ status: "failed", error });
    expect(rejected.calls.filter((step) => step !== "verify")).toEqual(["info", "submit"]);
    const neverSent = fixture([error]);
    expect(await neverSent.run()).toEqual({ status: "failed", error });
    expect(neverSent.calls.filter((step) => step !== "verify")).toEqual(["info"]);
  }
});

test("换绑及取消在初读、提交、确认任一阶段传播并停止剩余请求", async () => {
  const changed = new ProfileError("changed", "档案已变更");
  for (const [guard, requests] of [[1, []], [2, ["info"]], [3, ["info", "submit"]], [4, ["info", "submit", "info"]]] as const) {
    let verifies = 0;
    const checkin = fixture([unsigned, signed], "accepted", {
      async verifyCurrent() {
        if (++verifies === guard) throw changed;
      },
    });
    await expect(checkin.run()).rejects.toBe(changed);
    expect(checkin.calls).toEqual([...requests]);
  }
  const requestChanged = new HoyoRequestError("profile-changed", "角色已变更");
  await expect(fixture([unsigned, requestChanged]).run()).rejects.toBe(requestChanged);

  const controller = new AbortController();
  const stopped = new Error("停机");
  const checkin = fixture([unsigned], "accepted", {
    signal: controller.signal,
    async submit() {
      controller.abort(stopped);
      throw new HoyoRequestError("transport", "request interrupted");
    },
  });
  await expect(checkin.run()).rejects.toBe(stopped);
  expect(checkin.calls).toEqual(["verify", "info", "verify"]);
  const before = fixture([], "accepted", { signal: controller.signal });
  await expect(before.run()).rejects.toBe(stopped);
  expect(before.calls).toEqual([]);
});
