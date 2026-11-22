import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parseDocument } from "yaml";
import { GlobalConfigWriteError, updateLocalConfiguration } from "./lotus-global-config-write.ts";
import { readMigrationSourceFile } from "./migration-files.ts";
import { readPanelJson } from "./panel.ts";

const installation = new URL("../", import.meta.url);
const games = ["gs", "sr"] as const;
type Game = (typeof games)[number];
type GroupLists = Readonly<Record<Game, readonly string[]>>;

const fields = [
  { key: "gs", label: "原神群榜启用群", type: "list" },
  { key: "sr", label: "星铁群榜启用群", type: "list" },
] as const;

function list(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > 512 || !value.every(id => typeof id === "string" &&
      /^[1-9]\d{0,15}$/u.test(id) && Number.isSafeInteger(Number(id)))) return;
  return [...new Set(value)];
}

function configured(value: unknown): Partial<GroupLists> {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new GlobalConfigWriteError("config");
  const record = value as Record<string, unknown>;
  const result: Partial<Record<Game, string[]>> = {};
  for (const game of games) {
    if (!Object.hasOwn(record, game)) continue;
    const groups = list(record[game]);
    if (!groups) throw new GlobalConfigWriteError("config");
    result[game] = groups;
  }
  return result;
}

function groupsFromEnv(value: string | undefined) {
  return [...new Set((value ?? "").split(/[\s,]+/u).filter(id =>
    /^[1-9]\d{0,15}$/u.test(id) && Number.isSafeInteger(Number(id))))].slice(0, 512);
}

function effective(config: Partial<GroupLists>): GroupLists {
  return {
    gs: config.gs ?? groupsFromEnv(Bun.env.LOTUS_GENSHIN_PANEL_RANK_GROUPS),
    sr: config.sr ?? groupsFromEnv(Bun.env.LOTUS_STAR_RAIL_PANEL_RANK_GROUPS),
  };
}

async function readConfiguration(root: URL) {
  const file = await readMigrationSourceFile(fileURLToPath(root), fileURLToPath(new URL("config/panel-rank.yaml", root)), 65_536);
  return configured(file && Bun.YAML.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)));
}

export async function readGroupPanelRankEnabled(game: Game, groupId: number, defaultEnabled: boolean, root = installation) {
  try {
    const groups = (await readConfiguration(root))[game];
    return groups?.includes(String(groupId)) ?? defaultEnabled;
  } catch {
    return false;
  }
}

function input(value: unknown): GroupLists | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2 ||
      !("gs" in value) || !("sr" in value)) return;
  const gs = list(value.gs), sr = list(value.sr);
  if (gs && sr) return { gs, sr };
}

export function panelGroupRankSettings(root: URL) {
  return async (request: Request, stillAuthorized: () => boolean): Promise<Response> => {
    const active = () => !request.signal.aborted && stillAuthorized();
    if (!active()) return new Response(null, { status: 401 });
    if (request.method !== "GET" && request.method !== "PUT") {
      return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } });
    }
    try {
      if (request.method === "GET") {
        const values = effective(await readConfiguration(root));
        return active() ? Response.json({ fields, values }) : new Response(null, { status: 401 });
      }
      const body = await readPanelJson(request).catch(() => undefined);
      if (!body || typeof body !== "object" || !("previous" in body) || !("values" in body)) {
        return new Response(null, { status: 400 });
      }
      const previous = input(body.previous), values = input(body.values);
      if (!previous || !values) return new Response(null, { status: 400 });
      const saved = await updateLocalConfiguration(root, "panel-rank", {
        signal: request.signal, canWrite: active, canCommit: active,
        prepare(text, local) {
          const current = effective(configured(local));
          if (!isDeepStrictEqual(current, previous)) throw new GlobalConfigWriteError("conflict");
          const changed = games.filter(game => !isDeepStrictEqual(current[game], values[game]));
          if (!changed.length) return { value: current };
          const document = parseDocument(text, { strict: true, uniqueKeys: true });
          if (document.errors.length) throw new GlobalConfigWriteError("config");
          for (const game of changed) document.set(game, [...values[game]]);
          const yaml = document.toString({ lineWidth: 0 });
          if (!isDeepStrictEqual(Bun.YAML.parse(yaml), { ...local, ...Object.fromEntries(changed.map(game => [game, values[game]])) })) {
            throw new GlobalConfigWriteError("config");
          }
          return { yaml, value: values };
        },
      });
      return Response.json({ fields, values: saved });
    } catch (error) {
      if (!active() || error instanceof GlobalConfigWriteError && error.reason === "permission") return new Response(null, { status: 401 });
      return new Response(null, { status: error instanceof GlobalConfigWriteError && error.reason === "conflict" ? 409 : 500 });
    }
  };
}
