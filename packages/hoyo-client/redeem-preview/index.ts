export { parseRedeemCommand } from "./games.js";
export { formatRedeemResult, RedeemCodeService } from "./service.js";

export interface RedeemPreviewOptions {
  readonly historyFile?: string | false;
  readonly now?: () => number;
  readonly fetch?: (url: string, options: RequestInit) => Promise<Response>;
}
