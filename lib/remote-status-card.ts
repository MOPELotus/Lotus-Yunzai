import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { nativeImageRasterScale } from "@lotus-yunzai/skia";
import { drawInfoText, infoCardColors, measureInfoText, renderInfoCard } from "@lotus-yunzai/skia/info-card";

export function renderRemoteStatusCard(paired: boolean, enabled: boolean) {
  return renderInfoCard({ title: $t("lib.remote-status-card.text_9e1fa31d6d"), width: 620 }, ({ x, y, width, measure }) => {
    const rows = [
      paired ? $t("lib.remote-status-card.text_952c6da079") : $t("lib.remote-status-card.text_feddbe9922"),
      enabled ? $t("lib.remote-status-card.text_c875b089f5") : $t("lib.remote-status-card.text_40daf13746"),
    ];
    const guide = measureInfoText(measure, $t("lib.remote-status-card.text_dc2e3290dc"), width - 32, 16);
    return {
      height: 110 + guide.length * 26,
      draw(ctx) {
        ctx.fillStyle = infoCardColors.tile;
        ctx.fillRect(x, y, width, 110 + guide.length * 26);
        drawInfoText(ctx, rows, x + 16, y + 14, { size: 22, leading: 38, color: infoCardColors.gold });
        drawInfoText(ctx, guide, x + 16, y + 100, { size: 16, leading: 26, color: infoCardColors.muted });
      },
    };
  }, { mode: "gpu", scale: nativeImageRasterScale() });
}
