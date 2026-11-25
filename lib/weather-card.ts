import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { drawInfoText, infoCardColors, measureInfoText, renderInfoCard } from "@lotus-yunzai/skia/info-card";
import type { WeatherReport } from "./weather.ts";

export function renderWeatherCard(report: WeatherReport, scale: 1 | 2 | 4, mode?: "gpu") {
  return renderInfoCard({ title: $t("lib.weather-card.text_b157ef7c8a", { "area": report.area }), metadata: $t("lib.weather-card.text_9f18e63152", { "updated": report.updated }), width: 780 },
    ({ x, y, width, measure }) => {
      const sections = [
        { title: report.current, entries: report.conditions, columns: 3 },
        { title: $t("lib.weather-card.text_b4bd74808c"), entries: report.warnings, columns: 1 },
        { title: $t("lib.weather-card.text_21bce636cb"), entries: report.hourly.map(entry => entry.replace(" · ", "\n")), columns: 4 },
        { title: $t("lib.weather-card.text_77b622b39f"), entries: report.daily, columns: 1 },
        { title: $t("lib.weather-card.text_3e7d1b04ef"), entries: report.lifestyle, columns: 3 },
      ].filter(section => section.entries.length || section.title === report.current);
      const gap = 6;
      const fontSize = 18;
      const leading = 25;
      let top = y;
      const layout = sections.map(({ title, entries, columns }) => {
        const headingY = top;
        top += 34;
        const columnWidth = (width - gap * (columns - 1)) / columns;
        const rows = [];
        for (let offset = 0; offset < entries.length; offset += columns) {
          const lines = entries.slice(offset, offset + columns)
            .map(entry => measureInfoText(measure, entry, columnWidth - 20, fontSize));
          const height = Math.max(...lines.map(cell => cell.length)) * leading + 12;
          rows.push({ top, height, lines });
          top += height + gap;
        }
        top += 14;
        return { title, headingY, columnWidth, rows };
      });
      return {
        height: top - y - 14,
        draw(ctx) {
          for (const { title, headingY, columnWidth, rows } of layout) {
            drawInfoText(ctx, [title], x, headingY, { size: 24, color: infoCardColors.gold, title: true });
            for (const row of rows) {
              row.lines.forEach((lines, column) => {
                const left = x + column * (columnWidth + gap);
                ctx.fillStyle = infoCardColors.tile;
                ctx.fillRect(left, row.top, columnWidth, row.height);
                drawInfoText(ctx, lines, left + 10, row.top + 6, { size: fontSize, leading });
              });
            }
          }
        },
      };
    }, { mode, scale });
}
