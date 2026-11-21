export { parseRedeemCommand } from "./games.ts";
export { planetLaunchMessages } from "./planet-launch.ts";
export { formatRedeemResult, RedeemCodeService, type RedeemPreviewResult } from "./service.ts";

export interface RedeemPreviewOptions {
  readonly historyFile?: string | false;
  readonly legacyHistoryFiles?: readonly string[];
  readonly now?: () => number;
  readonly fetch?: (url: string, options: RequestInit) => Promise<Response>;
  readonly signal?: AbortSignal;
}
