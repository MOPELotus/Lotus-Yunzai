import type { CommandContext } from "./commands.ts";
import { formatShanghaiDate } from "./shanghai-date.ts";

type Scope = "total" | "user:*" | "group:*" | `bot:${number}` | `user:${number}` | `group:${number}`;

interface Counts {
  available(): boolean;
  read(kind: string, scope: Scope, bucket: string): Promise<{ receive: string; send: string }>;
}

interface Target {
  readonly scope: Scope;
  readonly label: string;
}

const objectFields = [["机器人", "bot"], ["用户", "user"], ["群", "group"]] as const;
const allowedFields = new Set<string>([...objectFields.map(([label]) => label), "消息", "日期"]);
const usage = "用法：#统计 [机器人 QQ] [用户 QQ] [群 群号] [消息 类型] [日期 YYYY-MM-DD]。";
const unavailable = "消息统计暂不可用，请稍后重试。";

function options(argument: string) {
  const text = argument.trim();
  const parts = text ? text.split(/\s+/u) : [];
  if (parts.length % 2 !== 0 || parts.length > allowedFields.size * 2) return;
  const result = new Map<string, string>();
  for (let i = 0; i < parts.length; i += 2) {
    const key = parts[i]!;
    if (!allowedFields.has(key) || result.has(key)) return;
    result.set(key, parts[i + 1]!);
  }
  return result;
}

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function readId(text: string): number | undefined {
  if (!/^[1-9]\d*$/u.test(text)) return;
  const value = Number(text);
  return isId(value) ? value : undefined;
}

function target(label: string, scope: "bot" | "user" | "group", id: number): Target {
  return { scope: `${scope}:${id}`, label: `${label} ${id}` };
}

function currentTargets(context: CommandContext, master: boolean): Target[] {
  const targets: Target[] = [];
  if (master && isId(context.self_id)) targets.push(target("机器人", "bot", context.self_id));
  if (isId(context.user_id)) targets.push(target("用户", "user", context.user_id));
  if (context.message_type === "group" && isId(context.group_id)) targets.push(target("群", "group", context.group_id));
  return targets;
}

function yearMonth(date: Date): [string, string] {
  return [String(date.getUTCFullYear()).padStart(4, "0"), String(date.getUTCMonth() + 1).padStart(2, "0")];
}

function dateBucket(date: Date): string {
  return [...yearMonth(date), String(date.getUTCDate()).padStart(2, "0")].join(":");
}

function requestedDay(value: string, anchor: Date): string | undefined {
  let year = anchor.getUTCFullYear();
  let month = anchor.getUTCMonth() + 1;
  let day: number;
  if (/^\d{8}$/u.test(value)) {
    year = Number(value.slice(0, 4));
    month = Number(value.slice(4, 6));
    day = Number(value.slice(6));
  } else if (/^\d{4}$/u.test(value)) {
    month = Number(value.slice(0, 2));
    day = Number(value.slice(2));
  } else if (/^\d{1,2}日?$/u.test(value)) {
    day = Number(value.replace(/日$/u, ""));
  } else {
    const normalized = value.replace(/[年月/.]/gu, "-").replace(/日$/u, "");
    const parts = /^(?:(\d{4})-)?(\d{1,2})-(\d{1,2})$/u.exec(normalized);
    if (!parts) return;
    if (parts[1]) year = Number(parts[1]);
    month = Number(parts[2]);
    day = Number(parts[3]);
  }
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return;

  const date = new Date(anchor);
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day) return dateBucket(date);
}

function defaultBuckets(anchor: Date): readonly string[] {
  const date = new Date(anchor);
  const buckets = [dateBucket(date)];
  for (let offset = 1; offset < 3; offset++) {
    date.setUTCDate(date.getUTCDate() - 1);
    buckets.push(dateBucket(date));
  }
  const [year, month] = yearMonth(anchor);
  return [...buckets, `${year}:${month}`, year, "total"];
}

function countText(value: string): string {
  return typeof value === "string" && /^\d{1,20}$/u.test(value) ? value : "—";
}

export function createMessageStatistics(counts: Counts, now: () => Date = () => new Date()) {
  return async (argument: string, context: CommandContext): Promise<string> => {
    const input = options(argument);
    if (!input) return usage;
    const master = context.isMaster === true;
    const selected: Target[] = [];
    for (const [label, scope] of objectFields) {
      const value = input.get(label);
      if (value === undefined) continue;
      if (!master) return "仅当前机器人的主人可以指定统计对象。";
      const id = readId(value);
      if (!id) return `${label}须为有效的 QQ 或群号。`;
      selected.push(target(label, scope, id));
    }

    const kind = input.get("消息") ?? "msg";
    if (!/^[A-Za-z0-9_-]{1,32}$/u.test(kind)) return "消息类型无效，例如 msg、text、image。";

    const targets = selected.length > 0 ? selected : [
      ...(master ? [
        { scope: "total", label: "总消息量" },
        { scope: "user:*", label: "用户量" },
        { scope: "group:*", label: "群量" },
      ] as const : []),
      ...currentTargets(context, master),
    ];
    if (!targets.length) return "当前会话没有可查询的用户或群。";

    try {
      const instant = now();
      if (!Number.isFinite(instant.getTime())) return unavailable;
      // Use UTC for calendar arithmetic after resolving the original host's current day.
      const anchor = new Date(`${formatShanghaiDate(instant)}T00:00:00Z`);
      const day = input.get("日期");
      const selectedDay = day === undefined ? undefined : requestedDay(day, anchor);
      if (day !== undefined && selectedDay === undefined) return "日期无效，请使用 YYYY-MM-DD、MMDD 或 DD。";
      const buckets = selectedDay ? [selectedDay] : defaultBuckets(anchor);
      if (!counts.available()) return unavailable;

      const sections = [kind === "msg" ? "消息统计" : `${kind} 消息统计`];
      for (const { scope, label } of targets) {
        const rows = [label];
        for (const bucket of buckets) {
          const { receive, send } = await counts.read(kind, scope, bucket);
          const date = bucket === "total" ? "总计" : bucket.replaceAll(":", "-");
          rows.push(`${date} 收 ${countText(receive)} 发 ${countText(send)}`);
        }
        sections.push(rows.join("\n"));
      }
      return sections.join("\n\n");
    } catch {
      return unavailable;
    }
  };
}
