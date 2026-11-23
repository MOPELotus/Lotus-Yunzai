import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FontLibrary, loadImage } from "skia-canvas";
import { nativeImageRasterScale, renderPng } from "./index.ts";

const assets = new URL("../../resources/donation/", import.meta.url);
const defaultFonts = fileURLToPath(new URL("../../data/passport/resources/", import.meta.url));
const methods = [
  { title: "微信支付", file: "wechat-lotus.png", notice: "使用微信扫一扫" },
  { title: "支付宝", file: "alipay-lotus.jpg", notice: "使用支付宝扫一扫" },
] as const;
const width = 830;
const panelWidth = 390;
const posterWidth = 354;

// Lotus-ReFactor 6e374cd uses the Miao help/index template for these two posters.
async function loadResources() {
  const fontDirectory = Bun.env.LOTUS_PASSPORT_QR_RESOURCES?.trim() || defaultFonts;
  for (const [family, relative] of [
    ["LotusDonationBody", "miao-theme/fonts/HYWH-65W.ttf"],
    ["LotusDonationTitle", "source-templates/miao-stat/fonts/NZBZ.ttf"],
  ] as const) {
    const path = join(fontDirectory, relative);
    if (await Bun.file(path).exists()) FontLibrary.use(family, [path]);
  }
  return Promise.all([
    loadImage(fileURLToPath(new URL("bg-01.jpg", assets))),
    loadImage(fileURLToPath(new URL("main-01.png", assets))),
  ] as const);
}

let resources: ReturnType<typeof loadResources> | undefined;

const shanghaiTime = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "medium",
});

export async function renderDonationCard(directory: string, scale: 1 | 2 | 4 = nativeImageRasterScale(), mode: "auto" | "gpu" | "cpu" = "auto",
  at = new Date()) {
  const [[background, foreground], posters] = await Promise.all([
    resources ??= loadResources().catch((error: unknown) => {
      resources = undefined;
      throw error;
    }),
    Promise.all(methods.map(async ({ file }) => {
      const path = Bun.file(join(directory, file));
      if (!await path.exists() || path.size > 8 * 1024 * 1024) throw new Error("捐赠图片不可用。");
      const image = await loadImage(Buffer.from(await path.arrayBuffer()));
      if (!image.width || !image.height || image.height > 4 * image.width) throw new Error("捐赠图片尺寸无效。");
      return image;
    })),
  ]);
  const posterHeight = Math.max(...posters.map(image => posterWidth * image.height / image.width));
  const panelTop = 193;
  const panelHeight = 126 + posterHeight;
  const contentHeight = panelTop + panelHeight + 70;
  const zoom = 720 * scale / width;
  const bodyFont = '"LotusDonationBody", "Noto Sans CJK SC", sans-serif';
  const titleFont = '"LotusDonationTitle", ' + bodyFont;

  return renderPng(720 * scale, Math.ceil(contentHeight * zoom), (ctx) => {
    ctx.scale(zoom, zoom);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    for (let y = 0; y < contentHeight; y += background.height) {
      for (let x = 0; x < width; x += background.width) ctx.drawImage(background, x, y);
    }
    const coverScale = Math.min(width / foreground.width, 800 / foreground.height);
    const coverWidth = foreground.width * coverScale;
    const coverHeight = foreground.height * coverScale;
    ctx.drawImage(foreground, (width - coverWidth) / 2, (800 - coverHeight) / 2, coverWidth, coverHeight);

    function panel(x: number, y: number, w: number, h: number) {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, 15);
      ctx.fillStyle = "rgba(15,20,31,.78)";
      ctx.fill();
    }
    function print(text: string, x: number, y: number, size: number, font = bodyFont, color = "#fff",
      align: "left" | "center" = "left") {
      ctx.font = `${size}px ${font}`;
      ctx.textBaseline = "top";
      ctx.textAlign = align;
      ctx.fillStyle = color;
      ctx.fillText(text, x, y);
    }

    panel(15, 45, width - 30, 133);
    print("捐赠支持", 35, 60, 50, titleFont);
    print("如果你觉得 MOPELotus 的项目或机器人对你有帮助，可以通过以下方式自愿支持。", 35, 130, 18);

    for (const [index, method] of methods.entries()) {
      const poster = posters[index]!;
      const x = 15 + index * (panelWidth + 20);
      const height = posterWidth * poster.height / poster.width;
      ctx.save();
      panel(x, panelTop, panelWidth, panelHeight);
      ctx.clip();
      ctx.fillStyle = "rgba(0,0,0,.40)";
      ctx.fillRect(x, panelTop, panelWidth, 48);
      print(method.title, x + panelWidth / 2, panelTop + 15, 20, bodyFont, "#d3bc8e", "center");
      ctx.drawImage(poster, x + 18, panelTop + 60 + (posterHeight - height) / 2, posterWidth, height);
      print(method.notice, x + panelWidth / 2, panelTop + posterHeight + 78, 18, bodyFont, "#fff", "center");
      ctx.restore();
    }

    ctx.shadowColor = "#000";
    ctx.shadowBlur = 2;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;
    print(`Lotus-Yunzai · ${shanghaiTime.format(at)}`, width / 2, panelTop + panelHeight + 35, 12, bodyFont, "#fff", "center");
  }, mode, { allowHalfScale: scale === 4 });
}
