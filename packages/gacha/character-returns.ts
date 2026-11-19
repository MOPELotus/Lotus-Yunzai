import {
  featuredChance, fiveStarChance, resolveGachaExpectationRequest, type GachaExpectationPool, type GachaExpectationRequest,
} from "./expectation-model.ts";

const rewardModels = {
  "genshin-character": { fourBase: 0.051, fourCharacters: 39, fourCharacterShare: 39 / (39 + 18), fiveCharacters: 7, scale: 1, firstFeaturedReward: 10 },
  "hsr-character": { fourBase: 0.051, fourCharacters: 22, fourCharacterShare: 22 / (22 + 29), fiveCharacters: 7, scale: 4, firstFeaturedReward: 10 },
  "zzz-character": { fourBase: 0.094, fourCharacters: 12, fourCharacterShare: 7.05 / (7.05 + 2.35), fiveCharacters: 6, scale: 4, firstFeaturedReward: 0 },
} as const;

export type GachaCharacterPool = Extract<GachaExpectationPool, `${string}-character`>;

export interface GachaCharacterReturnRequest extends GachaExpectationRequest {
  readonly pool: GachaCharacterPool;
  readonly up4C6?: boolean;
}

export interface GachaCharacterReturnStatistics {
  readonly mean: number;
  readonly p25: number;
  readonly p50: number;
  readonly p75: number;
  readonly p90: number;
  readonly p95: number;
}

interface SimulationOptions {
  readonly signal?: AbortSignal;
  /** Independent uniform samples from [0, 1). */
  readonly random?: () => number;
}

export class GachaReturnSimulationBusyError extends Error {
  constructor() {
    super("A character return simulation is already running");
    this.name = "GachaReturnSimulationBusyError";
  }
}

const maximumSamples = 50_000;
const maximumPullsPerSimulation = 9_000_000;
const maximumPullsPerBatch = 18_000;
let simulationRunning = false;

function duplicateReward(count: number, normal: number, full: number): number {
  return count === 1 ? 0 : count <= 7 ? normal : full;
}

function samplePercentile(samples: Uint32Array, proportion: number): number {
  const rank = (samples.length - 1) * proportion;
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  return samples[lower]! + (samples[upper]! - samples[lower]!) * (rank - lower);
}

/** Samples character-pool currency rewards under the legacy calculator's collection assumptions. */
export async function sampleGachaCharacterReturns(
  request: GachaCharacterReturnRequest, { signal, random = Math.random }: SimulationOptions = {},
): Promise<GachaCharacterReturnStatistics> {
  signal?.throwIfAborted();
  if (!Object.hasOwn(rewardModels, request.pool)) throw new RangeError("a character pool is required");
  const model = rewardModels[request.pool];
  const initial = resolveGachaExpectationRequest(request);
  if (simulationRunning) throw new GachaReturnSimulationBusyError();
  simulationRunning = true;
  try {
    // Each target can take at most two five-star cycles.
    const pullLimit = initial.pool.hard * 2 * initial.copies;
    const sampleCount = Math.min(maximumSamples, Math.floor(maximumPullsPerSimulation / pullLimit));
    const batchSize = Math.max(1, Math.floor(maximumPullsPerBatch / pullLimit));
    const samples = new Uint32Array(sampleCount);
    const fiveChances = Array.from({ length: initial.pool.hard + 1 }, (_, pull) => fiveStarChance(initial.pool, pull));
    const standardFour = new Uint16Array(model.fourCharacters);
    const standardFive = new Uint16Array(model.fiveCharacters);
    const featuredFourReward = request.up4C6 ? 5 : 2;
    let total = 0;
    for (let i = 0; i < sampleCount; i++) {
      if (i > 0 && i % batchSize === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        signal?.throwIfAborted();
      }
      standardFour.fill(0);
      standardFive.fill(0);
      let pity = initial.pity, guaranteed = initial.guaranteed, radiance = initial.radiance;
      let fourPity = 0, fourGuaranteed = false;
      let copies = 0, rewards = 0;
      while (copies < initial.copies) {
        const fiveChance = fiveChances[++pity]!;
        fourPity++;
        // Use disjoint intervals for five- and four-star results.
        const roll = random();
        if (fiveChance === 1 || roll < fiveChance) {
          pity = fourPity = 0;
          const winChance = featuredChance(initial.pool, guaranteed, radiance);
          if (winChance === 1 || random() < winChance) {
            copies++;
            rewards += copies === 1 ? model.firstFeaturedReward : duplicateReward(copies, 10, 25);
            if (!guaranteed) radiance = 0;
            guaranteed = false;
          } else {
            const character = Math.floor(random() * model.fiveCharacters);
            const count = standardFive[character]! + 1;
            standardFive[character] = count;
            rewards += duplicateReward(count, 10, 25);
            guaranteed = true;
            if (initial.tracksRadiance) radiance++;
          }
        } else if (fourPity >= 10 || roll < fiveChance + model.fourBase) {
          fourPity = 0;
          if (fourGuaranteed || random() < 0.5) {
            fourGuaranteed = false;
            rewards += featuredFourReward;
          } else {
            fourGuaranteed = true;
            if (random() < model.fourCharacterShare) {
              const character = Math.floor(random() * model.fourCharacters);
              const count = standardFour[character]! + 1;
              standardFour[character] = count;
              rewards += duplicateReward(count, 2, 5);
            } else {
              rewards += 2;
            }
          }
        }
      }
      samples[i] = rewards * model.scale;
      total += samples[i]!;
    }
    signal?.throwIfAborted();
    samples.sort();
    return {
      mean: total / sampleCount,
      p25: samplePercentile(samples, 0.25),
      p50: samplePercentile(samples, 0.5),
      p75: samplePercentile(samples, 0.75),
      p90: samplePercentile(samples, 0.9),
      p95: samplePercentile(samples, 0.95),
    };
  } finally {
    simulationRunning = false;
  }
}
