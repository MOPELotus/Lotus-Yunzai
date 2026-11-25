import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isMap, isScalar, parseDocument, type Document } from "yaml";
import { readOptionalLocalConfig } from "./config.ts";
import { GlobalConfigWriteError, updateLocalConfiguration } from "./lotus-global-config-write.ts";
import { readPanelJson } from "./panel.ts";
import type { PluginLoadReport } from "./plugins/loader.ts";
import { groupRecallPermissionValues, readGroupRecallPermissions } from "./quoted-recall.ts";

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

const restart = $t("lib.panel-group-management.text_6161b3af76");
const integerLimit = 1_000_000;
const recallPermissionLabels = { all: $t("lib.panel-group-management.text_abb17b4835"), admin: $t("lib.panel-group-management.text_121a09eaac"), owner: $t("lib.panel-group-management.text_81d4acd17e"), master: $t("lib.panel-group-management.text_5294ba542d") };
const recallPermissionOptions = groupRecallPermissionValues.map(value => ({ label: recallPermissionLabels[value], value }));
const moderationFields = ({ maxGroupVerificationSeconds, groupVoteNumericLimits }: ManagedBlacklistModule): readonly Field[] => [
  { key: "whiteQQ", label: $t("lib.panel-group-management.text_cf08d40568"), type: "list", itemType: "number", path: ["whiteQQ"] },
  { key: "blackQQ", label: $t("lib.panel-group-management.text_424f55b7fe"), type: "list", itemType: "number", path: ["blackQQ"] },
  { key: "noBan", label: $t("lib.panel-group-management.text_07e6fb6a64"), type: "boolean", path: ["noBan"] },
  { key: "recallBot", label: $t("lib.panel-group-management.text_f0d5160b46"), type: "select", path: ["recallMsgPer", "bot"], options: recallPermissionOptions },
  { key: "recallMember", label: $t("lib.panel-group-management.text_0c7d02dfcb"), type: "select", path: ["recallMsgPer", "member"], options: recallPermissionOptions },
  { key: "VoteBan", label: $t("lib.panel-group-management.text_6c92684565"), type: "boolean", path: ["VoteBan"] },
  { key: "VoteKick", label: $t("lib.panel-group-management.text_ac1a819fca"), type: "boolean", path: ["VoteKick"] },
  { key: "outTime", label: $t("lib.panel-group-management.text_22c66d27ab"), type: "number", min: 1, max: groupVoteNumericLimits.outTime, path: ["outTime"] },
  { key: "minNum", label: $t("lib.panel-group-management.text_78bdca2d45"), type: "number", min: 1, max: groupVoteNumericLimits.minNum, path: ["minNum"] },
  { key: "BanTime", label: $t("lib.panel-group-management.text_75c81964d3"), type: "number", min: 1, max: groupVoteNumericLimits.BanTime, path: ["BanTime"] },
  { key: "veto", label: $t("lib.panel-group-management.text_c1cbb72669"), type: "boolean", path: ["veto"] },
  { key: "voteAdmin", label: $t("lib.panel-group-management.text_dbb944eed1"), type: "boolean", path: ["voteAdmin"] },
  { key: "noticeGroups", label: $t("lib.panel-group-management.text_383544d216"), type: "list", itemType: "number", path: ["groupAddNotice", "openGroup"] },
  { key: "noticeMessage", label: $t("lib.panel-group-management.text_7f1f0a3f11"), type: "text", multiline: true, max: 2048, path: ["groupAddNotice", "msg"] },
  { key: "verifyGroups", label: $t("lib.panel-group-management.text_ebc2706e76"), type: "list", itemType: "number", path: ["groupVerify", "openGroup"] },
  { key: "verifyMode", label: $t("lib.panel-group-management.text_7d8cfbca9a"), type: "select", path: ["groupVerify", "mode"],
    options: [$t("lib.panel-group-management.text_235532a9c1"), $t("lib.panel-group-management.text_36bab7a3de")].map(value => ({ label: value, value })) },
  { key: "verifyAttempts", label: $t("lib.panel-group-management.text_7a9f7546b5"), type: "number", min: 1, max: 100, path: ["groupVerify", "times"] },
  { key: "verifySeconds", label: $t("lib.panel-group-management.text_a74e13ad58"), type: "number", min: 1, max: maxGroupVerificationSeconds, path: ["groupVerify", "time"] },
  { key: "verifyDelay", label: $t("lib.panel-group-management.text_25482fe40f"), type: "number", min: 0, max: maxGroupVerificationSeconds, path: ["groupVerify", "DelayTime"] },
  { key: "verifyMin", label: $t("lib.panel-group-management.text_6adf7acc70"), type: "number", min: -integerLimit, max: integerLimit, path: ["groupVerify", "range", "min"] },
  { key: "verifyMax", label: $t("lib.panel-group-management.text_25bcdfac35"), type: "number", min: -integerLimit, max: integerLimit, path: ["groupVerify", "range", "max"] },
  { key: "verifyReminder", label: $t("lib.panel-group-management.text_630e2336cc"), type: "boolean", path: ["groupVerify", "remindAtLastMinute"] },
  { key: "verifyMessages", label: $t("lib.panel-group-management.text_8098a53895"), type: "json", path: ["groupVerify", "SuccessMsgs"],
    hint: $t("lib.panel-group-management.text_f8628cc347") },
];
const cardFields: readonly Field[] = [
  { key: "enable", label: $t("lib.panel-group-management.text_7c0935386b"), type: "boolean", path: ["enable"], hint: restart },
  { key: "cron", label: $t("lib.panel-group-management.text_9fcd9f5b7c"), type: "text", max: 180, path: ["cron"], hint: restart },
  { key: "nickname", label: $t("lib.panel-group-management.text_d10cbcdd29"), type: "text", max: 256, path: ["nickname"], hint: $t("lib.panel-group-management.text_d775c83c8f") },
  { key: "notGroup", label: $t("lib.panel-group-management.text_f40e328127"), type: "list", itemType: "number", path: ["notGroup"] },
  { key: "suffixes", label: $t("lib.panel-group-management.text_f27e9bc90e"), type: "list", itemType: "string", separator: "line", path: ["suffixes"], hint: restart },
];
const leaveFields: readonly Field[] = [
  { key: "enable", label: $t("lib.panel-group-management.text_c4808f4fed"), type: "boolean", path: ["enable"] },
  { key: "groups", label: $t("lib.panel-group-management.text_51b5ab5f17"), type: "list", itemType: "number", path: ["groups"] },
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
      const fields = management ? moderationFields(management) : cards ? cardFields : leaveFields;
      const publicFields = fields.map(({ path: _, ...field }) => field);
      async function readValues(): Promise<Values> {
        if (management) {
          const [values, recall] = await Promise.all([management.readGroupManagementPanelValues(root), readGroupRecallPermissions(root)]);
          if (!recall) throw new GlobalConfigWriteError("config");
          return { ...values, recallBot: recall.bot, recallMember: recall.member };
        }
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
      if (!record(body) || !record(body.previous) || !validValues(fields, body.values)) return invalid($t("lib.panel-group-management.text_f937ebd00d"));
      const { previous, values } = body;
      if (name === "groupAdmin" && Number(values.verifyMin) >= Number(values.verifyMax)) return invalid($t("lib.panel-group-management.text_27a6c3d920"));
      if (cards) {
        try {
          const card = cards.parseAutoGroupCardSettings(values);
          if (typeof values.cron !== "string" || !values.cron.trim() || !validateCron(card.cron)) return invalid($t("lib.panel-group-management.text_b2d3ccf9c7"));
        } catch { return invalid($t("lib.panel-group-management.text_0dc9d7f6e2")); }
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
