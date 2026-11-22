import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isAlias, isMap, isNode, isSeq, parseDocument, type Node } from "yaml";
import { readLotusGlobalConfig } from "./lotus-global-config.ts";
import { GlobalConfigWriteError, updateLotusGlobalConfig } from "./lotus-global-config-write.ts";
import { readPanelJson } from "./panel.ts";
import { partnerNumbers, partnerScheduleDefault, type PartnerPanelSettings, type PartnerPanelSnapshot } from "./panel-partner-schema.ts";
import { insertSourcePairs, replaceSourceScalar, sourceAliasOverrides, sourceMappingPair, type Pair, type SourceEdit } from "./yaml-source-edits.ts";

type Config = Readonly<Record<string, unknown>>;
type Patch = Partial<PartnerPanelSettings>;
const defaultComments = ["打卡支持"];
const numericDefaults = { login_timeout_ms: 300000, login_poll_ms: 3000, delay_ms_min: 8000, delay_ms_max: 11000,
  review_max_chars: 140, review_timeout_ms: 180000 };

function record(value: unknown): Config | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Config;
}

function int(value: unknown, min: number, max: number): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max) return value;
}

function commentPool(values: unknown): string[] {
  const source = Array.isArray(values) && values.length ? values : defaultComments;
  return [...new Set(source.filter((entry): entry is string => typeof entry === "string").map(entry => entry.trim()).filter(Boolean))];
}

function snapshot(document: Config): PartnerPanelSnapshot {
  const partner = record(document.netease_partner) ?? {};
  const review = record(partner.review) ?? {};
  const settings: PartnerPanelSettings = {
    ...numericDefaults,
    enable: partner.enable === true,
    schedule: typeof partner.schedule === "string" && partner.schedule.length ? partner.schedule : partnerScheduleDefault,
    auto_catch_up: partner.auto_catch_up === true,
    notify_master: partner.notify_master !== false,
    comments: commentPool(partner.comments),
  };
  for (const { key, min, max } of partnerNumbers) {
    const value = key.startsWith("review_") ? review[key.slice(7)] : partner[key];
    settings[key] = int(value, min, max) ?? numericDefaults[key];
  }
  const mode = review.mode;
  const reviewMode = !mode || mode === "fixed" ? "fixed" : mode === "responses" || mode === "codex" ? mode : "unknown";
  return { settings, reviewMode, revision: createHash("sha256").update(JSON.stringify([settings, reviewMode])).digest("hex") };
}

function readChanges(value: unknown): Patch {
  const fields = record(value);
  if (!fields || !Object.keys(fields).length) throw new Error();
  const changes: Patch = {};
  for (const [key, input] of Object.entries(fields)) {
    if ((key === "enable" || key === "auto_catch_up" || key === "notify_master") && typeof input === "boolean") changes[key] = input;
    else if (key === "schedule" && typeof input === "string" && input.length <= 160) changes.schedule = input.trim() || partnerScheduleDefault;
    else if (key === "comments" && Array.isArray(input) && input.length <= 100 &&
        input.every(entry => typeof entry === "string" && entry.length <= 500) && input.join("\n").length <= 16000) {
      changes.comments = commentPool(input.map(entry => entry.trim()).filter(Boolean));
    } else {
      const field = partnerNumbers.find(field => field.key === key);
      const number = field && int(input, field.min, field.max);
      if (!field || number === undefined) throw new Error();
      changes[field.key] = number;
    }
  }
  return changes;
}

function editPartner(text: string, local: Config, effective: Config, changes: Patch) {
  const yaml = parseDocument(text, { strict: true, merge: true, uniqueKeys: true, keepSourceTokens: true });
  if (yaml.errors.length || (yaml.contents && !isMap(yaml.contents))) throw new GlobalConfigWriteError("config");
  const prior = record(effective.netease_partner);
  if (effective.netease_partner !== undefined && !prior) throw new GlobalConfigWriteError("config");
  const { review_max_chars, review_timeout_ms, ...top } = changes;
  const review = { ...(review_max_chars === undefined ? {} : { max_chars: review_max_chars }),
    ...(review_timeout_ms === undefined ? {} : { timeout_ms: review_timeout_ms }) };
  const currentReview = record(prior?.review);
  const editReview = Object.keys(review).length > 0;
  if (editReview && prior?.review !== undefined && !currentReview) throw new GlobalConfigWriteError("config");
  const nextReview = editReview ? { ...currentReview, ...review } : undefined;
  const partner = { ...prior, ...top, ...(nextReview ? { review: nextReview } : {}) };
  const edits: SourceEdit[] = [];
  function insert(node: Node | undefined, additions: Pair[]) {
    if (!additions.length) return;
    if (isAlias(node)) edits.push(sourceAliasOverrides(text, node, additions));
    else if (node === undefined || isMap(node)) edits.push(insertSourcePairs(text, node, additions));
    else throw new GlobalConfigWriteError("config");
  }
  function writeValues(node: Node, values: Config, additions: Pair[]) {
    for (const [key, value] of Object.entries(values)) {
      const source = isMap(node) ? node.get(key, true) : undefined;
      const flow = JSON.stringify(value);
      if (key === "comments" && isSeq(source) && source.range) {
        const [start, end] = source.range;
        const tail = /\r?\n$/u.exec(text.slice(start, end))?.[0] ?? "";
        const block = source.srcToken?.type === "block-seq";
        edits.push({ start, end, value: (block ? "  " : "") + flow + tail });
      } else if (isNode(source)) edits.push(replaceSourceScalar(text, source, flow));
      else additions.push({ key, flow, block: [`${key}: ${flow}`] });
    }
  }
  const source = isMap(yaml.contents) ? yaml.contents.get("netease_partner", true) : undefined;
  if (!isNode(source)) insert(yaml.contents ?? undefined, [sourceMappingPair("netease_partner", partner)]);
  else {
    const additions: Pair[] = [];
    writeValues(source, top, additions);
    if (nextReview) {
      const reviewSource = isMap(source) ? source.get("review", true) : undefined;
      if (isNode(reviewSource)) {
        const reviewAdditions: Pair[] = [];
        writeValues(reviewSource, review, reviewAdditions);
        insert(reviewSource, reviewAdditions);
      } else additions.push(sourceMappingPair("review", nextReview));
    }
    insert(source, additions);
  }
  const result = edits.sort((a, b) => b.start - a.start || b.end - a.end)
    .reduce((content, edit) => content.slice(0, edit.start) + edit.value + content.slice(edit.end), text);
  if (!isDeepStrictEqual(Bun.YAML.parse(result), { ...local, netease_partner: partner })) throw new GlobalConfigWriteError("config");
  return { yaml: result, value: snapshot({ netease_partner: partner }) };
}

class PartnerInputError extends Error {}

export async function enablePartnerAfterLogin(
  root: URL, signal: AbortSignal, canWrite: (effective: Config) => boolean,
): Promise<void> {
  await updateLotusGlobalConfig(root, {
    signal,
    canWrite,
    prepare(text, local, effective) {
      if (record(effective.netease_partner)?.enable === true) return { value: undefined };
      return { yaml: editPartner(text, local, effective, { enable: true }).yaml, value: undefined };
    },
  });
}

export function panelPartner(root: URL, validModuleCron: (cron: string) => boolean) {
  return async (request: Request, stillAuthorized: () => boolean): Promise<Response> => {
    if (request.method === "GET") {
      try { return Response.json(snapshot(await readLotusGlobalConfig(root))); }
      catch { return new Response(null, { status: 500 }); }
    }
    if (request.method !== "PUT") return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } });
    let revision: string;
    let patch: Patch;
    try {
      const body = record(await readPanelJson(request, 65536));
      if (!body || Object.keys(body).length !== 2 || typeof body.revision !== "string" || !/^[a-f0-9]{64}$/u.test(body.revision)) throw new Error();
      revision = body.revision;
      patch = readChanges(body.patch);
    } catch { return new Response(null, { status: 400 }); }

    if (patch.schedule !== undefined) {
      let parse: typeof import("../plugins/media/services/music/partner-schedule.ts").partnerCron;
      try { ({ partnerCron: parse } = await import("../plugins/media/services/music/partner-schedule.ts")); }
      catch { return new Response(null, { status: 503 }); }
      try {
        if (!validModuleCron(parse(patch.schedule))) throw new Error();
      } catch { return Response.json({ field: "schedule" }, { status: 400 }); }
    }

    const active = () => !request.signal.aborted && stillAuthorized();
    try {
      return Response.json(await updateLotusGlobalConfig(root, {
        canWrite: active, canCommit: active, signal: request.signal,
        prepare(text, local, effective) {
          const before = snapshot(effective);
          if (before.revision !== revision) throw new GlobalConfigWriteError("conflict");
          if (patch.delay_ms_min !== undefined || patch.delay_ms_max !== undefined) {
            const min = patch.delay_ms_min ?? before.settings.delay_ms_min;
            const max = patch.delay_ms_max ?? before.settings.delay_ms_max;
            if (max !== 0 && min > max) throw new PartnerInputError();
          }
          const changes = Object.fromEntries(Object.entries(patch).filter(([key, value]) => !isDeepStrictEqual(before.settings[key as keyof Patch], value)));
          if (!Object.keys(changes).length) return { value: before };
          return editPartner(text, local, effective, changes);
        },
      }));
    } catch (error) {
      if (error instanceof PartnerInputError) return Response.json({ field: "delay_ms_max" }, { status: 400 });
      const reason = error instanceof GlobalConfigWriteError ? error.reason : undefined;
      return new Response(null, { status: reason === "conflict" ? 409 : reason === "permission" || reason === "cancelled" ? 401 : 500 });
    }
  };
}
