interface PanelQueryContext {
  readonly message_type?: string;
  readonly user_id?: number;
  readonly self_id?: number;
  readonly message?: string | readonly { readonly type: string; readonly qq?: unknown }[];
}

export function panelQueryUser(context: PanelQueryContext): number | undefined {
  if (context.message_type === "group" && Array.isArray(context.message)) {
    for (const segment of context.message) {
      if (segment.type !== "at" || (typeof segment.qq !== "string" && typeof segment.qq !== "number")) continue;
      const value = String(segment.qq);
      if (!/^[1-9]\d*$/u.test(value)) continue;
      const user = Number(value);
      if (Number.isSafeInteger(user) && user !== context.self_id) return user;
    }
  }
  return context.user_id;
}
