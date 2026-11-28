import { join } from "node:path";
import { FontLibrary } from "skia-canvas";
import { builtinResourceDirectory } from "../../lib/builtin-resources.ts";

/** Last-resort project fonts for user text; no reliance on OS CJK or emoji packages. */
export const builtinFontFallback = '"LotusBuiltinCjk", "LotusBuiltinEmoji", sans-serif';
export const builtinFooterFontFallback = `"LotusFooter", ${builtinFontFallback}`;
let registered = false;
export function prepareBuiltinFonts() {
  if (registered) return;
  FontLibrary.use("LotusBuiltinCjk", [join(builtinResourceDirectory("core/passport"), "fonts/MiSans-VF.ttf")]);
  FontLibrary.use("LotusBuiltinEmoji", [join(builtinResourceDirectory("core/fonts"), "NotoColorEmoji.ttf")]);
  FontLibrary.use("LotusFooter", [join(builtinResourceDirectory("games/miao"), "common/font/HYWH-65W.ttf")]);
  registered = true;
}
