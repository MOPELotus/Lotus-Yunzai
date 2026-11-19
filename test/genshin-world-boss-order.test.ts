import { expect, test } from "bun:test";
import { orderWorldBossGroups } from "../plugins/genshin/world-boss.ts";

test("世界 BOSS 复用旧地区排序并去掉旧子地区，新地区和组内首领保留上游相对顺序", () => {
  const bosses = [{ name: "无相之雷", killCount: 0 }, { name: "急冻树", killCount: 12 }];
  const response = ["须弥", "挪德卡莱", "蒙德", "来歆山", "新地区", "旧日之海", "璃月"].map((name) => ({ name, bosses }));
  expect(orderWorldBossGroups(response).map(({ name }) => name)).toEqual(["挪德卡莱", "新地区", "蒙德", "璃月", "须弥"]);
  expect(orderWorldBossGroups(response)[2]?.bosses).toEqual(bosses);
  expect(response[0]?.name).toBe("须弥");
});
