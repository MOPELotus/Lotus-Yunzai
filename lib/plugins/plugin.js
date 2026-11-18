export default class Plugin {
  constructor({
    name = "未命名插件",
    event = "message",
    priority = 5000,
    rule = [],
    ...options
  } = {}) {
    Object.assign(this, options, { name, event, priority, rule });
  }

  reply(message, quote = false) {
    return this.e?.reply(message, quote) ?? false;
  }
}
