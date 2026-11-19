import { expect, test } from "bun:test";
import {
  GachaReturnSimulationBusyError, sampleGachaCharacterReturns, type GachaCharacterReturnRequest,
} from "../packages/gacha/character-returns.ts";

function uniformSamples(seed: number): () => number {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

test("keeps the six growth rewards and the additional duplicate tier for all three pools", async () => {
  const random = () => 0;
  for (const [pool, first, eight] of [
    ["genshin-character", 10, 95], ["hsr-character", 40, 380], ["zzz-character", 0, 340],
  ] as const) {
    const single = await sampleGachaCharacterReturns({ pool, pity: 89, guaranteed: true }, { random });
    expect(single).toEqual({ mean: first, p25: first, p50: first, p75: first, p90: first, p95: first });
    const repeated = await sampleGachaCharacterReturns({ pool, copies: 8 }, { random });
    expect(repeated.mean).toBe(eight);
  }
});

test("preserves the four-star featured guarantee across a five-star", async () => {
  // Off-banner four-star character, guaranteed first five-star, guaranteed featured four-star, and second five-star.
  const rolls = [0.98, 0.99, 0.01, 0.1, 0, 0.03, 0, 0];
  let index = 0;
  const request = { pool: "genshin-character", copies: 2, pity: 88, guaranteed: true, up4C6: true } as const;
  const result = await sampleGachaCharacterReturns(request, { random: () => rolls[index++ % rolls.length]! });
  expect(result.mean).toBe(25);
});

test("applies off-banner duplicate returns and radiance at repeated hard pity", async () => {
  // Each legacy model's reward when its RNG returns 0.99 on every call.
  for (const [pool, reward] of [
    ["genshin-character", 397], ["hsr-character", 1872], ["zzz-character", 1960],
  ] as const) {
    const result = await sampleGachaCharacterReturns({ pool, copies: 8 }, { random: () => 0.99 });
    expect(result.mean).toBe(reward);
  }
});

test("is consistent with offline simulations of the deployed reward model", async () => {
  // Reference was sampled from revision 187700f with 18,000 trials per case and seeds 2164 to 2166.
  const cases: Array<[GachaCharacterReturnRequest, number, number, number, number, number]> = [
    [{ pool: "genshin-character", copies: 2, pity: 36, guaranteed: true, radiance: 2 }, 43.6876667, 38, 42, 50, 2],
    [{ pool: "hsr-character", pity: 20, up4C6: true }, 169.5986667, 120, 148, 228, 8],
    [{ pool: "zzz-character", copies: 2, pity: 20 }, 201.4026667, 152, 200, 240, 8],
  ];
  for (const [index, [request, mean, p25, p50, p75, tolerance]] of cases.entries()) {
    const result = await sampleGachaCharacterReturns(request, { random: uniformSamples(2477 + index) });
    expect(Math.abs(result.mean - mean)).toBeLessThan(tolerance / 2);
    expect(Math.abs(result.p25 - p25)).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(result.p50 - p50)).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(result.p75 - p75)).toBeLessThanOrEqual(tolerance);
    expect(result.p90).toBeGreaterThanOrEqual(result.p75);
    expect(result.p95).toBeGreaterThanOrEqual(result.p90);
  }
});

test("yields to the host, cancels active work and releases its slot", async () => {
  const request = { pool: "genshin-character", copies: 20 } as const;
  const controller = new AbortController();
  const reason = new Error("gateway disconnected");
  let rolls = 0;
  const result = sampleGachaCharacterReturns(request, {
    signal: controller.signal, random: () => { rolls++; return 0.99; },
  });
  expect(rolls).toBeGreaterThan(0);
  await expect(sampleGachaCharacterReturns(request)).rejects.toBeInstanceOf(GachaReturnSimulationBusyError);
  setImmediate(() => controller.abort(reason));
  await expect(result).rejects.toBe(reason);
  expect(rolls).toBeLessThan(100_000);
  await expect(sampleGachaCharacterReturns(request, { signal: controller.signal })).rejects.toBe(reason);
  expect((await sampleGachaCharacterReturns(request, { random: () => 0 })).mean).toBe(395);
});

test("rejects incompatible pools and out-of-range quantities", async () => {
  await expect(sampleGachaCharacterReturns({ pool: "hsr-lightcone" as "hsr-character" })).rejects.toBeInstanceOf(RangeError);
  await expect(sampleGachaCharacterReturns({ pool: "zzz-character", copies: 21 })).rejects.toBeInstanceOf(RangeError);
});
