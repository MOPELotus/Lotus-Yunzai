export type CommandHandler = (argument: string) => string | Promise<string>;

export interface CommandModule {
  readonly name: string;
  readonly commands: Readonly<Record<string, CommandHandler>>;
}

export class CommandRegistry {
  readonly #handlers = new Map<string, CommandHandler>();
  readonly #modules = new Set<string>();

  register(name: string, handler: CommandHandler): void {
    this.#checkCommand(name);
    this.#handlers.set(name, handler);
  }

  hasModule(name: string): boolean {
    return this.#modules.has(name);
  }

  registerModule(module: CommandModule): () => void {
    const { name } = module;
    if (this.hasModule(name)) {
      throw new Error(`模块已注册：${name}`);
    }

    const commands = Object.entries(module.commands);
    for (const [command, handler] of commands) {
      this.#checkCommand(command);
      if (typeof handler !== "function") {
        throw new Error(`模块 ${name} 的指令 ${command} 缺少处理函数。`);
      }
    }

    for (const [command, handler] of commands) {
      this.#handlers.set(command, handler);
    }
    this.#modules.add(name);

    let active = true;
    return () => {
      if (!active) {
        return;
      }
      active = false;
      this.#modules.delete(name);
      for (const [command] of commands) {
        this.#handlers.delete(command);
      }
    };
  }

  #checkCommand(name: string): void {
    if (!/^#[^\s#]+$/u.test(name)) {
      throw new Error(`无效的指令名：${name}`);
    }

    if (this.#handlers.has(name)) {
      throw new Error(`指令已注册：${name}`);
    }
  }

  async dispatch(message: string): Promise<string | undefined> {
    const input = message.trim();
    const separator = input.search(/\s/u);
    const name = separator === -1 ? input : input.slice(0, separator);
    const argument = separator === -1 ? "" : input.slice(separator).trimStart();

    return this.#handlers.get(name)?.(argument);
  }
}
