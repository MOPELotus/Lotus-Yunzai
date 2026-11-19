import type { HoyoTransport } from "./credentials.ts";
import type { HoYoLabCheckinAccount, HoYoLabCheckinOptions } from "./hoyolab-checkin-transport.ts";
import { openHoYoLabRoleCheckin, type HoYoLabBoundRole } from "./hoyolab-role-checkin.ts";

export type HoYoLabZzzRole = HoYoLabBoundRole<"zzz">;

export function openHoYoLabZzzCheckin(
  source: HoYoLabCheckinAccount, transport: HoyoTransport, options: HoYoLabCheckinOptions,
) {
  return openHoYoLabRoleCheckin("zzz", source, transport, options);
}
