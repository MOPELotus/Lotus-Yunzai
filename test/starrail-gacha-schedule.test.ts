import { expect, test } from "bun:test";
import { parseStarRailGachaSchedule, resolveStarRailDetailPool } from "../plugins/starrail/gacha-schedule.ts";

const source = `
export const poolNameSr = { 卡芙卡: '夜将不眠' }
export const poolDetailSr = [{
  version: '1.2',
  half: '下半',
  from: '2023-08-09 12:00:00',
  to: '2023-08-30 11:59:59',
  char5: ['卡芙卡'],
  weapon5: ['只需等待']
}, {
  version: '1.3',
  half: '上半',
  from: '2023-08-30 10:00:00',
  to: '2023-09-20 11:59:59',
  char5: ['丹恒•饮月'],
  weapon5: ['比阳光更明亮的']
}]
`;

test("旧星铁卡池日历静态读取，重叠时按原声明顺序，区分未知和新池", () => {
  const schedule = parseStarRailGachaSchedule(source);
  expect(schedule).toHaveLength(2);
  const resolve = resolveStarRailDetailPool(schedule);
  const pull = { uid: "100000002", id: "one", name: "卡芙卡", item_type: "角色",
    rank_type: "5", gacha_type: "11", time: "2023-08-09 13:00:00" } as const;
  expect(resolve(pull)).toEqual({ isUp: true, isNewPool: false });
  expect(resolve({ ...pull, name: "瓦尔特" })).toEqual({ isUp: false, isNewPool: false });
  expect(resolve({ ...pull, time: "2023-08-30 11:00:00" })).toEqual({ isUp: true, isNewPool: false });
  expect(resolve({ ...pull, name: "只需等待", item_type: "光锥", gacha_type: "12" })).toEqual({ isUp: true, isNewPool: false });
  expect(resolve({ ...pull, gacha_type: "1" })).toBeUndefined();
  expect(resolve({ ...pull, time: "1970-01-01 00:00:00" })).toBeUndefined();
  expect(resolve({ ...pull, time: "2023-09-20T04:00:00Z" })).toEqual({ isNewPool: true });
});

test("旧卡池日历拒绝程序表达式、歧义键和格式错误的时间", () => {
  expect(parseStarRailGachaSchedule(source.replace("['卡芙卡']", "makeSchedule()"))).toEqual([]);
  expect(parseStarRailGachaSchedule(source.replace("version: '1.2',", "version: '1.2', version: '1.1',"))).toEqual([]);
  expect(parseStarRailGachaSchedule(source.replace("2023-08-09 12:00:00", "2023-13-08 12:00:00"))).toEqual([]);
});
