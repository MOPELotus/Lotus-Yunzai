export const accountScopes = [
  "checkin.register", "checkin.refresh", "checkin.group_register",
  "scheduler.generate", "scheduler.run_due", "scheduler.manage",
] as const;
export type AccountScope = typeof accountScopes[number];

export const mediaDownloadScopes = ["bilibili.download", "douyin.download", "acfun.play"] as const;
export type MediaDownloadScope = typeof mediaDownloadScopes[number];

export const accountScopePolicies = ["inherit", "allow", "deny", "master_only"] as const;
export type AccountScopePolicy = typeof accountScopePolicies[number];

export const mediaOwnerScopes = ["bilibili.login", "tools.install", "netease.partner"] as const;
export type MediaOwnerScope = typeof mediaOwnerScopes[number];
const restrictedMediaPolicies = ["master_only", "deny"] as const satisfies readonly AccountScopePolicy[];

export function mediaOwnerScopePolicies(scope: MediaOwnerScope): readonly AccountScopePolicy[] {
  return scope === "netease.partner" ? accountScopePolicies : restrictedMediaPolicies;
}

export const groupExportScopes = ["group.members.export"] as const;
export type GroupExportScope = typeof groupExportScopes[number];
export type GroupScope = "group.cleanup" | GroupExportScope;

export type RemoteScope = "remote.spawn" | "remote.download" | "remote.upload";

export function accountScopePolicy(scope: AccountScope | GroupScope | RemoteScope, configured: unknown): AccountScopePolicy {
  const ownerOnly = scope === "group.cleanup" || scope === "group.members.export" || scope.startsWith("remote.");
  if (configured !== null && configured !== undefined) {
    return accountScopePolicies.find(value => value === configured) ?? (ownerOnly ? "deny" : "inherit");
  }
  return scope.startsWith("scheduler.") || scope === "checkin.group_register" || ownerOnly ? "master_only" : "inherit";
}

export interface ScopePolicySnapshot<Scope extends string> {
  readonly revision: string;
  readonly settings: Record<Scope, AccountScopePolicy>;
}

export type AccountScopeSnapshot = ScopePolicySnapshot<AccountScope>;
