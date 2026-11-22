import type { ProtocolGateway, ProtocolIncomingMessage, ProtocolPeer, ProtocolReceipt, ProtocolReplyPart, ProtocolScope,
  ReverseProtocolGateway } from "./optional-protocol.ts";
import { protocolConversationKey } from "./optional-protocol.ts";

export interface OptionalProtocolRegistration {
  readonly adapter: string;
  readonly instance: string;
  readonly gateway: ProtocolGateway;
}

interface ProtocolRuntimeOptions {
  readonly signal: AbortSignal;
  readonly dispatch: (message: ProtocolIncomingMessage, signal: AbortSignal) => Promise<readonly ProtocolReplyPart[] | undefined>;
  readonly onReceipt?: (scope: ProtocolScope, receipt: ProtocolReceipt) => void;
  readonly onStopped?: (registration: Pick<OptionalProtocolRegistration, "adapter" | "instance">, reason: "ended" | "failed") => void;
}

const identifier = /^[a-z][a-z0-9-]{0,47}$/u;
const conversationKinds = new Set(["private", "group", "channel", "temporary"]);
const mediaKinds = new Set(["image", "audio", "video", "file"]);
const rememberLimit = 2_048;

function providerId(value: unknown) {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    value.trim() === value && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function optionalProviderId(value: string | undefined) {
  return value === undefined || providerId(value);
}

function validMessage(message: ProtocolIncomingMessage, registration: OptionalProtocolRegistration) {
  if (!message || !message.scope || !message.conversation) return false;
  const { scope, conversation, parts, actor, messageId, replyTo } = message;
  return scope.adapter === registration.adapter && scope.instance === registration.instance && providerId(scope.account) &&
    optionalProviderId(scope.platform) && providerId(conversation.id) && conversationKinds.has(conversation.kind) &&
    optionalProviderId(conversation.parentId) && optionalProviderId(conversation.transportKind) &&
    providerId(actor) && providerId(messageId) && optionalProviderId(replyTo) &&
    Array.isArray(parts) && parts.length <= 128 && parts.every(part => {
      if (!part || typeof part !== "object") return false;
      if (part.type === "text") return typeof part.text === "string" && part.text.length <= 65_536;
      return providerId(part.id) && (part.type === "mention" || mediaKinds.has(part.type) && optionalProviderId(part.name));
    });
}

function reverseGateway(gateway: ProtocolGateway): gateway is ReverseProtocolGateway {
  return "accept" in gateway && typeof gateway.accept === "function";
}

/** Bind explicitly selected optional gateways without mapping their identities into the QQ runtime. */
export function startOptionalProtocols(registrations: readonly OptionalProtocolRegistration[], options: ProtocolRuntimeOptions) {
  const { signal, dispatch, onReceipt, onStopped } = options;
  const lookup = new Map<string, OptionalProtocolRegistration>();
  const live = new Set<OptionalProtocolRegistration>();
  const uniqueKey = (adapter: string, instance: string) => `${adapter}/${instance}`;
  for (const registration of registrations) {
    const { adapter, instance } = registration;
    const key = uniqueKey(adapter, instance);
    if (!identifier.test(adapter) || !identifier.test(instance) || lookup.has(key)) {
      throw new Error("附加协议的适配器和实例名须有效且组合唯一。");
    }
    lookup.set(key, registration);
  }

  function run(registration: OptionalProtocolRegistration) {
    const { adapter, instance, gateway } = registration;
    const recent = new Set<string>();
    const session = new AbortController();
    const active = AbortSignal.any([signal, session.signal]);
    const report = (reason: "ended" | "failed") => {
      if (!signal.aborted) onStopped?.({ adapter, instance }, reason);
    };
    live.add(registration);
    return (async () => {
      try {
        if (active.aborted) return;
        await gateway.start(async (message) => {
          if (active.aborted || !validMessage(message, registration)) return;
          const { scope, conversation, messageId } = message;
          const key = JSON.stringify([protocolConversationKey(message), messageId]);
          if (recent.has(key)) return;
          recent.add(key);
          if (recent.size > rememberLimit) recent.delete(recent.values().next().value!);
          const parts = await dispatch(message, active).catch(() => undefined);
          if (!parts?.length || active.aborted) return;
          const outcome = await gateway.send({ scope, conversation, replyTo: messageId }, parts, active)
            .catch(() => ({ status: "unknown" } as const));
          if (!active.aborted) onReceipt?.(scope, outcome);
        }, active);
        report("ended");
      } catch {
        report("failed");
      } finally {
        live.delete(registration);
        session.abort();
      }
    })();
  }

  const done = Promise.all([...lookup.values()].map(run));
  return {
    done,
    /** The caller must authenticate this route before supplying the WebSocket peer. */
    accept(adapter: string, instance: string, peer: ProtocolPeer) {
      const registration = lookup.get(uniqueKey(adapter, instance));
      if (!signal.aborted && registration && live.has(registration) && reverseGateway(registration.gateway)) {
        return registration.gateway.accept(peer);
      }
    },
  };
}
