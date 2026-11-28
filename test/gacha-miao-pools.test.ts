import { expect, test } from 'bun:test';
import { buildGenshinGachaDetail } from '../plugins/genshin/gacha-detail.ts';
import { buildStarRailGachaDetail, detailPools } from '../plugins/starrail/gacha-detail.ts';
import { buildStarRailRecordDetail } from '../plugins/starrail/gacha-record-detail.ts';
import type { StarRailRecordDraw } from '../plugins/starrail/gacha-record-source.ts';

const uid = '100000002', face = { name: 'fixture' };

test('all six Star Rail pools support the Miao detail model for aggregate and individual history', () => {
  for (const [pool, config] of Object.entries(detailPools)) {
    const history = { pools: { [pool]: { totalDraws: 45, fiveStars: [{ id: 'first', item: {
      name: 'fixture', item_type: pool.includes('Equipment') ? 'ItemType_Equipment' : 'ItemType_Avatar',
    }, gacha_count: 45 }] } } };
    const legacy = buildStarRailGachaDetail({ uid, face, history, pool: pool as keyof typeof detailPools, maxRows: 0 })!;
    expect(legacy).toBeDefined(); expect(legacy.poolName).toBe(config.name);
    expect(legacy.gacha.stat.fiveNum).toBe(1); expect(legacy.pageInfo).toBeUndefined();
    const draws = Array.from({ length: 35 }, (_, index) => ({ id: String(index + 1), pool: String(config.legacy),
      gachaId: 'fixture', rank: 5, at: 1700000000000 + index,
      item: { id: '1003', name: 'fixture', kind: pool.includes('Equipment') ? 'weapon' : 'char', abbr: 'fixture' },
    })) as StarRailRecordDraw[];
    const raw = buildStarRailRecordDetail({ uid, face, draws, pool: pool as keyof typeof detailPools, maxRows: 0 })!;
    expect(raw.gacha.fiveLog.filter(row => row.id !== 888)).toHaveLength(35);
    expect(raw.pageInfo).toBeUndefined();
    if (pool === 'GachaType_Newbie') { expect(legacy.gacha.luck).toBeUndefined(); expect(raw.gacha.luck).toBeUndefined(); }
  }
});

test('Genshin beginner records render without fabricating normal-banner probability grades', () => {
  const records = { 100: [{ uid, id: '1800000000000000001', gacha_type: '100', rank_type: '5', item_type: '角色',
    name: '迪卢克', time: '2026-11-28 12:00:00' }] };
  const model = buildGenshinGachaDetail({ uid, face, records, pool: 100, maxRows: 0 })!;
  expect(model.type).toBe(100); expect(model.gacha.stat.allNum).toBe(1);
  expect(model.gacha.stat.fiveNum).toBe(1); expect(model.gacha.luck).toBeUndefined();
});
