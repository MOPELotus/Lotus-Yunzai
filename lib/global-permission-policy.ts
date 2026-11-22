export const globalPermissionLists = ["users.allow", "users.deny", "groups.allow", "groups.deny"] as const;
export type GlobalPermissionList = typeof globalPermissionLists[number];
export const globalPermissionPolicies = ["allow", "deny"] as const;
export type GlobalPermissionPolicy = typeof globalPermissionPolicies[number];

export type GlobalPermissionSettings = Record<GlobalPermissionList, readonly string[]> & {
  readonly default_policy: GlobalPermissionPolicy;
};

export interface GlobalPermissionSnapshot {
  readonly revision: string;
  readonly settings: GlobalPermissionSettings;
  readonly locked: Partial<Record<GlobalPermissionList, readonly string[]>>;
  readonly retained: Partial<Record<GlobalPermissionList, number>>;
}

export function isPermissionId(value: unknown): value is string {
  return typeof value === "string" && /^[1-9]\d{0,15}$/u.test(value) && Number.isSafeInteger(Number(value));
}

export function sortPermissionIds(ids: Iterable<string>) {
  return [...new Set(ids)].sort((left, right) => left.length - right.length || left.localeCompare(right, "en"));
}
