import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import {
  hostIngressKeys, hostIngressListKeys, hostIngressSettings, HostIngressSettingsError, saveHostIngressSettings,
  type HostIngressSettings,
} from "./master-config.ts";
import { readPanelJson } from "./panel.ts";
import { readRequestOtherPolicyFiles } from "./request-other-policies.ts";

const ingressFields = [
  { key: "whiteUser", label: $t("lib.panel-ingress-settings.text_8c4715253c"), type: "list", hint: $t("lib.panel-ingress-settings.text_e9d8fe87ae") },
  { key: "blackUser", label: $t("lib.panel-ingress-settings.text_6ae2ab05a0"), type: "list" },
  { key: "whiteGroup", label: $t("lib.panel-ingress-settings.text_f1578eca20"), type: "list", hint: $t("lib.panel-ingress-settings.text_2db4bda5f9") },
  { key: "blackGroup", label: $t("lib.panel-ingress-settings.text_cd309a726c"), type: "list" },
  { key: "disablePrivate", label: $t("lib.panel-ingress-settings.text_c5b0f52de1"), type: "boolean" },
  { key: "disableMsg", label: $t("lib.panel-ingress-settings.text_60288b7c3c"), type: "text", hint: $t("lib.panel-ingress-settings.text_32d04ce9b0") },
] as const;

const automationFields = [
  { key: "autoFriend", label: $t("lib.panel-ingress-settings.text_c99ae88b0e"), type: "boolean" },
  { key: "autoQuit", label: $t("lib.panel-ingress-settings.text_b98db3af7f"), type: "number", min: 0,
    hint: $t("lib.panel-ingress-settings.text_97f4be1e9e") },
] as const;

function fieldsFor(legacy: boolean, patterns: string[]) {
  const multilinePattern = patterns.some(pattern => /[\r\n]/u.test(pattern));
  const custom = { key: "disableAdopt", label: $t("lib.panel-ingress-settings.text_196aa4adca"),
    ...(multilinePattern ? { type: "json", hint: $t("lib.panel-ingress-settings.text_7f34c533e2") } :
      { type: "list", separator: "line", keepWhitespace: true,
        hint: $t("lib.panel-ingress-settings.text_9828694138") }),
  };
  return [...ingressFields, custom, ...automationFields, { key: "autoGroup", label: $t("lib.panel-ingress-settings.text_5339188b86"), type: "select",
    options: [...(legacy ? [] : [{ label: $t("lib.panel-ingress-settings.text_3fd47edce4"), value: "off" }]),
      { label: $t("lib.panel-ingress-settings.text_49e0c3bc75"), value: "owners" }, { label: $t("lib.panel-ingress-settings.text_f5aadbb0ad"), value: "all" }] }];
}

function record(input: unknown): Record<string, unknown> | undefined {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) return input as Record<string, unknown>;
}

function validIds(value: unknown): value is string[] {
  return Array.isArray(value) && new Set(value).size === value.length &&
    value.every(id => typeof id === "string" && /^[1-9]\d{0,15}$/u.test(id) && Number.isSafeInteger(Number(id)));
}

function validValues(value: unknown): value is HostIngressSettings {
  const input = record(value);
  return !!input && Object.keys(input).length === hostIngressKeys.length &&
    hostIngressKeys.every(key => Object.hasOwn(input, key)) &&
    hostIngressListKeys.every(key => validIds(input[key])) &&
    typeof input.disablePrivate === "boolean" && typeof input.disableMsg === "string" && !input.disableMsg.includes("\0") &&
    Array.isArray(input.disableAdopt) && input.disableAdopt.every(rule => typeof rule === "string" && rule.length > 0) &&
    typeof input.autoFriend === "boolean" && (input.autoGroup === "all" || input.autoGroup === "owners" || input.autoGroup === "off") &&
    typeof input.autoQuit === "number" && Number.isSafeInteger(input.autoQuit) && input.autoQuit >= 0;
}

export function panelIngressSettings(root: URL, onSaved?: () => Promise<unknown>) {
  return async (request: Request, stillAuthorized: () => boolean): Promise<Response> => {
    if (request.method !== "GET" && request.method !== "PUT") {
      return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } });
    }
    const active = () => !request.signal.aborted && stillAuthorized();
    if (!active()) return new Response(null, { status: 401 });
    if (request.method === "GET") {
      try {
        const files = await readRequestOtherPolicyFiles(root);
        const values = hostIngressSettings(files);
        return active() ? Response.json({ fields: fieldsFor(files[0] === undefined && files[1] !== undefined, values.disableAdopt), values })
          : new Response(null, { status: 401 });
      } catch {
        return new Response(null, { status: 500 });
      }
    }

    let input: Record<string, unknown> | undefined;
    try { input = record(await readPanelJson(request, 262_144)); }
    catch { return new Response(null, { status: 400 }); }
    if (!input || Object.keys(input).length !== 2 || !validValues(input.previous) || !validValues(input.values)) {
      return new Response(null, { status: 400 });
    }
    try {
      const { values, legacy } = await saveHostIngressSettings(root, input.previous, input.values, active);
      const fields = fieldsFor(legacy, values.disableAdopt);
      try { await onSaved?.(); }
      catch {
        return Response.json({ fields, values, warning: $t("lib.panel-ingress-settings.text_f0a01838d1") });
      }
      return Response.json({ fields, values });
    } catch (error) {
      if (!active()) return new Response(null, { status: 401 });
      if (error instanceof HostIngressSettingsError) {
        return Response.json({ message: error.message }, { status: error.code === "conflict" ? 409 : 400 });
      }
      return new Response(null, { status: 409 });
    }
  };
}
