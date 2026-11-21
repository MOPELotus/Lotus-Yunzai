import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isAlias, isMap, isScalar, parseDocument, Parser, stringify, type YAMLMap } from "yaml";
import { readLotusGlobalConfig } from "./lotus-global-config.ts";
import { GlobalConfigWriteError, updateLotusGlobalConfig } from "./lotus-global-config-write.ts";
import { miyousheWebLifetimes, miyousheWebMountPath, miyousheWebPublicUrl, miyousheWebSettings } from "./miyoushe-web.ts";
import { panelOwnerLifetimes } from "./panel-owner-session.ts";
import { readPanelJson } from "./panel.ts";
import type { WebLoginSettings, WebLoginSnapshot } from "./panel-web-login-schema.ts";

type Config = Readonly<Record<string, unknown>>;
const keys = ["enable", "public_url", "path", "ticket_minutes", "session_hours", "panel_ticket_minutes",
  "panel_session_hours"] as const satisfies readonly (keyof WebLoginSettings)[];
const allowed = new Set<string>(keys);

function record(value: unknown): value is Config {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function publicUrl(value: unknown) {
  return typeof value === "string" ? miyousheWebPublicUrl(URL.parse(value.trim())) : undefined;
}

function snapshot(config: Config): WebLoginSnapshot {
  const source = record(config.coin_shop) ? config.coin_shop : {};
  const user = miyousheWebLifetimes(source.ticket_minutes, source.session_hours);
  const owner = panelOwnerLifetimes(source);
  const settings: WebLoginSettings = {
    enable: source.enable !== false,
    public_url: publicUrl(source.public_url)?.href ?? "",
    path: miyousheWebMountPath(source.path) ?? "",
    ticket_minutes: user.ticketMinutes,
    session_hours: user.sessionHours,
    panel_ticket_minutes: owner.ticketMinutes,
    panel_session_hours: owner.sessionHours,
  };
  return { revision: createHash("sha256").update(JSON.stringify(settings)).digest("hex"), settings };
}

function patchSettings(value: unknown): Partial<WebLoginSettings> {
  if (!record(value) || !Object.keys(value).length || Object.keys(value).some(key => !allowed.has(key))) throw new Error();
  const patch: Partial<WebLoginSettings> = {};
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) continue;
    const entry = value[key];
    switch (key) {
      case "enable":
        if (typeof entry !== "boolean") throw new Error();
        patch[key] = entry;
        break;
      case "public_url": {
        if (typeof entry !== "string" || entry.length > 2048) throw new Error();
        const url = publicUrl(entry);
        if (entry.trim() && (!url || (url.pathname !== "/" && !miyousheWebMountPath(url.pathname)))) throw new Error();
        patch[key] = url?.href ?? "";
        break;
      }
      case "path": {
        if (typeof entry !== "string" || entry.length > 512) throw new Error();
        const path = miyousheWebMountPath(entry.trim());
        if (entry.trim() && !path) throw new Error();
        patch[key] = path ?? "";
        break;
      }
      case "ticket_minutes":
      case "panel_ticket_minutes":
        if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 1 ||
            !Number.isSafeInteger(Date.now() + entry * 60_000)) throw new Error();
        patch[key] = entry;
        break;
      case "session_hours":
      case "panel_session_hours":
        if (typeof entry !== "number" || entry * 3600 < 1 ||
            !Number.isSafeInteger(Date.now() + entry * 3_600_000)) throw new Error();
        patch[key] = entry;
        break;
    }
  }
  return patch;
}

type Edit = { start: number; end: number; value: string };
type Pair = { key: string; flow: string; block: string[] };

function insertPairs(text: string, map: YAMLMap | undefined, pairs: readonly Pair[]): Edit {
  const token = map?.srcToken;
  if (map && token?.type === "flow-collection") {
    const start = token.start.offset + token.start.source.length;
    const values = pairs.map(({ key, flow }) => `${key}: ${flow}`).join(", ");
    return { start, end: start, value: map.items.length ? `${values}, ` : values };
  }
  if (map && (token?.type !== "block-map" || !map.range)) throw new GlobalConfigWriteError("config");
  const indent = " ".repeat(token?.type === "block-map" ? token.indent : 0);
  const eol = /\r?\n/u.exec(text)?.[0] ?? "\n";
  const start = map?.range?.[1] ?? [...new Parser().parse(text)].find(item => item.type === "doc-end")?.offset ?? text.length;
  const before = text.slice(0, start);
  const separator = !before || before === "\uFEFF" || before.endsWith("\n") ? "" : eol;
  const suffix = start === text.length && separator ? "" : eol;
  const body = pairs.flatMap(pair => pair.block).map(line => indent + line).join(eol);
  return { start, end: start, value: separator + body + suffix };
}

function editLogin(text: string, local: Config, source: Config, patch: Partial<WebLoginSettings>) {
  const document = parseDocument(text, { strict: true, uniqueKeys: true, keepSourceTokens: true });
  if (document.errors.length || (document.contents && !isMap(document.contents))) throw new GlobalConfigWriteError("config");
  const next = { ...source, ...patch };
  const edits: Edit[] = [];
  const pairs = Object.entries(patch).map(([key, value]) => {
    const flow = JSON.stringify(value);
    return { key, flow, block: [`${key}: ${flow}`] };
  });
  if (!Object.hasOwn(local, "coin_shop")) {
    // The first local section shadows the whole old section, so bring across its other settings.
    const block = stringify(next, { lineWidth: 0 }).trimEnd().split("\n").map(line => `  ${line}`);
    edits.push(insertPairs(text, document.contents ?? undefined, [
      { key: "coin_shop", flow: JSON.stringify(next), block: ["coin_shop:", ...block] },
    ]));
  } else {
    const node = document.get("coin_shop", true);
    if (isAlias(node)) {
      if (!node.range) throw new GlobalConfigWriteError("config");
      const [start, end] = node.range;
      const fields = pairs.map(({ key, flow }) => `${key}: ${flow}`).join(", ");
      edits.push({ start, end, value: `{<<: ${text.slice(start, end)}, ${fields}}` });
    } else {
      if (!isMap(node)) throw new GlobalConfigWriteError("config");
      const additions: Pair[] = [];
      for (const pair of pairs) {
        const scalar = node.get(pair.key, true);
        if (scalar === undefined) {
          additions.push(pair);
          continue;
        }
        if ((!isScalar(scalar) && !isAlias(scalar)) || !scalar.range) throw new GlobalConfigWriteError("config");
        const [start, end] = scalar.range;
        let value = pair.flow;
        const token = scalar.srcToken;
        if (token?.type === "block-scalar") {
          const header = token.props[0];
          if (header?.type !== "block-scalar-header") throw new GlobalConfigWriteError("config");
          value += text.slice(header.offset + header.source.length, end - token.source.length);
        }
        edits.push({ start, end, value });
      }
      if (additions.length) edits.push(insertPairs(text, node, additions));
    }
  }
  const yaml = edits.sort((a, b) => b.start - a.start || b.end - a.end)
    .reduce((content, edit) => content.slice(0, edit.start) + edit.value + content.slice(edit.end), text);
  if (!isDeepStrictEqual(Bun.YAML.parse(yaml), { ...local, coin_shop: next })) throw new GlobalConfigWriteError("config");
  return yaml;
}

class MountConflict extends Error {}

export function panelWebLogin(root: URL, milkyWebhookPath?: string) {
  return async (request: Request, stillAuthorized: () => boolean): Promise<Response> => {
    if (request.method === "GET") {
      try { return Response.json(snapshot(await readLotusGlobalConfig(root))); }
      catch { return new Response(null, { status: 500 }); }
    }
    if (request.method !== "PUT") return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } });
    let patch: Partial<WebLoginSettings>;
    let revision: string;
    try {
      const body = await readPanelJson(request, 8192);
      if (!record(body) || Object.keys(body).length !== 2 || typeof body.revision !== "string" ||
          !/^[a-f0-9]{64}$/u.test(body.revision)) throw new Error();
      revision = body.revision;
      patch = patchSettings(body.patch);
    } catch {
      return new Response(null, { status: 400 });
    }
    try {
      const updated = await updateLotusGlobalConfig(root, {
        canWrite: stillAuthorized,
        canCommit: stillAuthorized,
        signal: request.signal,
        prepare(text, local, effective) {
          const previous = snapshot(effective);
          if (previous.revision !== revision) throw new GlobalConfigWriteError("conflict");
          const changed = Object.fromEntries(Object.entries(patch)
            .filter(([key, value]) => previous.settings[key as keyof WebLoginSettings] !== value));
          if (!Object.keys(changed).length) return { value: previous };
          const source = effective.coin_shop ?? {};
          if (!record(source)) throw new GlobalConfigWriteError("config");
          const next = { ...source, ...changed };
          if (("path" in changed || "public_url" in changed) && miyousheWebSettings(next, milkyWebhookPath).mountConflict) {
            throw new MountConflict();
          }
          return { yaml: editLogin(text, local, source, changed), value: snapshot({ ...effective, coin_shop: next }) };
        },
      });
      return Response.json(updated);
    } catch (error) {
      if (error instanceof MountConflict) return new Response(null, { status: 422 });
      const reason = error instanceof GlobalConfigWriteError ? error.reason : undefined;
      return new Response(null, { status: reason === "conflict" ? 409 : reason === "permission" ? 401 : 500 });
    }
  };
}
