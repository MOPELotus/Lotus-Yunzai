import { genshinSummaryOptions, quantityText, summaryBox, summaryIcon, summarySection, type GenshinSummaryCardOptions } from "./genshin-summary-elements.ts";
import { drawInfoText, infoCardColors, measureInfoText, renderInfoCard } from "./info-card.ts";

export interface GenshinWorldBossCardModel {
  readonly groups: readonly {
    readonly name: string;
    readonly bosses: readonly {
      readonly name: string;
      readonly killCount: number;
      readonly image?: Uint8Array;
    }[];
  }[];
}

export type GenshinWorldBossCardOptions = GenshinSummaryCardOptions;

export async function renderGenshinWorldBossCard(model: GenshinWorldBossCardModel, options: GenshinWorldBossCardOptions = {}) {
  return renderInfoCard({ title: "原神世界 BOSS 击杀" }, ({ x: left, y, width, measure }) => {
    const gap = 14;
    const itemWidth = (width - gap) / 2;
    const groups = model.groups.filter(group => group.bosses.length > 0).map(group => {
      const heading = measureInfoText(measure, group.name, width, 22);
      const rows = [];
      for (let start = 0; start < group.bosses.length; start += 2) {
        const entries = group.bosses.slice(start, start + 2).map(boss => ({
          image: boss.image,
          name: measureInfoText(measure, boss.name, itemWidth - 92, 22),
          count: measureInfoText(measure, "击杀 " + quantityText(boss.killCount) + " 次", itemWidth - 92, 18),
        }));
        rows.push({ entries, height: Math.max(82, ...entries.map(item => 20 + item.name.length * 30 + item.count.length * 25)) });
      }
      return { heading, rows };
    });
    const height = groups.reduce((sum, group) => sum + group.heading.length * 32 + 12 +
      group.rows.reduce((total, row) => total + row.height + gap, 0) + 8, 0);
    return {
      height: height || 30,
      async draw(ctx) {
        let top = y;
        if (!groups.length) drawInfoText(ctx, ["暂无击杀记录"], left, top, { size: 20, color: infoCardColors.muted });
        for (const group of groups) {
          summarySection(ctx, group.heading, left, top, width);
          top += group.heading.length * 32 + 12;
          for (const row of group.rows) {
            for (const [column, entry] of row.entries.entries()) {
              const x = left + column * (itemWidth + gap);
              summaryBox(ctx, x, top, itemWidth, row.height);
              await summaryIcon(ctx, entry.image, x + 12, top + (row.height - 58) / 2, 58, "BOSS");
              drawInfoText(ctx, entry.name, x + 82, top + 11, { size: 22, leading: 30 });
              drawInfoText(ctx, entry.count, x + 82, top + 11 + entry.name.length * 30,
                { size: 18, leading: 25, color: infoCardColors.gold });
            }
            top += row.height + gap;
          }
          top += 8;
        }
      },
    };
  }, await genshinSummaryOptions(options));
}
