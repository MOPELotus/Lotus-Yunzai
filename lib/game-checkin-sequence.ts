import { ProfileError } from "@lotus-yunzai/account";
import { GameRecordRequestError, HoyoRequestError } from "@lotus-yunzai/hoyo-client";

interface CheckinInfo {
  readonly signed: boolean;
  readonly firstBind: boolean;
  readonly totalSignDays?: number;
}

export interface CheckinSequence {
  readInfo(): Promise<CheckinInfo>;
  submit(): Promise<"already" | "accepted">;
  verifyCurrent(): Promise<void>;
  readonly signal?: AbortSignal;
  readonly canSubmit?: boolean;
  readonly beforeSubmit?: () => Promise<void>;
}

export type GameCheckinResult =
  | { readonly status: "signed" | "already"; readonly totalSignDays?: number }
  | { readonly status: "first-bind" }
  | { readonly status: "unconfirmed"; readonly error?: unknown }
  | { readonly status: "failed"; readonly error: unknown };

function interrupted(error: unknown): boolean {
  return (error instanceof ProfileError && error.code === "changed") ||
    (error instanceof HoyoRequestError && error.code === "profile-changed") ||
    (error instanceof DOMException && error.name === "AbortError");
}

function submissionUnknown(error: unknown): boolean {
  if (!(error instanceof HoyoRequestError) || error instanceof GameRecordRequestError) return false;
  return error.code === "transport" || error.code === "response" ||
    (error.code === "http" && (error.status === undefined || error.status === 408 || error.status >= 500));
}

function completed(status: "signed" | "already", { totalSignDays }: CheckinInfo): GameCheckinResult {
  return { status, ...(totalSignDays === undefined ? {} : { totalSignDays }) };
}

export async function runGameCheckinSequence(sequence: CheckinSequence): Promise<GameCheckinResult> {
  const { signal } = sequence;

  async function verify() {
    signal?.throwIfAborted();
    await sequence.verifyCurrent();
    signal?.throwIfAborted();
  }

  // Recheck the same account after both responses and failures, before using
  // their contents or starting any subsequent request.
  async function current<Value>(operation: () => Promise<Value>) {
    try {
      signal?.throwIfAborted();
      return { ok: true as const, value: await operation() };
    } catch (error) {
      if (interrupted(error)) throw error;
      return { ok: false as const, error };
    } finally {
      await verify();
    }
  }

  await verify();
  const before = await current(() => sequence.readInfo());
  if (!before.ok) return { status: "failed", error: before.error };
  if (before.value.signed) return completed("already", before.value);
  if (sequence.canSubmit === false) return { status: "unconfirmed" };
  if (before.value.firstBind) return { status: "first-bind" };

  if (sequence.beforeSubmit) {
    await sequence.beforeSubmit();
    await verify();
  }
  const submitted = await current(() => sequence.submit());
  if (!submitted.ok && !submissionUnknown(submitted.error)) return { status: "failed", error: submitted.error };

  // A potentially accepted write is reconciled only with a status read.
  const after = await current(() => sequence.readInfo());
  if (!after.ok) return { status: "unconfirmed", error: after.error };
  if (after.value.signed) return completed(submitted.ok && submitted.value === "already" ? "already" : "signed", after.value);
  return submitted.ok ? { status: "unconfirmed" } : { status: "unconfirmed", error: submitted.error };
}
