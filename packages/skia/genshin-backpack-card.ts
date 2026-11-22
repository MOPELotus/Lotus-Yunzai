import { genshinSummaryOptions, quantityText, summaryBox, summaryIcon, summarySection, type GenshinSummaryCardOptions } from "./genshin-summary-elements.ts";
import { drawInfoText, infoCardColors, measureInfoText, renderInfoCard } from "./info-card.ts";

export interface GenshinBackpackCardModel {
  readonly categories: readonly {
    readonly name: string;
    readonly items: readonly {
      readonly name: string;
      readonly count: number;
      readonly exact: boolean;
      readonly image?: Uint8Array;
    }[];
  }[];
}

export type GenshinBackpackCardOptions = GenshinSummaryCardOptions;

export async function renderGenshinBackpackCard(model: GenshinBackpackCardModel, options: GenshinBackpackCardOptions = {}) {
  return renderInfoCard({ title: "原神背包", metadata: "米游社养成计算器 · ≥ 表示至少拥有该数量" },
    ({ x: left, y, width, measure }) => {
      const columns = 6;
      const gap = 12;
      const itemWidth = (width - (columns - 1) * gap) / columns;
      const categories = model.categories.filter(category => category.items.length > 0).map(category => {
        const heading = measureInfoText(measure, category.name, width, 22);
        const rows = [];
        for (let start = 0; start < category.items.length; start += columns) {
          const entries = category.items.slice(start, start + columns).map(item => ({
            image: item.image,
            label: measureInfoText(measure, item.name, itemWidth - 14, 18),
            count: measureInfoText(measure, (item.exact ? "×" : "≥") + quantityText(item.count), itemWidth - 14, 18),
          }));
          rows.push({ entries, height: 72 + Math.max(...entries.map(item => item.label.length * 24 + item.count.length * 23)) });
        }
        return { heading, rows };
      });
      const height = categories.reduce((sum, category) => sum + category.heading.length * 32 + 12 +
        category.rows.reduce((total, row) => total + row.height + gap, 0) + 8, 0);
      return {
        height: height || 30,
        async draw(ctx) {
          let top = y;
          if (!categories.length) drawInfoText(ctx, ["暂无素材记录"], left, top, { size: 20, color: infoCardColors.muted });
          for (const category of categories) {
            summarySection(ctx, category.heading, left, top, width);
            top += category.heading.length * 32 + 12;
            for (const row of category.rows) {
              for (const [column, entry] of row.entries.entries()) {
                const x = left + column * (itemWidth + gap);
                const center = x + itemWidth / 2;
                summaryBox(ctx, x, top, itemWidth, row.height);
                await summaryIcon(ctx, entry.image, center - 27, top + 8, 54, "素材");
                drawInfoText(ctx, entry.label, center, top + 65, { size: 18, leading: 24, align: "center" });
                drawInfoText(ctx, entry.count, center, top + 65 + entry.label.length * 24,
                  { size: 18, leading: 23, color: infoCardColors.gold, align: "center" });
              }
              top += row.height + gap;
            }
            top += 8;
          }
        },
      };
    }, await genshinSummaryOptions(options));
}
