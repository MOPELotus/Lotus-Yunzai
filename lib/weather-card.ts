import { drawInfoText, infoCardColors, measureInfoText, renderInfoCard } from "@lotus-yunzai/skia/info-card";
import type { WeatherReport } from "./weather.ts";

export function renderWeatherCard(report: WeatherReport, scale: 1 | 2 | 4, mode?: "gpu") {
  return renderInfoCard({ title: `${report.area}天气`, metadata: `腾讯天气 · ${report.updated} 更新`, width: 780 },
    ({ x, y, width, measure }) => {
      const sections = [
        { title: report.current, entries: report.conditions, columns: 3 },
        { title: "天气预警", entries: report.warnings, columns: 1 },
        { title: "逐小时预报", entries: report.hourly.map(entry => entry.replace(" · ", "\n")), columns: 4 },
        { title: "逐日预报", entries: report.daily, columns: 1 },
        { title: "生活指数", entries: report.lifestyle, columns: 3 },
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
