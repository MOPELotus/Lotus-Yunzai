export const accountScopes = [
  "checkin.register", "checkin.refresh", "checkin.group_register",
  "scheduler.generate", "scheduler.run_due", "scheduler.manage",
] as const;
export type AccountScope = typeof accountScopes[number];

export const accountScopePolicies = ["inherit", "allow", "deny", "master_only"] as const;
export type AccountScopePolicy = typeof accountScopePolicies[number];

export function accountScopePolicy(scope: AccountScope, configured: unknown): AccountScopePolicy {
  if (configured !== null && configured !== undefined) {
    return accountScopePolicies.find(value => value === configured) ?? "inherit";
  }
  return scope.startsWith("scheduler.") || scope === "checkin.group_register" ? "master_only" : "inherit";
}

export interface AccountScopeSnapshot {
  readonly revision: string;
  readonly settings: Record<AccountScope, AccountScopePolicy>;
}
