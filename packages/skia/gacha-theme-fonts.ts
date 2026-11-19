import { createHash } from "node:crypto";
import { FontLibrary } from "skia-canvas";

export function registerGachaThemeFont(scope: string, asset: string) {
  const key = createHash("sha256").update(asset).digest("hex").slice(0, 24);
  const alias = `LotusGacha${scope}-${key}`;
  FontLibrary.use(alias, [asset]);
  return `"${alias}"`;
}
