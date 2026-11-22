import { genshinSummaryOptions, quantityText, summaryBox, summaryIcon, type GenshinSummaryCardOptions } from "./genshin-summary-elements.ts";
import { drawInfoText, infoCardColors, measureInfoText, renderInfoCard } from "./info-card.ts";

export interface GenshinWorldBossRankingCardModel {
  readonly rows: readonly {
    readonly name: string;
    readonly count: number;
    readonly uid: string;
    readonly image?: Uint8Array;
  }[];
}

export type GenshinWorldBossRankingCardOptions = GenshinSummaryCardOptions;

export async function renderGenshinWorldBossRankingCard(model: GenshinWorldBossRankingCardModel,
  options: GenshinWorldBossRankingCardOptions = {}) {
  return renderInfoCard({ title: "原神 BOSS 击杀排行" }, ({ x: left, y, width, measure }) => {
    const rows = model.rows.map(entry => {
      const label = measureInfoText(measure, entry.name, width - 237, 22);
      const uid = measureInfoText(measure, "UID " + entry.uid, width - 237, 18);
      const number = measureInfoText(measure, quantityText(entry.count), 104, 22);
      return {
        image: entry.image, label, uid, number,
        height: Math.max(82, 22 + label.length * 30 + uid.length * 26, 40 + number.length * 27),
      };
    });
    return {
      height: rows.reduce((sum, row) => sum + row.height + 12, 0) || 30,
      async draw(ctx) {
        let top = y;
        if (!rows.length) drawInfoText(ctx, ["暂无排行记录"], left, top, { size: 20, color: infoCardColors.muted });
        for (const row of rows) {
          summaryBox(ctx, left, top, width, row.height);
          await summaryIcon(ctx, row.image, left + 12, top + (row.height - 58) / 2, 58, "BOSS");
          drawInfoText(ctx, row.label, left + 82, top + 12, { size: 22, leading: 30 });
          drawInfoText(ctx, row.uid, left + 82, top + 12 + row.label.length * 30,
            { size: 18, leading: 26, color: infoCardColors.muted });
          drawInfoText(ctx, row.number, left + width - 18, top + 12,
            { size: 22, leading: 27, color: infoCardColors.gold, align: "right" });
          drawInfoText(ctx, ["击杀次数"], left + width - 18, top + 12 + row.number.length * 27,
            { size: 16, color: infoCardColors.muted, align: "right" });
          top += row.height + 12;
        }
      },
    };
  }, await genshinSummaryOptions(options));
}
