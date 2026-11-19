import { expect, test } from "bun:test";
import { bbsInteractionProgress } from "../lib/bbs-interaction-progress.ts";

test("只投影服务端本次返回的三项社区进度，保留零、明确奖态和官方阈值", () => {
  const state = { receivedPoints: 110, states: [
    { missionId: 61, happenedTimes: 1, isGetAward: true },
    { missionId: 58, happenedTimes: 1, threshold: 1, isGetAward: true },
    { missionId: 59, happenedTimes: 0, threshold: 2, isGetAward: false, continuousCycleTimes: 5 },
    { missionId: 60, threshold: 7 },
  ] };
  expect(bbsInteractionProgress(state)).toEqual([
    { missionId: 59, label: "阅读帖子", happenedTimes: 0, threshold: 2, isGetAward: false },
    { missionId: 60, label: "点赞帖子", threshold: 7 },
    { missionId: 61, label: "分享帖子", happenedTimes: 1, isGetAward: true },
  ]);
});

test("当天未返回的任务不补行，达到阈值也不推断奖励已领取", () => {
  expect(bbsInteractionProgress({ totalPoints: 200, states: [] })).toEqual([]);
  expect(bbsInteractionProgress({ states: [
    { missionId: 59, happenedTimes: 3, threshold: 3 },
    { missionId: 61 },
  ] })).toEqual([
    { missionId: 59, label: "阅读帖子", happenedTimes: 3, threshold: 3 },
    { missionId: 61, label: "分享帖子" },
  ]);
});
