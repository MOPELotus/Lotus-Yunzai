import type { BbsMissionState } from "@lotus-yunzai/hoyo-client";

const interactions = [
  { missionId: 59, label: "阅读帖子" },
  { missionId: 60, label: "点赞帖子" },
  { missionId: 61, label: "分享帖子" },
] as const;

export type BbsInteractionProgress = typeof interactions[number] & {
  readonly happenedTimes?: number;
  readonly threshold?: number;
  readonly isGetAward?: boolean;
};

export function bbsInteractionProgress(state: BbsMissionState): readonly BbsInteractionProgress[] {
  const result: BbsInteractionProgress[] = [];
  for (const interaction of interactions) {
    const mission = state.states.find(({ missionId }) => missionId === interaction.missionId);
    if (!mission) continue;
    const { happenedTimes, threshold, isGetAward } = mission;
    result.push({
      ...interaction,
      ...(happenedTimes !== undefined && { happenedTimes }),
      ...(threshold !== undefined && { threshold }),
      ...(isGetAward !== undefined && { isGetAward }),
    });
  }
  return result;
}
