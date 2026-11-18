import { STATUS_CODES } from "node:http";
import { readWebhookJson } from "../http-json.ts";
import { authorized, publicPostPath } from "../server.ts";
import { HandlerScope } from "./handler.ts";

type LegacyHttpHandler = (request: { readonly body: unknown }, response: { sendStatus(status: number): void }) => unknown;

interface Route {
  readonly owner: HandlerScope;
  readonly handler: LegacyHttpHandler;
}

interface PendingRoutes {
  readonly routes: Map<string, Route>;
  accepting: boolean;
}

function reply(status: number, body: string | null = null): Response {
  return new Response(body, { status, headers: { "Cache-Control": "no-store" } });
}

export class LegacyHttpRoutes {
  readonly #pending = new Map<HandlerScope, PendingRoutes>();
  #routes = new Map<string, Route>();
  readonly #reserved = new Set<string>();

  readonly express = Object.freeze({
    post: (path: string, handler: LegacyHttpHandler): void => {
      const owner = HandlerScope.current();
      const pending = owner && this.#pending.get(owner);
      if (!owner || !pending?.accepting) throw new Error("Bot.express.post 须在旧插件初始化期间调用。");
      const key = typeof path === "string" ? publicPostPath(path) : undefined;
      if (!key || this.#reserved.has(key) || typeof handler !== "function") {
        throw new Error("Bot.express.post 需要可用的固定路径和处理函数。");
      }
      if (pending.routes.has(key)) throw new Error("Bot.express.post 重复注册路径。");
      pending.routes.set(key, { owner, handler });
    },
  });

  reserve(path: string): void {
    const key = publicPostPath(path);
    if (!key) throw new Error("原生 POST 路径无效。");
    this.#reserved.add(key);
  }

  open(scope: HandlerScope): void {
    if (!this.#pending.has(scope)) this.#pending.set(scope, { routes: new Map(), accepting: true });
  }

  seal(scope: HandlerScope): void {
    const pending = this.#pending.get(scope);
    if (pending) pending.accepting = false;
  }

  discard(scope: HandlerScope): void {
    this.#pending.delete(scope);
    if ([...this.#routes.values()].some(({ owner }) => owner === scope)) {
      this.#routes = new Map([...this.#routes].filter(([, route]) => route.owner !== scope));
    }
  }

  prepare(active: readonly HandlerScope[], replacing: ReadonlySet<HandlerScope>): { publish(): void } {
    const previous = this.#routes;
    const next = new Map([...previous].filter(([, route]) => !replacing.has(route.owner)));
    const staged = new Map(active.map((owner) => [owner, this.#pending.get(owner)]));
    for (const pending of staged.values()) {
      if (!pending) continue;
      for (const [path, route] of pending.routes) {
        if (next.has(path)) throw new Error("Bot.express.post 重复注册路径。");
        next.set(path, route);
      }
    }

    return {
      publish: () => {
        if (this.#routes !== previous) return;
        for (const [owner, pending] of staged) {
          if (this.#pending.get(owner) !== pending) return;
        }
        this.#routes = next;
        for (const owner of staged.keys()) this.#pending.delete(owner);
      },
    };
  }

  async handle(request: Request, auth: Headers, accepting: () => boolean = () => true): Promise<Response | undefined> {
    if (request.method !== "POST" || request.headers.has("Upgrade")) return;
    const path = publicPostPath(new URL(request.url).pathname);
    if (!path) return;
    const route = this.#routes.get(path);
    if (!route) return;
    if (!authorized(request, auth)) return reply(401);
    if (!accepting()) return reply(503);

    const json = await readWebhookJson(request);
    if (this.#routes.get(path) !== route || !accepting()) return reply(503);
    if ("status" in json) return reply(json.status);

    return route.owner.invoke(async () => {
      let response: Response | undefined;
      const sendStatus = (status: number) => {
        if (response) return;
        if (!Number.isInteger(status) || status < 200 || status > 599) throw new Error("响应状态无效。");
        const body = status === 204 || status === 205 || status === 304 ? null : STATUS_CODES[status] ?? String(status);
        response = reply(status, body);
      };
      try {
        await route.handler(Object.freeze({ body: json.body }), Object.freeze({ sendStatus }));
      } catch {
        // The client only needs the status. Plugin exceptions can contain request credentials.
      }
      return response ?? reply(500);
    });
  }
}
