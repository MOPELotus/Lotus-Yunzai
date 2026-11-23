const limits = { length: 32_000, depth: 10, maxArrayLength: 100, maxStringLength: 1_000, breakLength: 1_000 } as const;
type LimitKey = keyof typeof limits;
export type LogObjectOptions = Partial<Record<LimitKey, number>> & {
  compact?: boolean | number;
  sorted?: boolean;
  numericSeparator?: boolean;
};

export function logObjectOptions(value: unknown): LogObjectOptions | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const options = value as Record<string, unknown>;
  const result: LogObjectOptions = {};
  for (const key of Object.keys(limits) as LimitKey[]) {
    const option = options[key];
    const number = key === "length" && typeof option === "string" ? Number(option) : option;
    const minimum = key === "length" || key === "breakLength" ? 1 : 0;
    if (typeof number === "number" && Number.isSafeInteger(number) && number >= minimum) {
      result[key] = Math.min(number, limits[key]);
    }
  }
  const { compact, sorted, numericSeparator } = options;
  if (typeof compact === "boolean") result.compact = compact;
  if (typeof compact === "number" && Number.isSafeInteger(compact) && compact >= 0) result.compact = Math.min(compact, 100);
  if (typeof sorted === "boolean") result.sorted = sorted;
  if (typeof numericSeparator === "boolean") result.numericSeparator = numericSeparator;
  return result;
}
