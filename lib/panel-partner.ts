import { createHmac, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isAlias, isMap, isNode, isSeq, parseDocument, type Node } from "yaml";
import { readLotusGlobalConfig } from "./lotus-global-config.ts";
import { GlobalConfigWriteError, updateLotusGlobalConfig } from "./lotus-global-config-write.ts";
import { readPanelJson } from "./panel.ts";
import { partnerEditableReviewModes, partnerNumbers, partnerResponsesDefaultUrl, partnerScheduleDefault, type PartnerEditableReviewMode,
  type PartnerPanelSettings, type PartnerPanelSnapshot } from "./panel-partner-schema.ts";
import { insertSourcePairs, replaceSourceScalar, sourceAliasOverrides, sourceMappingPair, type Pair, type SourceEdit } from "./yaml-source-edits.ts";

type Config = Readonly<Record<string, unknown>>;
type Changes = Partial<PartnerPanelSettings> & {
  review_mode?: PartnerEditableReviewMode;
  review_model?: string;
  review_api_url?: string;
  review_api_key?: string;
};
type Patch = Changes & { review_clear_api_key?: true };
const revisionKey = randomBytes(32);
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

function configuredString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function responsesUrl(value: string) {
  if (!value || /[\s\\?#\u0000-\u001f\u007f]/u.test(value)) return;
  const url = URL.parse(value);
  if (!url || url.username || url.password || url.search || url.hash) return;
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "https:" || (local && url.protocol === "http:")) return url;
}

function customCodexCommand(review: Config) {
  return Boolean(review.codex_command && review.codex_command !== "codex");
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
  const reviewMode = !mode || mode === "fixed" ? "fixed" :
    mode === "responses" || mode === "codex" || mode === "disabled" ? mode : "unknown";
  const apiUrl = configuredString(review.api_url);
  return {
    settings, reviewMode,
    review: {
      model: configuredString(review.model),
      apiOrigin: responsesUrl(apiUrl || partnerResponsesDefaultUrl)?.origin ?? "",
      apiUrlConfigured: Boolean(apiUrl),
      apiKeyConfigured: Boolean(configuredString(review.api_key)),
      customCodexCommand: customCodexCommand(review),
    },
    // Include the hidden credentials in conflict detection without exposing a digest that can be guessed offline.
    revision: createHmac("sha256", revisionKey)
      .update(JSON.stringify([settings, mode, review.model, review.api_url, review.api_key, review.codex_command])).digest("hex"),
  };
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
    } else if (key === "review_mode" && partnerEditableReviewModes.some(mode => mode === input)) {
      changes.review_mode = input as PartnerEditableReviewMode;
    } else if (key === "review_model" && typeof input === "string" && input.length <= 256 &&
        input.isWellFormed() && !/[\u0000-\u001f\u007f]/u.test(input)) {
      changes.review_model = input.trim();
    } else if (key === "review_api_url" && typeof input === "string" && input.length <= 2048) {
      if (input === "") changes.review_api_url = "";
      else {
        const target = responsesUrl(input.trim());
        if (!target) throw new PartnerInputError("review_api_url");
        changes.review_api_url = target.href;
      }
    } else if (key === "review_api_key" && typeof input === "string" && input.length <= 4096) {
      const secret = input.trim();
      if (secret) {
        if (!/^[!-~]+$/u.test(secret)) throw new PartnerInputError("review_api_key");
        changes.review_api_key = secret;
      }
    } else if (key === "review_clear_api_key" && input === true) {
      changes.review_clear_api_key = true;
    } else {
      const field = partnerNumbers.find(field => field.key === key);
      const number = field && int(input, field.min, field.max);
      if (!field || number === undefined) throw new Error();
      changes[field.key] = number;
    }
  }
  if (changes.review_clear_api_key && changes.review_api_key !== undefined) throw new PartnerInputError("review_api_key");
  return changes;
}

function editPartner(text: string, local: Config, effective: Config, changes: Changes) {
  const yaml = parseDocument(text, { strict: true, merge: true, uniqueKeys: true, keepSourceTokens: true });
  if (yaml.errors.length || (yaml.contents && !isMap(yaml.contents))) throw new GlobalConfigWriteError("config");
  const prior = record(effective.netease_partner);
  if (effective.netease_partner !== undefined && !prior) throw new GlobalConfigWriteError("config");
  const { review_max_chars, review_timeout_ms, review_mode, review_model, review_api_url, review_api_key, ...top } = changes;
  const review = {
    ...(review_max_chars === undefined ? {} : { max_chars: review_max_chars }),
    ...(review_timeout_ms === undefined ? {} : { timeout_ms: review_timeout_ms }),
    ...(review_mode === undefined ? {} : { mode: review_mode }),
    ...(review_model === undefined ? {} : { model: review_model }),
    ...(review_api_url === undefined ? {} : { api_url: review_api_url }),
    ...(review_api_key === undefined ? {} : { api_key: review_api_key }),
  };
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

class PartnerInputError extends Error {
  constructor(readonly field: string) { super(field); }
}

function partnerChanges(before: PartnerPanelSnapshot, effective: Config, patch: Patch): Changes {
  const prior = record(record(effective.netease_partner)?.review) ?? {};
  const { review_mode, review_model, review_api_url, review_api_key, review_clear_api_key, ...settings } = patch;
  if (before.reviewMode === "disabled" && (review_mode !== undefined || settings.enable === true)) {
    throw new PartnerInputError("review_local");
  }
  if (review_mode === "codex" && before.reviewMode !== "codex" && customCodexCommand(prior)) {
    throw new PartnerInputError("review_local");
  }
  const currentUrl = configuredString(prior.api_url);
  const key = review_clear_api_key ? "" : review_api_key;
  const endpointChanged = review_api_url !== undefined && review_api_url !== currentUrl;
  if (endpointChanged && before.review.apiKeyConfigured && key === undefined &&
      responsesUrl(review_api_url || partnerResponsesDefaultUrl)?.href !== responsesUrl(currentUrl || partnerResponsesDefaultUrl)?.href) {
    throw new PartnerInputError("review_api_url_key");
  }
  if (review_mode === "responses" && before.reviewMode !== "responses" &&
      (!(review_model ?? before.review.model) || !(key ?? configuredString(prior.api_key)) ||
        !responsesUrl((review_api_url ?? currentUrl) || partnerResponsesDefaultUrl))) {
    throw new PartnerInputError("review_responses");
  }
  return {
    ...Object.fromEntries(Object.entries(settings).filter(([key, value]) =>
      !isDeepStrictEqual(before.settings[key as keyof PartnerPanelSettings], value))),
    ...(review_mode !== undefined && review_mode !== before.reviewMode ? { review_mode } : {}),
    ...(review_model !== undefined && review_model !== before.review.model ? { review_model } : {}),
    ...(endpointChanged ? { review_api_url } : {}),
    ...(key !== undefined && key !== configuredString(prior.api_key) ? { review_api_key: key } : {}),
  };
}

export async function enablePartnerAfterLogin(
  root: URL, signal: AbortSignal, canWrite: (effective: Config) => boolean,
): Promise<void> {
  await updateLotusGlobalConfig(root, {
    signal,
    canWrite,
    prepare(text, local, effective) {
      const partner = record(effective.netease_partner);
      if (partner?.enable === true) return { value: undefined };
      if (record(partner?.review)?.mode === "disabled") throw new PartnerInputError("review_local");
      return { yaml: editPartner(text, local, effective, { enable: true }).yaml, value: undefined };
    },
  });
}

export function panelPartner(root: URL, validModuleCron: (cron: string) => boolean) {
  return async (request: Request, stillAuthorized: () => boolean): Promise<Response> => {
    const active = () => !request.signal.aborted && stillAuthorized();
    if (request.method === "GET") {
      if (!active()) return new Response(null, { status: 401 });
      try {
        const value = snapshot(await readLotusGlobalConfig(root));
        return active() ? Response.json(value) : new Response(null, { status: 401 });
      } catch { return new Response(null, { status: 500 }); }
    }
    if (request.method !== "PUT") return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } });
    let revision: string;
    let patch: Patch;
    try {
      const body = record(await readPanelJson(request, 65536));
      if (!body || Object.keys(body).length !== 2 || typeof body.revision !== "string" || !/^[a-f0-9]{64}$/u.test(body.revision)) throw new Error();
      revision = body.revision;
      patch = readChanges(body.patch);
    } catch (error) {
      if (error instanceof PartnerInputError) return Response.json({ field: error.field }, { status: 400 });
      return new Response(null, { status: 400 });
    }

    if (patch.schedule !== undefined) {
      let parse: typeof import("../plugins/media/services/music/partner-schedule.ts").partnerCron;
      try { ({ partnerCron: parse } = await import("../plugins/media/services/music/partner-schedule.ts")); }
      catch { return new Response(null, { status: 503 }); }
      try {
        if (!validModuleCron(parse(patch.schedule))) throw new Error();
      } catch { return Response.json({ field: "schedule" }, { status: 400 }); }
    }

    try {
      return Response.json(await updateLotusGlobalConfig(root, {
        canWrite: active, canCommit: active, signal: request.signal,
        prepare(text, local, effective) {
          const before = snapshot(effective);
          if (before.revision !== revision) throw new GlobalConfigWriteError("conflict");
          if (patch.delay_ms_min !== undefined || patch.delay_ms_max !== undefined) {
            const min = patch.delay_ms_min ?? before.settings.delay_ms_min;
            const max = patch.delay_ms_max ?? before.settings.delay_ms_max;
            if (max !== 0 && min > max) throw new PartnerInputError("delay_ms_max");
          }
          const changes = partnerChanges(before, effective, patch);
          if (!Object.keys(changes).length) return { value: before };
          return editPartner(text, local, effective, changes);
        },
      }));
    } catch (error) {
      if (error instanceof PartnerInputError) return Response.json({ field: error.field }, { status: 400 });
      const reason = error instanceof GlobalConfigWriteError ? error.reason : undefined;
      return new Response(null, { status: reason === "conflict" ? 409 : reason === "permission" || reason === "cancelled" ? 401 : 500 });
    }
  };
}
