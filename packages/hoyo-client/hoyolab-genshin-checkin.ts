import type { HoyoTransport } from "./credentials.ts";
import type { HoYoLabCheckinAccount, HoYoLabCheckinOptions } from "./hoyolab-checkin-transport.ts";
import {
  openHoYoLabDefaultCheckin, type HoYoLabDefaultCheckinInfo, type HoYoLabDefaultRole,
} from "./hoyolab-default-checkin.ts";

const game = {
  gameBiz: "hk4e_global", name: "原神", activity: "e202102251931481",
  endpoint: "https://sg-act-public-api.hoyolab.com/event/sol", signgame: "hk4e",
  regions: ["os_usa", "os_euro", "os_asia", "os_cht"], uidPattern: /^[1-9]\d{8,9}$/u,
  credential: "cookie", reportBoundRole: true, sendBrowserDevice: true,
} as const;

export type HoYoLabGenshinCheckinSource = HoYoLabCheckinAccount;
export type HoYoLabGenshinRole = HoYoLabDefaultRole<typeof game.gameBiz, typeof game.regions[number]>;
export type HoYoLabGenshinCheckinInfo = HoYoLabDefaultCheckinInfo<HoYoLabGenshinRole>;

export function openHoYoLabGenshinCheckin(
  source: HoYoLabGenshinCheckinSource, transport: HoyoTransport, options: HoYoLabCheckinOptions,
) {
  return openHoYoLabDefaultCheckin(game, source, transport, options);
}
