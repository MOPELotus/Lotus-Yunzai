const pools = {
  "genshin-character": { base: 0.006, soft: 74, step: 0.06, hard: 90, featured: 0.50009 },
  "genshin-weapon": { base: 0.007, soft: 64, step: 0.07, hard: 80, featured: 0.375 },
  "hsr-character": { base: 0.006, soft: 74, step: 0.06, hard: 90, featured: 0.5625 },
  "hsr-lightcone": { base: 0.008, soft: 66, step: 0.08, hard: 80, featured: 0.75 },
  "zzz-character": { base: 0.006, soft: 74, step: 0.06, hard: 90, featured: 0.5 },
  "zzz-weapon": { base: 0.01, soft: 65, step: 0.061875, hard: 80, featured: 0.75 },
} as const;

export type GachaExpectationPool = keyof typeof pools;
export type Pool = (typeof pools)[GachaExpectationPool];

export const maxGachaExpectationCopies = 20;

export interface GachaExpectationRequest {
  readonly pool: GachaExpectationPool;
  readonly copies?: number;
  readonly pity?: number;
  readonly guaranteed?: boolean;
  readonly radiance?: number;
  readonly fate?: number;
  readonly budget?: number;
}

function requireIntegerInRange(value: number, minimum: number, maximum: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
}

export function resolveGachaExpectationRequest({
  pool: poolName, copies = 1, pity = 0, guaranteed = false, radiance = 0, fate = 0, budget,
}: GachaExpectationRequest) {
  if (!Object.hasOwn(pools, poolName)) throw new RangeError("unknown gacha pool");
  const pool = pools[poolName];
  const tracksRadiance = poolName === "genshin-character";
  requireIntegerInRange(copies, 1, maxGachaExpectationCopies, "copies");
  requireIntegerInRange(pity, 0, pool.hard - 1, "pity");
  requireIntegerInRange(radiance, 0, tracksRadiance ? 3 : 0, "radiance");
  requireIntegerInRange(fate, 0, poolName === "genshin-weapon" ? 1 : 0, "fate");
  if (budget !== undefined) requireIntegerInRange(budget, 0, Number.MAX_SAFE_INTEGER, "budget");
  return { pool, copies, pity, guaranteed: guaranteed || fate > 0, radiance, tracksRadiance, budget };
}

export function fiveStarChance(pool: Pool, pull: number): number {
  // The legacy weapon and light-cone ramps reach certainty before their nominal hard pity.
  return pull === pool.hard ? 1 : Math.min(1, pool.base + Math.max(0, pull - pool.soft + 1) * pool.step);
}

export function featuredChance(pool: Pool, guaranteed: boolean, radiance: number): number {
  return guaranteed || radiance === 3 ? 1 : pool.featured;
}
