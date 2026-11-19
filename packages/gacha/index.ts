export interface GachaProbability {
  readonly base: number;
  readonly soft: number;
  readonly step: number;
  readonly hard: number;
  readonly upRate: number;
}

interface GachaGuaranteeRow {
  readonly isUp?: boolean;
  isBig?: true;
}

export interface GachaGuarantees {
  smallNum: number;
  smallWin: number;
  bigNum: number;
  maxUpStreak: number;
  maxWaiStreak: number;
  noWaiRate: string | 0;
}

export interface GachaLuck extends GachaGuarantees {
  readonly min: number;
  readonly title: string;
  readonly desc: string;
  readonly color: string;
  readonly isUpPool: boolean;
  readonly fiveAvg: string;
  readonly fiveExpect: string;
  readonly fivePercent: string;
  readonly upAvg?: string;
  readonly upExpect?: string;
  readonly upRate?: number;
  readonly winPercent?: string | false;
  readonly percent: string;
  readonly fewSample: boolean;
  readonly hasNewPool: boolean;
}

const luckLevels = [
  { min: 99, title: "天运所归", desc: "天选之人，建议去买彩票", color: "#ff7a1f" },
  { min: 95, title: "终极欧皇", desc: "金光常伴左右", color: "#ff9f1f" },
  { min: 85, title: "大欧皇", desc: "运气远超常人", color: "#f5b72a" },
  { min: 70, title: "小欧皇", desc: "运气明显好于平均", color: "#e4c46a" },
  { min: 55, title: "小有运气", desc: "运气略好于平均", color: "#c9cf8a" },
  { min: 45, title: "平民", desc: "和理论期望相当", color: "#a8c1d8" },
  { min: 25, title: "小非酋", desc: "运气略差于平均", color: "#8f9bd6" },
  { min: 8, title: "大非酋", desc: "保底常客", color: "#9a76d8" },
  { min: 0, title: "终极非酋", desc: "抱抱，下次一定出金", color: "#b0526a" },
] as const;

function convolution(a: readonly number[], b: readonly number[], limit: number): number[] {
  const output = Array<number>(Math.min(a.length + b.length - 1, limit + 1)).fill(0);
  for (let left = 0; left < a.length && left <= limit; left++) {
    if (!a[left]) continue;
    for (let right = 0; right < b.length && left + right <= limit; right++) {
      output[left + right]! += a[left]! * b[right]!;
    }
  }
  return output;
}

function starDistribution({ base, soft, step, hard }: GachaProbability): number[] {
  const probability = [0];
  let survive = 1;
  for (let pull = 1; pull <= hard; pull++) {
    const chance = pull === hard ? 1 : Math.min(1, base + Math.max(0, pull - soft + 1) * step);
    probability.push(survive * chance);
    survive *= 1 - chance;
  }
  return probability;
}

function mean(distribution: readonly number[]): number {
  return distribution.reduce((sum, probability, count) => sum + count * probability, 0);
}

function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const density = 0.3989422804014327 * Math.exp(-z * z / 2);
  const tail = density * t *
    (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - tail : tail;
}

function boundedPercent(p: number): number {
  return Math.min(100, Math.max(0, p * 100));
}

function luckPercent(distribution: readonly number[], goals: number, used: number): number {
  if (goals > 50) {
    const expected = mean(distribution);
    const variance = distribution.reduce((sum, probability, count) => sum + probability * (count - expected) ** 2, 0);
    return boundedPercent(1 - normalCdf((used - goals * expected) / Math.sqrt(goals * variance)));
  }
  let total = [1];
  for (let i = 0; i < goals; i++) total = convolution(total, distribution, used);
  const below = total.slice(0, used).reduce((sum, probability) => sum + probability, 0);
  return boundedPercent(1 - below - (total[used] ?? 0) / 2);
}

function winPercent(attempts: number, wins: number, upRate: number): string | false {
  if (!attempts) return false;
  if (attempts > 1024) {
    const expected = attempts * upRate;
    return boundedPercent(normalCdf((wins - expected) / Math.sqrt(expected * (1 - upRate)))).toFixed(1);
  }
  let combination = 1;
  let below = 0;
  for (let k = 0; k <= wins; k++) {
    if (k) combination *= (attempts - k + 1) / k;
    below += combination * upRate ** k * (1 - upRate) ** (attempts - k) * (k === wins ? 0.5 : 1);
  }
  return boundedPercent(below).toFixed(1);
}

export function applyGachaGuarantees(fiveLog: readonly GachaGuaranteeRow[], initialGuaranteed: boolean | null = false): GachaGuarantees {
  let guaranteed: boolean | undefined = initialGuaranteed ?? undefined;
  let smallNum = 0, smallWin = 0, bigNum = 0, maxUpStreak = 0, maxWaiStreak = 0;
  let wins = 0, losses = 0;
  for (const row of [...fiveLog].reverse()) {
    if (guaranteed === true) {
      row.isBig = true;
      bigNum++;
    } else if (guaranteed === false && row.isUp !== undefined) {
      smallNum++;
      if (row.isUp) {
        smallWin++;
        wins++;
        losses = 0;
      } else {
        losses++;
        wins = 0;
      }
      maxUpStreak = Math.max(maxUpStreak, wins);
      maxWaiStreak = Math.max(maxWaiStreak, losses);
    } else {
      wins = losses = 0;
    }
    guaranteed = row.isUp === undefined ? undefined : !row.isUp;
  }
  return {
    smallNum, smallWin, bigNum, maxUpStreak, maxWaiStreak,
    noWaiRate: smallNum ? (smallWin * 100 / smallNum).toFixed(1) : 0,
  };
}

export function gachaLuckFor(
  model: GachaProbability, fiveNum: number, fiveUsed: number, upNum: number, upUsed: number,
  state: GachaGuarantees, hasNewPool: boolean,
): GachaLuck | undefined {
  if (!fiveNum || !fiveUsed) return;
  const { upRate, hard } = model;
  const fiveDistribution = starDistribution(model);
  const fivePercent = luckPercent(fiveDistribution, fiveNum, fiveUsed);
  const upDistribution = upRate && upNum > 0 && upUsed > 0
    ? convolution(fiveDistribution, fiveDistribution, hard * 2)
      .map((value, index) => (fiveDistribution[index] ?? 0) * upRate + value * (1 - upRate)) : undefined;
  const percent = upDistribution ? luckPercent(upDistribution, upNum, upUsed) : fivePercent;
  const level = luckLevels.find(({ min }) => percent >= min)!;
  return {
    ...level, ...state, isUpPool: !!upDistribution, percent: percent.toFixed(1), hasNewPool,
    fiveAvg: (fiveUsed / fiveNum).toFixed(1), fiveExpect: mean(fiveDistribution).toFixed(1),
    fivePercent: fivePercent.toFixed(1), fewSample: (upDistribution ? upNum : fiveNum) < 3,
    ...(upDistribution ? {
      upAvg: (upUsed / upNum).toFixed(1), upExpect: mean(upDistribution).toFixed(1), upRate: Math.round(upRate * 100),
      winPercent: winPercent(state.smallNum, state.smallWin, upRate),
    } : {}),
  };
}
