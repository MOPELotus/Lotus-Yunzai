import type { HoyoTransport } from "./credentials.ts";
import type { HoYoLabCheckinAccount, HoYoLabCheckinOptions } from "./hoyolab-checkin-transport.ts";
import { openHoYoLabRoleCheckin, type HoYoLabBoundRole } from "./hoyolab-role-checkin.ts";

export type HoYoLabStarRailRole = HoYoLabBoundRole<"starrail">;

export function openHoYoLabStarRailCheckin(source: HoYoLabCheckinAccount, transport: HoyoTransport, options: HoYoLabCheckinOptions) {
  return openHoYoLabRoleCheckin("starrail", source, transport, options);
}
