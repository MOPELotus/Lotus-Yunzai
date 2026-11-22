export const atlasScopeFields = { update_args: "version", challenge_args: "challenge" } as const;
export type AtlasScopeField = keyof typeof atlasScopeFields;

export interface AtlasScopeSelection {
  readonly available: readonly string[];
  readonly selected: readonly string[] | null;
}

export type AtlasScopeSelections = Record<AtlasScopeField, AtlasScopeSelection>;
export type AtlasScopePatch = Partial<Record<AtlasScopeField, readonly string[]>>;
