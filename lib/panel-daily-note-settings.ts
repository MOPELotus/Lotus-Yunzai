import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { isDeepStrictEqual } from "node:util";
import { isAlias, isMap, parseDocument } from "yaml";
import { dailyNoteReminderCooldown, dailyNoteReminderCron, dailyNoteReminderMessage } from "./daily-note-reminders.ts";
import { GlobalConfigWriteError, updateLotusGlobalConfig } from "./lotus-global-config-write.ts";
import { readLotusGlobalConfig } from "./lotus-global-config.ts";
import { readPanelJson } from "./panel.ts";

const sectionKey = "daily_note_reminders";
const restart = $t("lib.panel-daily-note-settings.text_d3d0842647");
const modes = [
  { label: $t("lib.panel-daily-note-settings.text_e932989fd5"), value: "interval" },
  { label: $t("lib.panel-daily-note-settings.text_0761eeecfb"), value: "cron" },
  { label: $t("lib.panel-daily-note-settings.text_42ab6c2f6c"), value: "paused" },
] as const;
type Schedule = (typeof modes)[number]["value"];
type Values = { enable: boolean; cooldown_hours: number; schedule: Schedule; cron: string; message: string };
type Document = Readonly<Record<string, unknown>>;

const fields = [
  { key: "enable", label: $t("lib.panel-daily-note-settings.text_79054e5675"), type: "boolean", hint: restart },
  { key: "cooldown_hours", label: $t("lib.panel-daily-note-settings.text_6c339b710e"), type: "number", hint: $t("lib.panel-daily-note-settings.text_77233c2a21") + restart },
  { key: "schedule", label: $t("lib.panel-daily-note-settings.text_234a02f376"), type: "select", options: modes, hint: restart },
  { key: "cron", label: $t("lib.panel-daily-note-settings.text_2cd7e30a6f"), type: "text", hint: $t("lib.panel-daily-note-settings.text_26a3ac41df") + restart },
  { key: "message", label: $t("lib.panel-daily-note-settings.text_e6c984fcb2"), type: "text", multiline: true, hint: $t("lib.panel-daily-note-settings.text_3d74e40bec") + restart },
] as const;

function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
}

function snapshot(config: Document): Values {
  const settings = record(config[sectionKey]);
  const hours = settings?.cooldown_hours;
  const cron = settings?.cron;
  const validCron = dailyNoteReminderCron(cron);
  return {
    enable: settings?.enable === true,
    cooldown_hours: dailyNoteReminderCooldown(hours) === undefined ? 12 : Number(hours),
    schedule: cron === undefined ? "interval" : validCron ? "cron" : "paused",
    cron: validCron && typeof cron === "string" ? cron.trim() : "",
    message: dailyNoteReminderMessage(settings?.message) ?? "",
  };
}

function decode(input: unknown): Values | undefined {
  const values = record(input);
  if (!values || Object.keys(values).length !== fields.length || fields.some(({ key }) => !Object.hasOwn(values, key))) return;
  const { enable, cooldown_hours, schedule, cron, message } = values;
  if (typeof enable !== "boolean" || typeof cooldown_hours !== "number" ||
      dailyNoteReminderCooldown(cooldown_hours) === undefined ||
      (schedule !== "interval" && schedule !== "cron" && schedule !== "paused") ||
      typeof cron !== "string" || cron.length > 160 || typeof message !== "string" ||
      dailyNoteReminderMessage(message) === undefined) return;
  return { enable, cooldown_hours, schedule, cron, message };
}

function edit(text: string, local: Document, mutations: ReadonlyMap<string, unknown>) {
  const doc = parseDocument(text, { strict: true, uniqueKeys: true, merge: true });
  if (doc.errors.length || (doc.contents && !isMap(doc.contents))) throw new GlobalConfigWriteError("config");
  const before = record(local[sectionKey]);
  const next = { ...before };
  const node = doc.get(sectionKey, true);
  for (const [key, value] of mutations) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  // Removing an inherited Cron must also remove it from the override mapping's effective value.
  const useDefaultInterval = mutations.has("cron") && mutations.get("cron") === undefined;
  if (isAlias(node) && !useDefaultInterval) {
    const alias = node.clone();
    alias.commentBefore = undefined;
    alias.comment = undefined;
    const replacement = doc.createNode({ "<<": alias });
    replacement.commentBefore = node.commentBefore;
    replacement.comment = node.comment;
    doc.set(sectionKey, replacement);
  }
  if (isMap(doc.get(sectionKey, true))) {
    for (const [key, value] of mutations) {
      if (value === undefined) doc.deleteIn([sectionKey, key]);
      else doc.setIn([sectionKey, key], value);
    }
  } else {
    doc.set(sectionKey, next);
  }
  const expected = { ...local, [sectionKey]: next };
  let yaml = doc.toString({ lineWidth: 0 });
  if (useDefaultInterval &&
      Object.hasOwn(record((Bun.YAML.parse(yaml) as Document)[sectionKey]) ?? {}, "cron")) {
    // YAML merge keys cannot mask a member by deleting just its local override.
    doc.set(sectionKey, next);
    yaml = doc.toString({ lineWidth: 0 });
  }
  if (!isDeepStrictEqual(Bun.YAML.parse(yaml), expected)) throw new GlobalConfigWriteError("config");
  return { yaml, value: { fields, values: snapshot({ [sectionKey]: next }), warning: $t("lib.panel-daily-note-settings.text_0c39d46c51") } };
}

class InvalidSchedule extends Error {}

export function panelDailyNoteSettings(root: URL, validateCron: (rule: string) => boolean) {
  return async (request: Request, stillAuthorized: () => boolean): Promise<Response> => {
    const active = () => !request.signal.aborted && stillAuthorized();
    if (!active()) return new Response(null, { status: 401 });
    if (request.method === "GET") {
      try {
        const values = snapshot(await readLotusGlobalConfig(root));
        return active() ? Response.json({ fields, values }) : new Response(null, { status: 401 });
      } catch {
        return new Response(null, { status: 500 });
      }
    }
    if (request.method !== "PUT") return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } });
    const body = record(await readPanelJson(request).catch(() => undefined));
    const previous = decode(body?.previous);
    const next = decode(body?.values);
    if (!body || Object.keys(body).length !== 2 || !previous || !next) return new Response(null, { status: 400 });
    try {
      const result = await updateLotusGlobalConfig(root, {
        canWrite: active, canCommit: active, signal: request.signal,
        prepare(text, local, effective) {
          const current = snapshot(effective);
          if (!isDeepStrictEqual(previous, current)) throw new GlobalConfigWriteError("conflict");
          const mutations = new Map<string, unknown>();
          for (const key of ["enable", "cooldown_hours", "message"] as const) {
            if (next[key] !== current[key]) mutations.set(key, key === "message" ? dailyNoteReminderMessage(next[key]) : next[key]);
          }
          const cron = next.cron.trim();
          if (next.schedule === "cron" && (cron !== current.cron || next.schedule !== current.schedule)) {
            if (!dailyNoteReminderCron(cron) || !validateCron(cron)) throw new InvalidSchedule($t("lib.panel-daily-note-settings.text_05be943ba5"));
            mutations.set("cron", cron);
          } else if (next.schedule !== current.schedule) {
            mutations.set("cron", next.schedule === "paused" ? null : undefined);
          } else if (next.schedule !== "cron" && cron !== current.cron) {
            throw new InvalidSchedule($t("lib.panel-daily-note-settings.text_14a3d13fbc"));
          }
          return mutations.size ? edit(text, local, mutations) : { value: { fields, values: current } };
        },
      });
      return Response.json(result);
    } catch (error) {
      if (error instanceof InvalidSchedule) return Response.json({ message: error.message }, { status: 400 });
      const reason = error instanceof GlobalConfigWriteError ? error.reason : undefined;
      return new Response(null, { status: reason === "conflict" ? 409 : reason === "permission" || reason === "cancelled" ? 401 : 500 });
    }
  };
}
