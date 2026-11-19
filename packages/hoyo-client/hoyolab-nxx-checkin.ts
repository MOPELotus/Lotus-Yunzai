import type { HoyoTransport } from "./credentials.ts";
import type { HoYoLabCheckinAccount, HoYoLabCheckinOptions } from "./hoyolab-checkin-transport.ts";
import { openHoYoLabRoleCheckin, type HoYoLabBoundRole } from "./hoyolab-role-checkin.ts";

export type HoYoLabNxxRole = HoYoLabBoundRole<"nxx">;

export function openHoYoLabNxxCheckin(
  source: HoYoLabCheckinAccount, transport: HoyoTransport, options: HoYoLabCheckinOptions,
) {
  return openHoYoLabRoleCheckin("nxx", source, transport, options);
}
