/** Provider orchestration is supplied by the host; business adapters own acceptance. */
export type CaptchaChallenge =
  | { readonly captchaVersion: 3; readonly gt: string; readonly challenge: string;
      readonly new_captcha?: boolean | 0 | 1; readonly success?: boolean | 0 | 1 }
  | { readonly captchaVersion: 4; readonly captchaId: string; readonly riskType?: string; readonly userInfo?: string };
export type CaptchaProof =
  | { readonly challenge: string; readonly validate: string; readonly seccode: string }
  | { readonly captchaVersion: 4; readonly captchaId: string; readonly lotNumber: string;
      readonly captchaOutput: string; readonly passToken: string; readonly genTime: string };
export type CaptchaEvent =
  | { readonly type: "automatic" | "accepted" | "failed" }
  | { readonly type: "manual"; readonly link: string; readonly expiresAt: number };
export interface CaptchaRun<T> {
  readonly signal: AbortSignal;
  readonly verify: () => Promise<void>;
  /** Called once per attempted provider, including every retry. */
  readonly challenge: () => Promise<CaptchaChallenge | { readonly completed: T }>;
  /** A rejected business proof consumes this challenge. Transport/auth errors must throw. */
  readonly accept: (proof: CaptchaProof, challenge: CaptchaChallenge) => Promise<
    { readonly accepted: true; readonly value: T } | { readonly accepted: false }>;
  readonly notify?: (event: CaptchaEvent) => unknown;
  readonly allowManual?: boolean;
  readonly manualProof?: (challenge: CaptchaChallenge, signal: AbortSignal) => Promise<CaptchaProof | undefined>;
  readonly context?: { readonly qq: string; readonly profileId: number };
}
export interface CaptchaSolver {
  run<T>(options: CaptchaRun<T>): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string }>;
}
let defaultSolver: CaptchaSolver | undefined;
/** Explicit host lifecycle registration; readers constructed before startup also see updates. */
export function setDefaultCaptchaSolver(solver: CaptchaSolver | undefined) { defaultSolver = solver; }
export function getDefaultCaptchaSolver() { return defaultSolver; }
