import { createTranslator as createTextTranslator } from "../../i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("hoyo-client", messageCatalog.messages);
const expiresAt = Date.parse("2027-01-03T10:00:00+08:00");

export function planetLaunchMessages(now: number) {
  const expired = now >= expiresAt;
  return {
    expired,
    messages: [
      $t("redeem-preview.planet-launch.text_3220c0ee9b"),
      ...(expired ? [$t("redeem-preview.planet-launch.text_538aa1829d")] : [
        "XBGD1204",
        $t("redeem-preview.planet-launch.text_7d4c901997"),
        $t("redeem-preview.planet-launch.text_777be4e7d1"),
        $t("redeem-preview.planet-launch.text_49bbfc5d10"),
      ]),
      $t("redeem-preview.planet-launch.text_6470d3adae"),
      $t("redeem-preview.planet-launch.text_774a7bbaca"),
      $t("redeem-preview.planet-launch.text_fe2d59990d"),
    ],
  };
}
