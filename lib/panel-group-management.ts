import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isMap, isScalar, parseDocument, type Document } from "yaml";
import { readOptionalLocalConfig } from "./config.ts";
import { GlobalConfigWriteError, updateLocalConfiguration } from "./lotus-global-config-write.ts";
import { readPanelJson } from "./panel.ts";
import type { PluginLoadReport } from "./plugins/loader.ts";

type ManagedBlacklistModule = typeof import("../plugins/group/managed-blacklist.ts");
type AutoGroupCardModule = typeof import("../plugins/group/auto-group-card.ts");

type Values = Record<string, unknown>;
type Key = string | number;
type ConfigurationName = "groupAdmin" | "auto-group-card" | "group-leave-blacklist";
interface Field {
  readonly key: string;
  readonly label: string;
  readonly type: "boolean" | "text" | "number" | "list" | "select" | "json";
  readonly path: readonly string[];
  readonly itemType?: "number" | "string";
  readonly options?: readonly { label: string; value: string }[];
  readonly min?: number;
  readonly max?: number;
  readonly multiline?: boolean;
  readonly separator?: "line";
  readonly hint?: string;
}

const restart = "定时任务在重启宿主后重新载入。";
const integerLimit = 1_000_000;
const moderationFields = (maxGroupVerificationSeconds: number): readonly Field[] => [
  { key: "noticeGroups", label: "向群管理员提醒入群申请的群", type: "list", itemType: "number", path: ["groupAddNotice", "openGroup"] },
  { key: "noticeMessage", label: "入群申请提醒文案", type: "text", multiline: true, max: 2048, path: ["groupAddNotice", "msg"] },
  { key: "verifyGroups", label: "启用入群验证的群", type: "list", itemType: "number", path: ["groupVerify", "openGroup"] },
  { key: "verifyMode", label: "入群验证匹配方式", type: "select", path: ["groupVerify", "mode"],
    options: ["精确", "模糊"].map(value => ({ label: value, value })) },
  { key: "verifyAttempts", label: "验证尝试次数", type: "number", min: 1, max: 100, path: ["groupVerify", "times"] },
  { key: "verifySeconds", label: "验证时限（秒）", type: "number", min: 1, max: maxGroupVerificationSeconds, path: ["groupVerify", "time"] },
  { key: "verifyDelay", label: "发送题目前等待（秒）", type: "number", min: 0, max: maxGroupVerificationSeconds, path: ["groupVerify", "DelayTime"] },
  { key: "verifyMin", label: "题目取值下限", type: "number", min: -integerLimit, max: integerLimit, path: ["groupVerify", "range", "min"] },
  { key: "verifyMax", label: "题目取值上限", type: "number", min: -integerLimit, max: integerLimit, path: ["groupVerify", "range", "max"] },
  { key: "verifyReminder", label: "最后一分钟提醒", type: "boolean", path: ["groupVerify", "remindAtLastMinute"] },
  { key: "verifyMessages", label: "验证成功文案", type: "json", path: ["groupVerify", "SuccessMsgs"],
    hint: '填写群号与文案组成的 JSON 对象。键 "0" 为默认文案。' },
];
const cardFields: readonly Field[] = [
  { key: "enable", label: "启用自动群名片", type: "boolean", path: ["enable"], hint: restart },
  { key: "cron", label: "更新群名片计划（Cron）", type: "text", max: 180, path: ["cron"], hint: restart },
  { key: "nickname", label: "机器人群名片昵称", type: "text", max: 256, path: ["nickname"], hint: "留空使用各机器人当前昵称。" },
  { key: "notGroup", label: "不自动更新的群", type: "list", itemType: "number", path: ["notGroup"] },
  { key: "suffixes", label: "群名片候选文案", type: "list", itemType: "string", separator: "line", path: ["suffixes"], hint: restart },
];
const leaveFields: readonly Field[] = [
  { key: "enable", label: "启用退群拉黑", type: "boolean", path: ["enable"] },
  { key: "groups", label: "启用退群拉黑的群", type: "list", itemType: "number", path: ["groups"] },
];

function record(value: unknown): value is Values {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validValue(field: Field, value: unknown): boolean {
  switch (field.type) {
    case "boolean": return typeof value === "boolean";
    case "text": return typeof value === "string" && value.isWellFormed() && value.length <= (field.max ?? Infinity);
    case "number": return typeof value === "number" && Number.isSafeInteger(value) && value >= (field.min ?? -Infinity) && value <= (field.max ?? Infinity);
    case "list": return Array.isArray(value) && value.length <= 4_000 && (field.itemType === "number"
      ? value.every(positiveId)
      : value.every(item => typeof item === "string" && item.isWellFormed() && item.length <= 256));
    case "select": return field.options?.some(option => option.value === value) === true;
    case "json": return record(value) && Object.keys(value).length <= 4_000 && Object.entries(value).every(([id, text]) =>
      /^(?:0|[1-9]\d*)$/u.test(id) && Number.isSafeInteger(Number(id)) && typeof text === "string" &&
      text.isWellFormed() && text.length <= 2048);
  }
}

function validValues(fields: readonly Field[], values: unknown): values is Values {
  return record(values) && Object.keys(values).length === fields.length && fields.every(field =>
    Object.hasOwn(values, field.key) && validValue(field, values[field.key]));
}

function invalid(message: string) { return Response.json({ message }, { status: 400 }); }

export function panelGroupManagement(root: URL, directories: PluginLoadReport["directories"], name: ConfigurationName,
  validateCron: (cron: string) => boolean,
) {
  return async (request: Request, stillAuthorized: () => boolean): Promise<Response> => {
    const active = () => !request.signal.aborted && stillAuthorized();
    if (!active()) return new Response(null, { status: 401 });
    if (request.method !== "GET" && request.method !== "PUT") return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } });
    const group = directories.get("group");
    if (!group || group.packageName !== "@lotus-yunzai/group") return new Response(null, { status: 404 });
    const registered = () => directories.get("group") === group;
    try {
      const management = name === "groupAdmin" ? await import(pathToFileURL(join(group.path, "managed-blacklist.ts")).href) as ManagedBlacklistModule : undefined;
      const cards = name === "auto-group-card" ? await import(pathToFileURL(join(group.path, "auto-group-card.ts")).href) as AutoGroupCardModule : undefined;
      const fields = management ? moderationFields(management.maxGroupVerificationSeconds) : cards ? cardFields : leaveFields;
      const publicFields = fields.map(({ path: _, ...field }) => field);
      async function readValues(): Promise<Values> {
        if (management) return management.readGroupManagementPanelValues(root);
        const raw = await readOptionalLocalConfig(root, name);
        if (cards) {
          const card = cards.parseAutoGroupCardSettings(raw ?? { enable: false });
          return { enable: card.enabled, cron: card.cron, nickname: card.nickname ?? "", notGroup: [...card.notGroup], suffixes: card.suffixes };
        }
        const groups = raw?.groups ?? [];
        if (!Array.isArray(groups)) throw new GlobalConfigWriteError("config");
        const ids = groups.map(value => typeof value === "string" && /^[1-9]\d*$/u.test(value) ? Number(value) : value);
        if (!ids.every(positiveId)) throw new GlobalConfigWriteError("config");
        return { enable: raw?.enable === true, groups: [...new Set(ids)] };
      }
      if (request.method === "GET") {
        const values = await readValues();
        return !active() ? new Response(null, { status: 401 }) : !registered() ? new Response(null, { status: 409 }) :
          Response.json({ fields: publicFields, values });
      }
      const body = await readPanelJson(request).catch(() => undefined);
      if (!record(body) || !record(body.previous) || !validValues(fields, body.values)) return invalid("群管设置格式有误。");
      const { previous, values } = body;
      if (name === "groupAdmin" && Number(values.verifyMin) >= Number(values.verifyMax)) return invalid("题目取值下限须小于上限。");
      if (cards) {
        try {
          const card = cards.parseAutoGroupCardSettings(values);
          if (typeof values.cron !== "string" || !values.cron.trim() || !validateCron(card.cron)) return invalid("群名片 Cron 表达式无效。");
        } catch { return invalid("群名片昵称和候选文案须填写有效的单行文字。"); }
      }

      await updateLocalConfiguration(root, name, {
        signal: request.signal, canWrite: () => active() && registered(), canCommit: () => active() && registered(), resolveEffective: readValues,
        prepare(content, local, current) {
          if (!isDeepStrictEqual(previous, current)) throw new GlobalConfigWriteError("conflict");
          const changed = fields.filter(({ key }) => !isDeepStrictEqual(current[key], values[key]));
          if (!changed.length) return { value: undefined };
          const doc: Document = parseDocument(content, { merge: true, strict: true, uniqueKeys: true });
          if (doc.errors.length || (doc.contents && !isMap(doc.contents) && !(isScalar(doc.contents) && doc.contents.value === null))) {
            throw new GlobalConfigWriteError("config");
          }
          if (isScalar(doc.contents) && doc.contents.value === null) doc.contents = doc.createNode({});
          const expected: Values = structuredClone(local);
          function set(path: readonly Key[], value: unknown) {
            let target = expected;
            for (const [index, key] of path.slice(0, -1).entries()) {
              const property = String(key);
              if (!Object.hasOwn(target, property) || target[property] == null) {
                target[property] = {};
                doc.setIn(path.slice(0, index + 1), doc.createNode({}));
              }
              if (!record(target[property])) throw new GlobalConfigWriteError("config");
              target = target[property];
            }
            target[String(path.at(-1))] = value;
            doc.setIn(path, value);
          }
          for (const { key, path } of changed) {
            if (key !== "verifyMessages") {
              set(path, values[key]);
              continue;
            }
            const oldMessages = current[key], newMessages = values[key];
            if (!record(oldMessages) || !record(newMessages)) throw new GlobalConfigWriteError("config");
            for (const id of new Set([...Object.keys(oldMessages), ...Object.keys(newMessages)])) {
              if (oldMessages[id] === newMessages[id]) continue;
              // An empty local entry suppresses the same group’s old message and falls through to the default.
              const storageKey = doc.hasIn([...path, Number(id)]) ? Number(id) : id;
              set([...path, storageKey], newMessages[id] ?? "");
            }
          }
          if (name === "auto-group-card" && !content && !changed.some(({ key }) => key === "enable")) set(["enable"], values.enable);
          const yaml = doc.toString({ lineWidth: 0 });
          if (!isDeepStrictEqual(Bun.YAML.parse(yaml), expected)) throw new GlobalConfigWriteError("config");
          return { value: undefined, yaml };
        },
      });
      const saved = await readValues();
      return !active() ? new Response(null, { status: 401 }) : !registered() ? new Response(null, { status: 409 }) :
        Response.json({ fields: publicFields, values: saved });
    } catch (error) {
      return new Response(null, { status: !active() ? 401 :
        !registered() || (error instanceof GlobalConfigWriteError && error.reason === "conflict") ? 409 : 503 });
    }
  };
}
