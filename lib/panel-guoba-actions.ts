import type { GuobaButton, GuobaField, GuobaInput } from "./panel-guoba.ts";

type Argument = string | number | boolean | null | Argument[] | { [key: string]: Argument };
type Handler = (args: Argument[], context: { Result: unknown }) => unknown;
interface Action {
  readonly button: GuobaButton;
  readonly name: string;
  readonly args: readonly Argument[];
  readonly handler: Handler;
}

const placeholder = /#\{([^}]+)\}/gu;
const forbidden = new Set(["__proto__", "constructor", "prototype"]);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function argument(value: unknown, depth = 0): Argument {
  if (typeof value === "string" && value.length <= 4096) return value;
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (depth < 4 && Array.isArray(value) && value.length <= 32) return value.map(item => argument(item, depth + 1));
  if (depth < 4 && record(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    const entries = Object.entries(value);
    if (entries.length <= 32 && entries.every(([key]) => key.length <= 100 && !forbidden.has(key))) {
      return Object.fromEntries(entries.map(([key, item]) => [key, argument(item, depth + 1)]));
    }
  }
  throw new TypeError("插件按钮参数不受支持。");
}

function buttonText(input: unknown, max: number) {
  return typeof input === "string" && input.trim() && input.length <= max ? input : undefined;
}

export function guobaActions(raw: readonly unknown[], handlers: unknown, canRead: (name: string) => boolean) {
  const groups = new Map<number, GuobaField>();
  const actions = new Map<string, Action>();
  const fields = new Set<string>();
  if (!record(handlers)) return { groups, actions, fields, definition: "" };

  for (const [index, schema] of raw.entries()) {
    if (!record(schema) || schema.component !== "GButtons" ||
        (schema.ifShow !== undefined && schema.ifShow !== true) || !record(schema.componentProps) ||
        !Array.isArray(schema.componentProps.buttons) || schema.componentProps.buttons.length > 32) continue;
    const buttons: GuobaButton[] = [];
    for (const [order, source] of schema.componentProps.buttons.entries()) {
      if (!record(source) || typeof source.action !== "string" || forbidden.has(source.action) ||
          !Object.hasOwn(handlers, source.action) || typeof handlers[source.action] !== "function") continue;
      const label = buttonText(source.label, 100);
      if (!label) continue;
      const confirm = record(source.confirm) ? [
        buttonText(source.confirm.title, 120), buttonText(source.confirm.content, 500),
      ].filter(Boolean).join(" · ") : buttonText(source.confirm, 500);
      if (source.confirm && !confirm) continue;
      try {
        if (source.args !== undefined && (!Array.isArray(source.args) || source.args.length > 16)) continue;
        const args = (source.args ?? []).map((item: unknown) => argument(item));
        if (JSON.stringify(args).length > 8192) continue;
        const refs = new Set<string>();
        for (const item of args) {
          if (typeof item !== "string") continue;
          for (const match of item.matchAll(placeholder)) refs.add(match[1]!.trim());
        }
        if ([...refs].some(name => !canRead(name))) continue;
        const id = `${index}-${order}`;
        const button: GuobaButton = {
          id, label, fields: [...refs],
          ...(confirm ? { confirm } : {}),
          ...(source.disabled === true ? { disabled: true } : {}),
          ...(source.danger === true ? { type: "danger" } : source.type === "primary" ? { type: "primary" } : {}),
        };
        buttons.push(button);
        actions.set(id, { button, name: source.action, args, handler: handlers[source.action] as Handler });
        if (!button.disabled) for (const field of refs) fields.add(field);
      } catch {
        // A malformed button must not disable the rest of an otherwise usable form.
      }
    }
    if (buttons.length) groups.set(index, {
      component: "GButtons", label: buttonText(schema.label, 120) ?? "插件操作",
      componentProps: { buttons },
    });
  }
  const definition = JSON.stringify([...actions.values()].map(({ button, name, args }) => [button, name, args]));
  return { groups, actions, fields, definition };
}

export function resolveGuobaArguments(args: readonly Argument[], values: Readonly<Record<string, GuobaInput>>) {
  return args.map(value => typeof value === "string"
    ? value.replace(placeholder, (_, key: string) => String(values[key.trim()] ?? "")) : structuredClone(value));
}
