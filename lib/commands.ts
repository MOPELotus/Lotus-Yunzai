import type { MessageEvent, MessageReply } from "./messages.ts";

export type CommandContext = Readonly<Pick<
  MessageEvent, "message_type" | "self_id" | "user_id" | "group_id" | "isMaster" | "member" | "likeSelf" | "isFriend" |
    "reviewGroupRequest" | "groupRequestScope" | "canReviewGroupRequests"
> & Partial<Pick<MessageEvent, "message" | "raw_message">> & { runtimeDiagnosticsScope?: "milky" }>;

export type MessageFallbackContext = CommandContext & Readonly<Pick<MessageEvent, "reply_id" | "sender" | "lookupReply">> & {
  readonly isBotMaster: (userId: number) => boolean;
};

export interface CommandForward {
  readonly type: "forward";
  readonly nodes: readonly MessageReply[];
}

export interface QuotedCommandReply {
  readonly type: "quoted";
  readonly message: MessageReply;
}

export type CommandReply = MessageReply | CommandForward | QuotedCommandReply;
export type CommandHandler = (argument: string, context: CommandContext) => CommandReply | Promise<CommandReply>;
export type MessageFallback = (
  message: string,
  context: MessageFallbackContext,
) => CommandReply | undefined | Promise<CommandReply | undefined>;

export async function sendCommandReply(event: Pick<MessageEvent, "reply" | "forward">, reply: CommandReply): Promise<void> {
  if (typeof reply !== "object" || reply === null || !("type" in reply)) {
    await event.reply(reply);
    return;
  }
  if (reply.type === "quoted") {
    await event.reply(reply.message, true);
    return;
  }
  if (reply.type !== "forward") {
    await event.reply(reply);
    return;
  }
  if (!Array.isArray(reply.nodes) || !reply.nodes.length) return;
  if (event.forward) {
    try {
      if (await event.forward(reply.nodes)) return;
    } catch {
      await event.reply("合并转发结果未确认，请在聊天中核对。");
      return;
    }
  }
  for (const node of reply.nodes) await event.reply(node);
}

export interface CommandModule {
  readonly name: string;
  readonly commands: Readonly<Record<string, CommandHandler>>;
  readonly aliases?: Readonly<Record<string, string>>;
  readonly fallback?: MessageFallback;
}

interface RegisteredCommand {
  readonly handler: CommandHandler;
  readonly names: readonly string[];
}

function commandContext(context: CommandContext): CommandContext {
  const { message_type, self_id, user_id, group_id, isMaster, member, likeSelf, isFriend, reviewGroupRequest,
    groupRequestScope, canReviewGroupRequests, runtimeDiagnosticsScope, message, raw_message } = context;
  return {
    message_type, self_id, user_id, group_id, isMaster, likeSelf, isFriend, message, raw_message,
    reviewGroupRequest, groupRequestScope, canReviewGroupRequests,
    ...(runtimeDiagnosticsScope ? { runtimeDiagnosticsScope } : {}),
    member: member && { is_admin: member.is_admin, is_owner: member.is_owner },
  };
}

function legacyFeatureNames(module: string, command: string): readonly string[] {
  if (module === "@lotus-yunzai/system" && command === "#状态") return ["状态统计", "椰奶状态"];
  if (module === "@lotus-yunzai/system" && command === "#统计") return ["状态统计"];
  if (module === "@lotus-yunzai/system" && command === "#版本") return ["版本"];
  return [];
}

export class CommandRegistry {
  readonly #handlers = new Map<string, RegisteredCommand>();
  readonly #fallbacks = new Map<string, { readonly handler: MessageFallback; readonly names: readonly string[] }>();
  readonly #modules = new Set<string>();

  register(name: string, handler: CommandHandler): void {
    this.#checkCommand(name);
    this.#handlers.set(name, { handler, names: [name] });
  }

  hasModule(name: string): boolean {
    return this.#modules.has(name);
  }

  registerModule(module: CommandModule, label = module.name): () => void {
    const { name, fallback } = module;
    if (this.hasModule(name)) {
      throw new Error(`模块已注册：${name}`);
    }
    if (fallback !== undefined && typeof fallback !== "function") {
      throw new Error(`模块 ${name} 的 fallback 须为消息处理函数。`);
    }

    const commands = Object.entries(module.commands);
    const local = new Map<string, RegisteredCommand>();
    for (const [command, handler] of commands) {
      this.#checkCommand(command);
      if (typeof handler !== "function") {
        throw new Error(`模块 ${name} 的指令 ${command} 缺少处理函数。`);
      }
      local.set(command, { handler, names: [name, label, ...legacyFeatureNames(name, command)] });
    }

    for (const [alias, target] of Object.entries(module.aliases ?? {})) {
      if (!/^#?[^\s#]+$/u.test(alias) || this.#handlers.has(alias) || local.has(alias)) {
        throw new Error(`无效或重复的指令别名：${alias}`);
      }
      const command = local.get(target);
      if (!command || !Object.hasOwn(module.commands, target)) {
        throw new Error(`指令别名 ${alias} 的目标不在当前模块中。`);
      }
      local.set(alias, command);
    }

    for (const [name, command] of local) {
      this.#handlers.set(name, command);
    }
    if (fallback) {
      const names = name === "@lotus-yunzai/meme"
        ? [name, label, "meme-plugin", "清语表情", "清语表情:表情包生成"] : [name, label];
      this.#fallbacks.set(name, { handler: fallback, names });
    }
    this.#modules.add(name);

    let active = true;
    return () => {
      if (!active) {
        return;
      }
      active = false;
      this.#modules.delete(name);
      this.#fallbacks.delete(name);
      for (const command of local.keys()) {
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

  async dispatch(
    message: string,
    context: CommandContext = { message_type: "terminal", isMaster: false },
    allowed?: (names: readonly string[]) => boolean,
  ): Promise<CommandReply | undefined> {
    const input = message.trim();
    const separator = input.search(/\s/u);
    const name = separator === -1 ? input : input.slice(0, separator);
    const argument = separator === -1 ? "" : input.slice(separator).trimStart();
    const command = this.#handlers.get(name);
    if (!command || (allowed && !allowed(command.names))) return;

    return command.handler(argument, commandContext(context));
  }

  async dispatchFallback(
    event: MessageEvent,
    allowed: (names: readonly string[]) => boolean,
    isBotMaster: MessageFallbackContext["isBotMaster"],
  ): Promise<CommandReply | undefined> {
    for (const { handler, names } of this.#fallbacks.values()) {
      if (!allowed(names)) continue;
      const reply = await handler(event.msg, {
        ...commandContext(event), sender: event.sender, reply_id: event.reply_id, lookupReply: event.lookupReply, isBotMaster,
      });
      if (reply !== undefined) return reply;
    }
  }
}
