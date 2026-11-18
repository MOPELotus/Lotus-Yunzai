export type CommandHandler = (argument: string) => string | Promise<string>;

export class CommandRegistry {
  readonly #handlers = new Map<string, CommandHandler>();

  register(name: string, handler: CommandHandler): void {
    if (!/^#[^\s#]+$/u.test(name)) {
      throw new Error(`无效的指令名：${name}`);
    }

    if (this.#handlers.has(name)) {
      throw new Error(`指令已注册：${name}`);
    }

    this.#handlers.set(name, handler);
  }

  async dispatch(message: string): Promise<string | undefined> {
    const input = message.trim();
    const separator = input.search(/\s/u);
    const name = separator === -1 ? input : input.slice(0, separator);
    const argument = separator === -1 ? "" : input.slice(separator).trimStart();

    return this.#handlers.get(name)?.(argument);
  }
}
