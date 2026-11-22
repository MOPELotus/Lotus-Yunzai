export const accountScopes = [
  "checkin.register", "checkin.refresh", "checkin.group_register",
  "scheduler.generate", "scheduler.run_due", "scheduler.manage",
] as const;
export type AccountScope = typeof accountScopes[number];

export const mediaDownloadScopes = ["bilibili.download", "douyin.download"] as const;
export type MediaDownloadScope = typeof mediaDownloadScopes[number];

export const accountScopePolicies = ["inherit", "allow", "deny", "master_only"] as const;
export type AccountScopePolicy = typeof accountScopePolicies[number];

export function accountScopePolicy(scope: AccountScope | "group.cleanup", configured: unknown): AccountScopePolicy {
  if (configured !== null && configured !== undefined) {
    return accountScopePolicies.find(value => value === configured) ?? (scope === "group.cleanup" ? "deny" : "inherit");
  }
  return scope.startsWith("scheduler.") || scope === "checkin.group_register" || scope === "group.cleanup" ? "master_only" : "inherit";
}

export interface ScopePolicySnapshot<Scope extends string> {
  readonly revision: string;
  readonly settings: Record<Scope, AccountScopePolicy>;
}

export type AccountScopeSnapshot = ScopePolicySnapshot<AccountScope>;
