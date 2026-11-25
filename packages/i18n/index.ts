/** Shared by the host, plugins, renderers and management page. No I/O or platform globals. */
export const defaultLanguage = "zh-CN";

export type Messages = Readonly<Record<string, string>>;
export type LanguageCatalog = Readonly<Record<string, Messages>>;
export type MessageParameters = Readonly<Record<string, unknown>>;
export type Translator = (key: string, parameters?: MessageParameters) => string;

function languageTag(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 80) throw new TypeError("Invalid language tag");
  try { return new Intl.Locale(value.trim().replaceAll("_", "-")).toString(); }
  catch { throw new TypeError("Invalid language tag"); }
}

function checkedMessages(value: Messages): Map<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid message catalog");
  const result = new Map<string, string>();
  for (const [key, message] of Object.entries(value)) {
    if (!key || typeof message !== "string") throw new TypeError("Invalid message entry");
    result.set(key, message);
  }
  return result;
}

/** A replacement is inserted once; placeholder-looking content in a value is never interpreted again. */
export function formatMessage(message: string, parameters?: MessageParameters): string {
  if (!parameters) return message;
  return message.replace(/\{([A-Za-z_][A-Za-z0-9_.-]*)\}/gu, (placeholder, key: string) =>
    Object.hasOwn(parameters, key) ? String(parameters[key]) : placeholder);
}

export function createI18n() {
  const languages = new Map<string, Map<string, Map<string, string>>>([[defaultLanguage, new Map()]]);
  const defaults = new Map<string, Map<string, string>>();
  const listeners = new Set<(language: string) => void>();
  let selected = defaultLanguage;
  let resolveLanguage: (() => string | undefined) | undefined;

  function getLanguage(): string {
    const requested = resolveLanguage?.();
    if (requested) {
      try {
        const locale = languageTag(requested);
        if (languages.has(locale)) return locale;
      } catch { /* A bad per-request preference must not interrupt message delivery. */ }
    }
    return selected;
  }

  function registerCatalog(locale: string, namespace: string, messages: Messages): void {
    if (typeof namespace !== "string" || !namespace) throw new TypeError("Invalid message namespace");
    const tag = languageTag(locale);
    // Validate the entire supplied catalog before publishing any entry.
    const checked = checkedMessages(messages);
    let namespaces = languages.get(tag);
    if (!namespaces) { namespaces = new Map(); languages.set(tag, namespaces); }
    let catalog = namespaces.get(namespace);
    if (!catalog) { catalog = new Map(); namespaces.set(namespace, catalog); }
    for (const [key, value] of checked) catalog.set(key, value);
  }

  function registerLanguage(locale: string, messages: LanguageCatalog): void {
    const tag = languageTag(locale);
    if (!messages || typeof messages !== "object" || Array.isArray(messages)) throw new TypeError("Invalid language catalog");
    const checked = Object.entries(messages).map(([namespace, catalog]) => {
      if (!namespace) throw new TypeError("Invalid message namespace");
      return [namespace, checkedMessages(catalog)] as const;
    });
    if (!languages.has(tag)) languages.set(tag, new Map());
    const namespaces = languages.get(tag)!;
    for (const [namespace, values] of checked) {
      let catalog = namespaces.get(namespace);
      if (!catalog) { catalog = new Map(); namespaces.set(namespace, catalog); }
      for (const [key, value] of values) catalog.set(key, value);
    }
  }

  function setLanguage(locale: string): string {
    const tag = languageTag(locale);
    if (!languages.has(tag)) throw new RangeError(`Language is not registered: ${tag}`);
    if (selected !== tag) {
      selected = tag;
      for (const listener of listeners) listener(tag);
    }
    return selected;
  }

  function listLanguages(): readonly string[] { return [...languages.keys()]; }

  function getCatalog(locale = getLanguage(), namespace?: string): LanguageCatalog {
    const tag = languageTag(locale);
    const fallback = defaults;
    const chineseEdits = languages.get(defaultLanguage)!;
    const requested = languages.get(tag);
    const result: Record<string, Record<string, string>> = Object.create(null);
    const names = namespace === undefined ? new Set([...fallback.keys(), ...chineseEdits.keys(), ...(requested?.keys() ?? [])]) : [namespace];
    for (const name of names) {
      const catalog: Record<string, string> = Object.create(null);
      for (const [key, value] of fallback.get(name) ?? []) catalog[key] = value;
      for (const [key, value] of chineseEdits.get(name) ?? []) catalog[key] = value;
      for (const [key, value] of requested?.get(name) ?? []) catalog[key] = value;
      result[name] = catalog;
    }
    return result;
  }

  function createTranslator(namespace: string, messages: Messages): Translator {
    if (typeof namespace !== "string" || !namespace) throw new TypeError("Invalid message namespace");
    const checked = checkedMessages(messages);
    let catalog = defaults.get(namespace);
    if (!catalog) { catalog = new Map(); defaults.set(namespace, catalog); }
    for (const [key, value] of checked) catalog.set(key, value);
    return (key, parameters) => {
      const translated = languages.get(getLanguage())?.get(namespace)?.get(key);
      const fallback = languages.get(defaultLanguage)?.get(namespace)?.get(key) ?? defaults.get(namespace)?.get(key);
      return formatMessage(translated ?? fallback ?? `${namespace}.${key}`, parameters);
    };
  }

  return {
    createTranslator, registerLanguage, registerCatalog, getLanguage, setLanguage, listLanguages, getCatalog,
    /** The server may provide an AsyncLocalStorage getter; browser users need no Node polyfill. */
    setLanguageResolver(resolver?: () => string | undefined) { resolveLanguage = resolver; },
    subscribeLanguageChange(listener: (language: string) => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

const shared = createI18n();
export const {
  createTranslator, registerLanguage, registerCatalog, getLanguage, setLanguage, listLanguages, getCatalog,
  setLanguageResolver, subscribeLanguageChange,
} = shared;
