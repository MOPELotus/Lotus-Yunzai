import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { isMap, parseDocument } from "yaml";
import { GlobalConfigWriteError, updateLocalConfiguration } from "./lotus-global-config-write.ts";
import { readPanelJson } from "./panel.ts";
import { readRemoteSettings } from "./remote-control.ts";
import { remoteOtpPaired } from "./remote-otp.ts";
import { isRemoteAdministrator, isRemotePlatformSupported, remoteShells } from "./remote-shell.ts";

const configKeys = {
  enabled: "enable", timeout: "timeout_ms", shells: "shells",
  allowAdmin: "allow_admin", overwrite: "allow_overwrite_upload",
} as const;

type Settings = ReturnType<typeof readRemoteSettings>;
const keys = Object.keys(configKeys) as (keyof Settings)[];

function parseUpdate(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const fields = value as Partial<Settings>;
  if (keys.some(key => !Object.hasOwn(fields, key)) ||
      typeof fields.timeout !== "number" || !Number.isInteger(fields.timeout) ||
      fields.timeout < 100 || fields.timeout > 120_000 ||
      !Array.isArray(fields.shells) || fields.shells.some(shell => !remoteShells.includes(shell)) ||
      new Set(fields.shells).size !== fields.shells.length ||
      typeof fields.enabled !== "boolean" || typeof fields.allowAdmin !== "boolean" || typeof fields.overwrite !== "boolean") return;
  return Object.fromEntries(keys.map(key => [key, fields[key]])) as Settings;
}

export function panelRemoteSettings(root: URL) {
  const directory = fileURLToPath(root);
  const supported = isRemotePlatformSupported();
  function paired() {
    try { return remoteOtpPaired(directory); }
    catch { return false; }
  }
  function snapshot() {
    const current = readRemoteSettings(directory);
    const ready = paired();
    const elevated = isRemoteAdministrator();
    return {
      fields: [
        { key: "paired", label: $t("lib.panel-remote-settings.text_3a4d722d83"), type: "boolean", readonly: true,
          hint: $t("lib.panel-remote-settings.text_0a1a264563") },
        { key: "enabled", label: $t("lib.panel-remote-settings.text_c18ff17e7e"), type: "boolean", readonly: !current.enabled && !(ready && supported),
          hint: $t("lib.panel-remote-settings.text_234c46b1a2") },
        { key: "timeout", label: $t("lib.panel-remote-settings.text_aa4c8bfaf2"), type: "number", min: 100, max: 120_000 },
        { key: "shells", label: $t("lib.panel-remote-settings.text_bfc205d564"), type: "list", hint: $t("lib.panel-remote-settings.text_999524176b") },
        { key: "allowAdmin", label: $t("lib.panel-remote-settings.text_f27f582a3c"), type: "boolean", readonly: !current.allowAdmin && !(supported && elevated),
          hint: $t("lib.panel-remote-settings.text_98523a008e") },
        { key: "overwrite", label: $t("lib.panel-remote-settings.text_2ba2976e85"), type: "boolean" },
      ],
      values: { ...current, paired: ready },
    };
  }

  return async (request: Request, stillAuthorized: () => boolean): Promise<Response> => {
    const active = () => !request.signal.aborted && stillAuthorized();
    if (!active()) return new Response(null, { status: 401 });
    if (request.method !== "GET" && request.method !== "PUT") {
      return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } });
    }
    try {
      if (request.method === "GET") return Response.json(snapshot());
      const body = await readPanelJson(request, 4_096).catch(() => undefined);
      if (!body || typeof body !== "object" || !("previous" in body) || !("values" in body)) {
        return new Response(null, { status: 400 });
      }
      const previous = parseUpdate(body.previous);
      const values = parseUpdate(body.values);
      if (!previous || !values) return new Response(null, { status: 400 });
      const mayEnable = () => (previous.enabled || !values.enabled || supported && paired()) &&
        (previous.allowAdmin || !values.allowAdmin || supported && isRemoteAdministrator());
      if (!mayEnable()) return Response.json({ message: $t("lib.panel-remote-settings.text_b84abd1ec9") }, { status: 403 });
      await updateLocalConfiguration(root, "remote", {
        signal: request.signal,
        canWrite: active,
        canCommit: () => active() && mayEnable(),
        resolveEffective: async () => readRemoteSettings(directory),
        prepare(content, local, current) {
          if (!isDeepStrictEqual(current, previous)) throw new GlobalConfigWriteError("conflict");
          const changed = keys.filter(key => !isDeepStrictEqual(current[key], values[key]));
          if (!changed.length) return { value: undefined };
          const yaml = parseDocument(content, { strict: true, merge: true, uniqueKeys: true });
          if (yaml.errors.length || (yaml.contents && !isMap(yaml.contents))) throw new GlobalConfigWriteError("config");
          const expected = { ...local };
          for (const key of changed) {
            expected[configKeys[key]] = values[key];
            yaml.set(configKeys[key], values[key]);
          }
          const output = yaml.toString({ lineWidth: 0 });
          if (!isDeepStrictEqual(Bun.YAML.parse(output), expected)) throw new GlobalConfigWriteError("config");
          return { yaml: output, value: undefined };
        },
      });
      return active() ? Response.json(snapshot()) : new Response(null, { status: 401 });
    } catch (error) {
      if (!active()) return new Response(null, { status: 401 });
      if (error instanceof GlobalConfigWriteError) {
        if (error.reason === "conflict") return new Response(null, { status: 409 });
        if (error.reason === "permission") return new Response(null, { status: 403 });
      }
      return new Response(null, { status: 500 });
    }
  };
}
