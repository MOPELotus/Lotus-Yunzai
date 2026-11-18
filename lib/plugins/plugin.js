export const PluginCleanup = Symbol("PluginCleanup");
export const PluginContext = Symbol("PluginContext");

export default class Plugin {
  /** @type {Array<() => void | Promise<void>>} */
  [PluginCleanup] = [];

  constructor({
    name = "未命名插件",
    event = "message",
    priority = 5000,
    rule = [],
    ...options
  } = {}) {
    Object.assign(this, options, { name, event, priority, rule });
  }

  addCleanup(dispose, restore) {
    if (typeof dispose !== "function" || (restore !== undefined && typeof restore !== "function")) {
      throw new TypeError("插件清理与恢复回调必须是函数。");
    }
    this[PluginCleanup].push(dispose);
  }

  setContext(method, isGroup = false, seconds = 120, timeout = "操作超时已取消") {
    if (!this.e || typeof method !== "string" || typeof this[method] !== "function") return undefined;
    return this[PluginContext]?.set(this.e, method, isGroup, seconds, timeout);
  }

  getContext(method, isGroup = false) {
    if (!this.e) return undefined;
    const entries = this[PluginContext]?.get(this.e, isGroup);
    return method ? entries && Object.hasOwn(entries, method) ? entries[method] : undefined : entries;
  }

  awaitContext(isGroup = false, seconds = 120) {
    if (!this.e) return Promise.resolve(false);
    return this[PluginContext]?.wait(this.e, isGroup, seconds) ?? Promise.resolve(false);
  }

  finish(method, isGroup = false) {
    if (this.e) this[PluginContext]?.finish(this.e, method, isGroup);
  }

  reply(message, quote = false, options) {
    return this.e?.reply(message, quote, options) ?? false;
  }
}
