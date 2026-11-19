import { buildStarRailLegacyRecords, type StarRailLegacyGachaRecord } from "./gacha-display.ts";

type ItemId = number | string;
type Face = { readonly name: string; readonly face?: string; readonly banner?: string };
type ResolvedItem = { readonly id: ItemId; readonly name: string; readonly abbr: string; readonly star?: number; readonly img?: string };
type Items = Record<string, {
  name: string; abbr: string; star: number; img?: string; type?: "char" | "weapon"; count?: number;
}>;

interface FiveStarDisplay {
  id: ItemId;
  count: number;
  date: string;
  isUp?: boolean;
  isBig?: true;
  isNewPool?: boolean;
}

type DecimalOrZero = string | 0;

interface GachaDetailStats {
  readonly allNum: number;
  readonly noFiveNum: number;
  readonly noFourNum: number;
  readonly fiveNum: number;
  readonly fourNum: number;
  readonly fiveAvg: DecimalOrZero;
  readonly fourAvg: DecimalOrZero;
  readonly wai: number;
  readonly isvalidNum: DecimalOrZero;
  readonly weaponNum: number;
  readonly weaponFourNum: number;
  readonly upYs: string;
}

interface Guarantees {
  smallNum: number;
  smallWin: number;
  bigNum: number;
  maxUpStreak: number;
  maxWaiStreak: number;
  noWaiRate: DecimalOrZero;
}

interface Luck extends Guarantees {
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

export interface StarRailGachaDetailModel {
  readonly uid: string;
  readonly face: Face;
  readonly poolName: "角色" | "光锥" | "常驻";
  readonly gacha: {
    readonly stat: GachaDetailStats;
    readonly items: Items;
    readonly fiveLog: readonly FiveStarDisplay[];
    readonly luck?: Luck;
    readonly maxFour: { readonly name: string; readonly count: number };
    readonly noWaiRate: DecimalOrZero;
    readonly shownNum?: number;
    readonly hiddenNum?: number;
  };
  readonly pageInfo?: { readonly page: number; readonly total: number; readonly from: number; readonly to: number; readonly count: number };
}

export type StarRailGachaDetailPool = keyof typeof detailPools;

export interface StarRailGachaDetailOptions {
  readonly uid: string;
  readonly history: unknown;
  readonly face: Face;
  readonly now?: Date;
  readonly resolveItem?: (record: StarRailLegacyGachaRecord) => ResolvedItem | undefined;
  readonly resolvePool?: (record: StarRailLegacyGachaRecord) => { isUp?: boolean; isNewPool?: boolean } | undefined;
  readonly pool?: StarRailGachaDetailPool;
  readonly maxRows?: number;
  readonly page?: number;
}

const pityItem = 888;
const unknownPull = 403;
const detailPools = {
  GachaType_AvatarUp: { legacy: 11, name: "角色", base: 0.006, soft: 74, step: 0.06, hard: 90, upRate: 0.5 },
  GachaType_EquipmentUp: { legacy: 12, name: "光锥", base: 0.008, soft: 66, step: 0.07, hard: 80, upRate: 0.75 },
  GachaType_Standard: { legacy: 1, name: "常驻", base: 0.006, soft: 74, step: 0.06, hard: 90, upRate: 0 },
} as const;
type PoolModel = typeof detailPools[StarRailGachaDetailPool];
const dateFormat = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit" });
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

function starDistribution({ base, soft, step, hard }: PoolModel): number[] {
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

function guarantees(fiveLog: readonly FiveStarDisplay[]): Guarantees {
  let guaranteed: boolean | undefined = false;
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

function luckFor(
  model: PoolModel, fiveNum: number, fiveUsed: number, upNum: number, upUsed: number,
  state: Guarantees, hasNewPool: boolean,
): Luck | undefined {
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

function countOnlyPity(history: unknown, pool: StarRailGachaDetailPool): number {
  const value = (history as { pools?: Partial<Record<StarRailGachaDetailPool, { pity?: unknown }>> })?.pools?.[pool]?.pity;
  // The legacy conversion has already checked the input; a missing pity field carries no known current count.
  return typeof value === "string" || typeof value === "number" ? Number(value) : 0;
}

function actualTime(raw: string): number {
  if (raw === "1970-01-01 00:00:00") return NaN;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(raw)
    ? `${raw.replace(" ", "T")}+08:00` : raw;
  return Date.parse(normalized);
}

function dateAt(time: number): string {
  return Number.isFinite(time) ? dateFormat.format(time).replace("/", "-") : "";
}

export function buildStarRailGachaDetail({
  uid, history, face, now = new Date(), resolveItem, resolvePool, pool = "GachaType_AvatarUp", maxRows = 30, page,
}: StarRailGachaDetailOptions): StarRailGachaDetailModel | undefined {
  if (!Number.isSafeInteger(maxRows) || maxRows < 0 || (page !== undefined && (!Number.isSafeInteger(page) || page < 1))) {
    throw new RangeError("星铁抽卡显示分页参数无效。");
  }
  const model = detailPools[pool];
  if (!model) throw new TypeError("星铁抽卡卡池没有对应的详情模板。");
  const records = buildStarRailLegacyRecords(uid, history)[model.legacy];
  if (!records.length) return;

  const items: Items = Object.create(null);
  const dated: { row: FiveStarDisplay; time: number }[] = [];
  let prefix = 0;
  let fillers = 0;
  for (const record of records) {
    if (record.rank_type === "3") {
      fillers++;
      const previous = dated.at(-1);
      if (previous) previous.row.count++;
      else prefix++;
      continue;
    }

    const metadata = resolveItem?.(record);
    const id = metadata && String(metadata.id) !== String(pityItem) && String(metadata.id) !== String(unknownPull)
      ? metadata.id : `${record.item_type}:${record.name}`;
    const item = items[String(id)] ??= {
      name: metadata?.name ?? record.name, abbr: metadata?.abbr ?? record.name,
      star: metadata?.star ?? 5, img: metadata?.img ?? "", count: 0,
      type: record.item_type === "角色" ? "char" : "weapon",
    };
    item.count!++;
    const version = resolvePool?.(record);
    const time = actualTime(record.time);
    dated.push({ time, row: {
      id, date: dateAt(time), count: 1, isUp: record.is_up ?? version?.isUp, isNewPool: version?.isNewPool ?? false,
    } });
  }

  if (fillers) items[unknownPull] = { type: "weapon", count: fillers, star: 3, name: "未知", abbr: "未知", img: "" };
  // Sort only official five-star timestamps. Fillers belong to their interval, without giving them a draw date.
  if (dated.every(({ time }) => Number.isFinite(time))) dated.sort((a, b) => b.time - a.time);
  const five = dated.map(({ row }) => row);
  const fiveNum = five.length;
  const allNum = records.length;
  const pity = fiveNum ? prefix : countOnlyPity(history, pool);
  const fiveUsed = allNum - pity;
  const wai = five.filter(({ isUp }) => isUp === false).length;
  const upNum = model.upRate && five.every(({ isUp }) => isUp !== undefined) ? fiveNum - wai : 0;
  const upUsed = upNum ? fiveUsed - (five[0]?.isUp === false ? five[0].count : 0) : 0;
  const isvalidNum = upNum ? (upUsed / upNum).toFixed(2) : 0;
  const upYs = Number(isvalidNum) * 160;
  const state = guarantees(model.upRate ? five : []);
  const luck = luckFor(model, fiveNum, fiveUsed, upNum, upUsed, state, five.some(({ isNewPool }) => isNewPool));

  const stat: GachaDetailStats = {
    allNum, noFiveNum: pity, fiveNum, fiveAvg: fiveNum ? (fiveUsed / fiveNum).toFixed(2) : 0,
    wai, isvalidNum, upYs: upYs >= 10_000 ? `${(upYs / 10_000).toFixed(2)}w` : upYs.toFixed(0),
    noFourNum: 0, fourNum: 0, fourAvg: 0, weaponNum: 0, weaponFourNum: 0,
  };
  const currentPity: FiveStarDisplay[] = [];
  if (pity) {
    items[pityItem] = { name: "已抽", abbr: "已抽", star: 5, img: "gacha/imgs/no-avatar.webp" };
    currentPity.push({ id: pityItem, isUp: true, count: pity, date: dateAt(now.valueOf()) });
  }

  let from = 0;
  let to = fiveNum;
  let pageInfo: StarRailGachaDetailModel["pageInfo"];
  const truncated = page === undefined && maxRows > 0 && fiveNum > maxRows;
  if (truncated) to = maxRows;
  if (page !== undefined) {
    const total = maxRows ? Math.max(1, Math.ceil(fiveNum / maxRows)) : 1;
    if (page > total) throw new RangeError("星铁抽卡显示页码超出范围。");
    from = (page - 1) * maxRows;
    to = maxRows ? Math.min(fiveNum, from + maxRows) : fiveNum;
    if (total > 1) pageInfo = { page, total, from: from + 1, to, count: fiveNum };
  }
  return {
    uid, face, poolName: model.name, pageInfo, gacha: {
      stat, items, luck, noWaiRate: state.noWaiRate, maxFour: { name: "无", count: 0 },
      fiveLog: [...(from ? [] : currentPity), ...five.slice(from, to)],
      ...(truncated ? { shownNum: to, hiddenNum: fiveNum - to } : {}),
    },
  };
}
