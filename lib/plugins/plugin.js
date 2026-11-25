import { createTranslator } from "../../packages/i18n/index.ts";
import catalog from "../../i18n/legacy-plugin/zh-CN.json";
const $t = createTranslator("legacy-plugin", catalog.messages);

export const PluginCleanup = Symbol("PluginCleanup");
export const PluginContext = Symbol("PluginContext");

export default class Plugin {
  /** @type {Array<() => void | Promise<void>>} */
  [PluginCleanup] = [];

  constructor({
    name = $t("plugin.unnamed"),
    event = "message",
    priority = 5000,
    rule = [],
    ...options
  } = {}) {
    Object.assign(this, options, { name, event, priority, rule });
  }

  addCleanup(dispose, restore) {
    if (typeof dispose !== "function" || (restore !== undefined && typeof restore !== "function")) {
      throw new TypeError($t("plugin.invalidCleanup"));
    }
    this[PluginCleanup].push(dispose);
  }

  setContext(method, isGroup = false, seconds = 120, timeout = $t("plugin.contextTimeout")) {
    if (this.e?.post_type !== "message" || this.e.isDelegated || typeof method !== "string" || typeof this[method] !== "function") return undefined;
    return this[PluginContext]?.set(this.e, method, isGroup, seconds, timeout);
  }

  getContext(method, isGroup = false) {
    if (this.e?.post_type !== "message" || this.e.isDelegated) return undefined;
    const entries = this[PluginContext]?.get(this.e, isGroup);
    return method ? entries && Object.hasOwn(entries, method) ? entries[method] : undefined : entries;
  }

  awaitContext(isGroup = false, seconds = 120) {
    if (this.e?.post_type !== "message" || this.e.isDelegated) return Promise.resolve(false);
    return this[PluginContext]?.wait(this.e, isGroup, seconds) ?? Promise.resolve(false);
  }

  finish(method, isGroup = false) {
    if (this.e?.post_type === "message" && !this.e.isDelegated) this[PluginContext]?.finish(this.e, method, isGroup);
  }

  reply(message, quote = false, options) {
    return this.e?.reply(message, quote, options) ?? false;
  }
}
