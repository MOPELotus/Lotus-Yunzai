import type { HoyoTransport } from "./credentials.ts";
import type { HoYoLabCheckinAccount, HoYoLabCheckinOptions } from "./hoyolab-checkin-transport.ts";
import {
  openHoYoLabDefaultCheckin, type HoYoLabDefaultCheckinInfo, type HoYoLabDefaultRole,
} from "./hoyolab-default-checkin.ts";

const game = {
  gameBiz: "bh3_global", name: "崩坏3", activity: "e202110291205111",
  endpoint: "https://sg-act-public-api.hoyolab.com/event/mani", signgame: "bh3",
  regions: ["overseas01", "jp01", "kr01", "usa01", "asia01", "eur01"], uidPattern: /^[1-9]\d{0,19}$/u,
  credential: "ltoken", perRegionUid: true,
} as const;

export type HoYoLabBh3Role = HoYoLabDefaultRole<typeof game.gameBiz, typeof game.regions[number]>;
export type HoYoLabBh3CheckinInfo = Omit<HoYoLabDefaultCheckinInfo<never>, "role">;

export function openHoYoLabBh3Checkin(
  source: HoYoLabCheckinAccount, transport: HoyoTransport, options: HoYoLabCheckinOptions,
): Promise<{
  readonly roles: readonly HoYoLabBh3Role[];
  readInfo(): Promise<HoYoLabBh3CheckinInfo>;
  submit(options: { readonly blockedUids: readonly string[] }): Promise<"accepted">;
}> {
  return openHoYoLabDefaultCheckin(game, source, transport, options);
}
