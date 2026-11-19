import { describe, expect, test } from "bun:test";
import {
  calculateGachaPulls, maxGachaExpectationCopies, type GachaExpectationRequest, type GachaExpectationPool,
} from "../packages/gacha/expectation.ts";

describe("featured gacha expectation", () => {
  // Offline reference means from revision 187700f, capping its five-star chances at 1.
  const initialMeans: Array<[GachaExpectationPool, number]> = [
    ["genshin-character", 93.4403912996],
    ["genshin-weapon", 87.551161508348],
    ["hsr-character", 89.5524148070],
    ["hsr-lightcone", 66.547594852425],
    ["zzz-character", 93.4459980594],
    ["zzz-weapon", 62.3180939493],
  ];
  for (const [pool, oldMean] of initialMeans) {
    test(`matches the legacy mean for ${pool}`, () => {
      expect(calculateGachaPulls({ pool }).mean).toBeCloseTo(oldMean, 8);
    });
  }

  const stateMeans: Array<[GachaExpectationRequest, number]> = [
    [{ pool: "genshin-character", copies: 2, pity: 36, guaranteed: true, radiance: 2 }, 130.489726374354],
    [{ pool: "genshin-character", copies: 7, pity: 73, radiance: 3 }, 557.5820101908],
    [{ pool: "genshin-weapon", pity: 50, fate: 1 }, 16.433715288329],
    [{ pool: "genshin-weapon", copies: 3, pity: 77 }, 209.775846673752],
    [{ pool: "hsr-character", copies: 6, pity: 36, guaranteed: true }, 484.811409109638],
    [{ pool: "hsr-lightcone", copies: 5, pity: 65 }, 283.541679077127],
    [{ pool: "zzz-character", copies: 7, pity: 74 }, 595.809583704814],
    [{ pool: "zzz-weapon", copies: 4, pity: 64 }, 204.011013357057],
  ];
  test("matches means for prior pity, guarantees, multiple copies, radiance and fate", () => {
    for (const [request, oldMean] of stateMeans) {
      expect(calculateGachaPulls(request).mean).toBeCloseTo(oldMean, 8);
    }
  });

  test("finds the earliest inclusive budget and integer quantile", () => {
    const request = { pool: "hsr-lightcone", pity: 77 } as const;
    const result = calculateGachaPulls({ ...request, budget: 1 });
    expect(result.budgetChance).toBeCloseTo(0.75, 12);
    expect(result.mean).toBeCloseTo(14.309518970485, 8);
    expect(result.p25).toBe(1);
    expect(result.p50).toBe(1);
    expect(result.p75).toBe(1);
    expect(result.p90).toBeGreaterThan(1);
    expect(result.p95).toBeGreaterThanOrEqual(result.p90);
    expect(calculateGachaPulls({ ...request, budget: 0 }).budgetChance).toBe(0);
    expect(calculateGachaPulls({ ...request, budget: 2 }).budgetChance).toBeCloseTo(0.752, 12);
    expect(calculateGachaPulls({ ...request, budget: 79 }).budgetChance).toBe(1);
  });

  test("handles a guaranteed immediate pull and the fraction exactly at a budget", () => {
    expect(calculateGachaPulls({ pool: "genshin-character", pity: 89, radiance: 3, budget: 1 })).toEqual({
      mean: 1, p25: 1, p50: 1, p75: 1, p90: 1, p95: 1, budgetChance: 1,
    });
    expect(calculateGachaPulls({ pool: "hsr-character", copies: 2, budget: 2 }).budgetChance)
      .toBeCloseTo((0.006 * 0.5625) ** 2, 14);
  });

  test("bounds chat work and refuses invalid states instead of indexing adjacent states", () => {
    const request = { pool: "genshin-character" } as const;
    for (const invalid of [
      { pity: 90 }, { pity: -1 }, { pity: 0.5 }, { copies: 0 }, { copies: maxGachaExpectationCopies + 1 },
      { copies: Infinity }, { radiance: 4 }, { fate: 1 }, { budget: -1 }, { budget: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(() => calculateGachaPulls({ ...request, ...invalid })).toThrow(RangeError);
    }
    expect(() => calculateGachaPulls({ pool: "hsr-character", radiance: 1 })).toThrow(RangeError);
    expect(() => calculateGachaPulls({ pool: "genshin-weapon", fate: 2 })).toThrow(RangeError);
    expect(calculateGachaPulls({ ...request, copies: maxGachaExpectationCopies, budget: 3600 }).budgetChance).toBe(1);
  });
});
