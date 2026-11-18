export const PluginCleanup = Symbol("PluginCleanup");

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

  reply(message, quote = false) {
    return this.e?.reply(message, quote) ?? false;
  }
}
