import { shallowRef } from "vue";
import {
  createTranslator, defaultLanguage, getLanguage, registerLanguage, setLanguage, subscribeLanguageChange,
  type LanguageCatalog, type MessageParameters,
} from "../../packages/i18n/index.ts";
import chinese from "../i18n/zh-CN.json";
import type { PanelAuth } from "./api.ts";

export interface CatalogSection { description: string; source?: string }
export interface CatalogDefault {
  description?: string;
  sections?: Record<string, CatalogSection>;
  parameters?: Record<string, Record<string, string>>;
  messages: Record<string, string>;
}
export interface PanelLanguageSnapshot {
  language: string;
  languages: { id: string; label: string }[];
  catalogs: Record<string, Record<string, string>>;
  defaults?: Record<string, CatalogDefault>;
  restartRequired?: boolean;
}

const translate = createTranslator("panel", chinese.messages);
export const panelLanguage = shallowRef(getLanguage());
export const panelLanguages = shallowRef<PanelLanguageSnapshot["languages"]>([{ id: defaultLanguage, label: chinese.name }]);
subscribeLanguageChange(language => { panelLanguage.value = language; });

export function panelText(key: string, parameters?: MessageParameters): string {
  void panelLanguage.value;
  return translate(key, parameters);
}

function snapshot(value: unknown): PanelLanguageSnapshot {
  if (!value || typeof value !== "object") throw new Error(panelText("i18n.invalid_response"));
  const data = value as PanelLanguageSnapshot;
  if (typeof data.language !== "string" || !Array.isArray(data.languages) ||
      !data.languages.every(item => item && typeof item.id === "string" && typeof item.label === "string") ||
      !data.catalogs || typeof data.catalogs !== "object" || Array.isArray(data.catalogs)) throw new Error(panelText("i18n.invalid_response"));
  return data;
}

export function applyPanelLanguage(data: PanelLanguageSnapshot) {
  registerLanguage(data.language, data.catalogs as LanguageCatalog);
  panelLanguages.value = data.languages;
  setLanguage(data.language);
  document.documentElement.lang = data.language;
  document.title = panelText("App.058cedd84e");
}

export async function requestPanelLanguage(auth: PanelAuth, options: {
  method?: "GET" | "PUT" | "PATCH"; body?: unknown; signal?: AbortSignal;
} = {}): Promise<PanelLanguageSnapshot> {
  const headers = new Headers();
  if (auth.kind === "bearer") headers.set("Authorization", `Bearer ${auth.token}`);
  else headers.set("X-Lotus-Panel-Session", "1");
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(`${import.meta.env.BASE_URL}api/i18n`, {
    method: options.method ?? "GET", headers, credentials: auth.kind === "session" ? "same-origin" : "omit",
    cache: "no-store", redirect: "error", signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  if (!response.ok) throw Object.assign(new Error(panelText(response.status === 401 || response.status === 403
    ? "i18n.unauthorized" : response.status === 409 ? "i18n.conflict" : "i18n.request_failed")), { status: response.status });
  const data = snapshot(await response.json());
  applyPanelLanguage(data);
  return data;
}

/** Existing authenticated sessions select the saved language before module labels are created. */
export async function bootstrapPanelLanguage() {
  try { await requestPanelLanguage({ kind: "session" }, { signal: AbortSignal.timeout(5000) }); }
  catch { document.title = panelText("App.058cedd84e"); }
}
