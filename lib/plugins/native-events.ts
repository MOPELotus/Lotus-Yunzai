import type { BotEvent, MessageEvent } from "../messages.ts";
import type { PluginContexts } from "./contexts.ts";

export interface NativePluginEvent {
  readonly name: string;
  readonly event: string;
  readonly priority: number;
  readonly observe?: (event: BotEvent) => unknown;
  readonly continue?: (event: MessageEvent, contexts: PluginContexts) => boolean | Promise<boolean>;
  readonly rule?: {
    readonly pattern: RegExp;
    readonly permission?: string;
    run(event: MessageEvent, contexts: PluginContexts): unknown;
  };
}
