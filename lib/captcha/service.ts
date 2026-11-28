import { captchaManualAllowed } from "../../packages/hoyo-client/captcha.ts";
import { CaptchaError } from "@lotus-yunzai/captcha";
import { randomUUID } from "node:crypto";
import { runtimeTraceId } from "../runtime-trace.ts";
import { createTaskQueue } from "../task-queue.ts";
import { setTimeout as sleep } from "node:timers/promises";
import type { CaptchaChallenge, CaptchaEvent, CaptchaProof, CaptchaRun, CaptchaSolver } from "@lotus-yunzai/hoyo-client";
import type { createManualCaptchaRelay } from "./manual-relay.ts";
import { captchaConfig, createAutomaticProviders, normalizeCaptchaProof, ProviderFailure, type CaptchaConfig, type ProviderId } from "./providers.ts";

type Relay = Pick<ReturnType<typeof createManualCaptchaRelay>, "register" | "readResult">;
export interface CaptchaFailureReport {
  provider: ProviderId; round: number; attempt: number; reason: string;
  stage: 'queue' | 'solve' | 'normalize' | 'accept'; code?: string; runId: string; taskId?: string;
}
const localErrorCodes = new Set([
  'local_worker_failed', 'local_worker_exited', 'invalid_worker_result', 'timeout', 'recognition_failed',
  'model_missing', 'captcha_busy', 'service_closed', 'aborted', 'unsupported_puzzle', 'unsupported_version',
  'empty_response', 'invalid_upstream_response', 'upstream_api_error', 'upstream_response_too_large',
  'invalid_answer', 'invalid_v', 'verification_failed', 'answer_type_mismatch', 'invalid_grid',
  'invalid_resource_url', 'proof_identity_mismatch', 'protocol_key_updated', 'unsupported_build',
  'upstream_http_error', 'rate_limited',
]);
function safeErrorCode(error: unknown): string | undefined {
  if (error instanceof CaptchaError && localErrorCodes.has(error.code)) return error.code;
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'timeout';
}
export interface CaptchaServiceOptions {
  readonly config?: unknown;
  readonly manualRelay?: () => Relay | undefined;
  readonly signal?: AbortSignal;
  readonly notify?: (context: NonNullable<CaptchaRun<unknown>["context"]>, event: CaptchaEvent, signal: AbortSignal) => unknown;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<unknown>;
  readonly providers?: { available(id: ProviderId): boolean; solve(id: "local" | "ttocr", challenge: CaptchaChallenge, signal: AbortSignal): Promise<CaptchaProof>; close?(): Promise<void> };
  readonly report?: (entry: CaptchaFailureReport) => void;
}
export function createCaptchaService(options: CaptchaServiceOptions = {}): CaptchaSolver & { readonly config: CaptchaConfig; close(): Promise<void> } {
  const config = captchaConfig(options.config);
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((ms, signal) => sleep(ms, undefined, { signal }));
  const providers = options.providers ?? createAutomaticProviders(config, { fetchImpl: options.fetchImpl, now, wait });
  const localQueue = createTaskQueue();
  const closed = new AbortController();
  const lifecycle = options.signal ? AbortSignal.any([closed.signal, options.signal]) : closed.signal;
  options.signal?.addEventListener("abort", () => { void providers.close?.(); }, { once: true });
  return {
    config,
    async close() { closed.abort(); await providers.close?.(); },
    async run<T>(input: CaptchaRun<T>) {
      if (!config.enabled) return { ok: false, reason: "disabled" };
      const runId = randomUUID(), taskId = runtimeTraceId();
      const report = (entry: Omit<CaptchaFailureReport, 'runId' | 'taskId'>) => options.report?.({ ...entry, runId, ...(taskId && { taskId }) });
      const operation = new AbortController();
      const signal = AbortSignal.any([input.signal, lifecycle, operation.signal]);
      const usedChallenges = new Set<string>(), usedProofs = new Set<string>(), disabled = new Set<ProviderId>();
      let reason = "providers_unavailable";
      let guardFailed = false;
      const guard = async () => {
        try { signal.throwIfAborted(); await input.verify(); signal.throwIfAborted(); }
        catch (error) { guardFailed = true; throw error; }
      };
      const notify = async (event: CaptchaEvent) => {
        await guard();
        try {
          if (input.notify) return await input.notify(event);
          if (input.context && options.notify) return await options.notify(input.context, event, signal);
        } catch { /* A failed status notification never changes official acceptance. */ }
        return false;
      };
      const canNotify = !!input.notify || !!(input.context && options.notify);
      async function manual(challenge: CaptchaChallenge): Promise<CaptchaProof | undefined> {
        if (input.manualProof) return input.manualProof(challenge, signal);
        const relay = options.manualRelay?.();
        if (!relay) return;
        const attempt = new AbortController();
        const scope = AbortSignal.any([signal, attempt.signal]);
        try {
          const registration = await relay.register(challenge, scope);
          if (!registration) return;
          if (await notify({ type: "manual", link: registration.link, expiresAt: registration.expiresAt }) === false) return;
          while (now() < registration.expiresAt) {
            await guard();
            const result = await relay.readResult(registration.ticket);
            await guard();
            if (now() >= registration.expiresAt) return;
            if (result.status === "complete") return normalizeCaptchaProof(result.result, challenge);
            if (result.status !== "pending") return;
            await wait(Math.min(1500, registration.expiresAt - now()), scope);
          }
        } finally { attempt.abort(); }
      }
      try {
        await guard();
        await notify({ type: "automatic" });
        for (let round = 1; round <= 2; round++) {
          for (const provider of config.order) {
            if (disabled.has(provider)) continue;
            if (provider === "manual" ? !config.manual.enabled || !captchaManualAllowed(input.allowManual) || (!input.manualProof && (!canNotify || !options.manualRelay?.())) : !providers.available(provider)) continue;
            const attempts = provider === "manual" ? 1 : 5;
            for (let attempt = 1; attempt <= attempts; attempt++) {
              await guard();
              if (provider !== "manual" && !providers.available(provider)) break;
              let release: (() => void) | undefined;
              if (provider === "local") {
                try {
                  release = await localQueue.acquire(AbortSignal.any([signal, AbortSignal.timeout(config.local.timeoutMs)]));
                  await guard();
                } catch (error) {
                  release?.();
                  signal.throwIfAborted();
                  if (guardFailed) throw error;
                  reason = "local_busy";
                  disabled.add(provider);
                  report({ provider, round, attempt, reason, stage: 'queue', code: 'captcha_busy' });
                  break;
                }
              }
              try {
                const next = await input.challenge();
                await guard();
                if ("completed" in next) {
                  await notify({ type: "accepted" });
                  return { ok: true, value: next.completed };
                }
                const challengeKey = next.captchaVersion === 3 ? `${next.gt}:${next.challenge}` : undefined;
                if (challengeKey && usedChallenges.has(challengeKey)) {
                  reason = "challenge_reused";
                  await notify({ type: "failed" });
                  return { ok: false, reason };
                }
                if (challengeKey) usedChallenges.add(challengeKey);
                let proof: CaptchaProof | undefined;
                try {
                  proof = provider === "manual" ? await manual(next) : await providers.solve(provider, next, signal);
                  await guard();
                } catch (error) {
                  signal.throwIfAborted();
                  if (guardFailed || (provider === "manual" && input.manualProof)) throw error;
                  // Guard errors are not provider failures and must stop the business.
                  await guard();
                  if (provider === "local" && error instanceof CaptchaError && error.code === "captcha_busy") {
                    reason = "local_busy";
                    disabled.add(provider);
                    report({ provider, round, attempt, reason, stage: 'solve', code: 'captcha_busy' });
                    break;
                  }
                  reason = error instanceof ProviderFailure ? error.reason : "provider_request_failed";
                  if (error instanceof ProviderFailure && !error.retryable) disabled.add(provider);
                  report({ provider, round, attempt, reason, stage: 'solve', code: safeErrorCode(error) });
                  if (disabled.has(provider)) break;
                  continue;
                }
                const normalized = normalizeCaptchaProof(proof, next);
                if (!normalized) {
                  reason = "invalid_proof";
                  report({ provider, round, attempt, reason, stage: 'normalize' });
                  continue;
                }
                const proofKey = "validate" in normalized ? `v3:${normalized.validate}` : `v4:${normalized.lotNumber}`;
                if (usedProofs.has(proofKey)) {
                  reason = "proof_reused";
                  report({ provider, round, attempt, reason, stage: 'normalize' });
                  continue;
                }
                usedProofs.add(proofKey);
                if ("validate" in normalized && next.captchaVersion === 3) {
                  const returnedKey = `${next.gt}:${normalized.challenge}`;
                  if (returnedKey !== challengeKey && usedChallenges.has(returnedKey)) { reason = "challenge_reused"; continue; }
                  usedChallenges.add(returnedKey);
                }
                await guard();
                // Only explicit rejection advances the chain. Errors escape without replay.
                const accepted = await input.accept(normalized, next);
                await guard();
                if (accepted.accepted) {
                  await notify({ type: "accepted" });
                  return { ok: true, value: accepted.value };
                }
                reason = "business_rejected";
                report({ provider, round, attempt, reason, stage: 'accept' });
              } finally { release?.(); }
            }
          }
        }
        await notify({ type: "failed" });
        return { ok: false, reason };
      } finally { operation.abort(); }
    },
  };
}
