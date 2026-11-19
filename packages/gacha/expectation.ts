import { featuredChance, fiveStarChance, resolveGachaExpectationRequest, type GachaExpectationRequest, type Pool } from "./expectation-model.ts";

export { maxGachaExpectationCopies, type GachaExpectationPool, type GachaExpectationRequest } from "./expectation-model.ts";

export interface GachaPullStatistics {
  readonly mean: number;
  readonly p25: number;
  readonly p50: number;
  readonly p75: number;
  readonly p90: number;
  readonly p95: number;
  /** Probability from 0 to 1, including results that use the entire budget. */
  readonly budgetChance?: number;
}

function fiveStarDistance(pool: Pool, pity: number): Float64Array {
  const probabilities = new Float64Array(pool.hard - pity + 1);
  let remaining = 1;
  for (let pull = pity + 1; pull <= pool.hard; pull++) {
    const chance = fiveStarChance(pool, pull);
    probabilities[pull - pity] = remaining * chance;
    if (chance === 1) return probabilities.subarray(0, pull - pity + 1);
    remaining *= 1 - chance;
  }
  return probabilities;
}

function addConvolution(
  destination: Float64Array, left: Float64Array, right: Float64Array, weight: number,
): void {
  for (let i = 0; i < left.length; i++) {
    const coefficient = left[i]! * weight;
    if (coefficient === 0) continue;
    for (let j = 0; j < right.length; j++) {
      destination[i + j] = destination[i + j]! + coefficient * right[j]!;
    }
  }
}

function afterOffBanner(first: Float64Array, fresh: Float64Array): Float64Array {
  const result = new Float64Array(first.length + fresh.length - 1);
  addConvolution(result, first, fresh, 1);
  return result;
}

const quantileLevels = [0.25, 0.5, 0.75, 0.9, 0.95] as const;

function summarize(probabilities: Float64Array, budget: number | undefined): GachaPullStatistics {
  let mean = 0, cumulative = 0, budgetMass = 0;
  const quantiles: number[] = [];
  for (let pulls = 0; pulls < probabilities.length; pulls++) {
    const mass = probabilities[pulls]!;
    cumulative += mass;
    mean += pulls * mass;
    if (budget !== undefined && pulls <= budget) budgetMass += mass;
  }

  let cumulativeShare = 0;
  for (let pulls = 0; pulls < probabilities.length && quantiles.length < quantileLevels.length; pulls++) {
    cumulativeShare += probabilities[pulls]! / cumulative;
    while (quantiles.length < quantileLevels.length && cumulativeShare + 1e-12 >= quantileLevels[quantiles.length]!) {
      quantiles.push(pulls);
    }
  }
  const [p25, p50, p75, p90, p95] = quantiles;
  return {
    mean: mean / cumulative, p25: p25!, p50: p50!, p75: p75!, p90: p90!, p95: p95!,
    ...(budget === undefined ? {} : { budgetChance: budgetMass / cumulative }),
  };
}

/**
 * Featured-copy model calibrated against the six pools in Xt-0's
 * mihoyo-gacha-calculator, revision 187700f. These rates model the legacy estimator.
 */
export function calculateGachaPulls(request: GachaExpectationRequest): GachaPullStatistics {
  const { pool, copies, pity, guaranteed, radiance, tracksRadiance, budget } = resolveGachaExpectationRequest(request);
  const radianceStates = tracksRadiance ? 4 : 1;

  const first = fiveStarDistance(pool, pity);
  const fresh = pity === 0 ? first : fiveStarDistance(pool, 0);
  const firstWithLoss = afterOffBanner(first, fresh);
  const freshWithLoss = pity === 0 ? firstWithLoss : afterOffBanner(fresh, fresh);
  let states: Array<Float64Array | undefined> = Array(radianceStates);
  states[radiance] = Float64Array.of(1);
  for (let copy = 0; copy < copies; copy++) {
    const next: Array<Float64Array | undefined> = Array(radianceStates);
    const direct = copy === 0 ? first : fresh;
    const afterLoss = copy === 0 ? firstWithLoss : freshWithLoss;
    const isGuaranteed = copy === 0 && guaranteed;
    const length = (firstWithLoss.length - 1) + copy * (freshWithLoss.length - 1) + 1;
    for (let counter = 0; counter < radianceStates; counter++) {
      const from = states[counter];
      if (!from) continue;
      const winChance = featuredChance(pool, isGuaranteed, counter);
      const onWin = isGuaranteed ? counter : 0;
      addConvolution(next[onWin] ??= new Float64Array(length), from, direct, winChance);
      if (winChance < 1) {
        // An off-banner five-star guarantees the next five-star. That guarantee preserves radiance.
        const onLoss = tracksRadiance ? counter + 1 : 0;
        addConvolution(next[onLoss] ??= new Float64Array(length), from, afterLoss, 1 - winChance);
      }
    }
    states = next;
  }

  const probabilities = new Float64Array((firstWithLoss.length - 1) + (copies - 1) * (freshWithLoss.length - 1) + 1);
  for (const state of states) {
    if (!state) continue;
    for (let pulls = 0; pulls < state.length; pulls++) probabilities[pulls] = probabilities[pulls]! + state[pulls]!;
  }
  return summarize(probabilities, budget);
}
