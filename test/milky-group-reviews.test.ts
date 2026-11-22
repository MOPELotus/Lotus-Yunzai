import { expect, test } from "bun:test";
import type { MilkyConfirmation } from "../lib/adapters/milky-api.ts";
import { createMilkyGroupReviews } from "../lib/adapters/milky-group-reviews.ts";

test("Milky 审核使用当前连接，结果未知后阻止再次提交", async () => {
  const reviews = createMilkyGroupReviews();
  const request = { self_id: 99, sub_type: "add", group_id: 42, user_id: 51, flag: "fixture" } as const;
  const decision = (allow: boolean) => ({
    action: allow ? "accept_group_request" : "reject_group_request", params: { group_id: 42, notification_seq: 1 },
  });
  expect(reviews.register(request, decision)).toBe(true);

  const pending = Promise.withResolvers<MilkyConfirmation>();
  const attempts: unknown[] = [];
  const invoke = (action: string, params: Record<string, unknown>) => {
    attempts.push({ action, params });
    return pending.promise;
  };
  const review = reviews.review(99, request.flag, "add", true, undefined, invoke);
  expect(reviews.register(request, decision)).toBe(false);
  expect(await reviews.review(98, request.flag, "add", true, undefined, invoke)).toBe(false);
  expect(await reviews.review(99, request.flag, "invite", true, undefined, invoke)).toBe(false);
  expect(await reviews.review(99, request.flag, "add", true, undefined, invoke)).toBe(false);
  pending.resolve({ status: "rejected" });
  expect(await review).toBe(false);

  await expect(reviews.review(99, request.flag, "add", true, undefined, async () => ({ status: "unknown" }))).rejects.toThrow("未确认");
  expect(reviews.register(request, decision)).toBe(false);
  await expect(reviews.review(99, request.flag, "add", true, undefined, invoke)).rejects.toThrow("未确认");
  expect(attempts).toEqual([decision(true)]);
});

test("批量群邀请只取当前连接实际观察的同账号待审邀请", () => {
  const reviews = createMilkyGroupReviews();
  const first = Symbol(), next = Symbol();
  const invite = { self_id: 99, sub_type: "invite", group_id: 42, user_id: 51, flag: "current" } as const;
  const decision = () => ({ action: "reject_group_invitation", params: {} });
  reviews.register(invite, decision, first);
  reviews.register({ ...invite, flag: "quoted" }, decision);
  reviews.register({ ...invite, flag: "other", self_id: 98 }, decision, first);
  reviews.register({ ...invite, flag: "join", sub_type: "add" }, decision, first);
  expect(reviews.observedInvitations(99, first).map(({ flag }) => flag)).toEqual(["current"]);
  expect(reviews.observedInvitations(99, next)).toEqual([]);
  expect(reviews.isObservedInvitationPending(99, "current", next)).toBe(false);

  reviews.register(invite, decision, next);
  expect(reviews.isObservedInvitationPending(99, "current", first)).toBe(false);
  expect(reviews.isObservedInvitationPending(99, "current", next)).toBe(true);
  expect(reviews.observedInvitations(99, next).map(({ flag }) => flag)).toEqual(["current"]);
});
