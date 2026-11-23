import { nativeImageRasterScale } from "@lotus-yunzai/skia";
import { drawInfoText, infoCardColors, measureInfoText, renderInfoCard } from "@lotus-yunzai/skia/info-card";

export function renderRemoteStatusCard(paired: boolean, enabled: boolean) {
  return renderInfoCard({ title: "远程身份验证", width: 620 }, ({ x, y, width, measure }) => {
    const rows = [
      paired ? "本机身份验证　已配对" : "本机身份验证　未配对",
      enabled ? "远程运维　已开启" : "远程运维　已关闭",
    ];
    const guide = measureInfoText(measure, "在私人本机终端运行远程身份验证脚本完成配对或重置。", width - 32, 16);
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
