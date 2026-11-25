import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
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
  readonly #reservedMounts = new Set<string>();

  readonly express = Object.freeze({
    post: (path: string, handler: LegacyHttpHandler): void => {
      const owner = HandlerScope.current();
      const pending = owner && this.#pending.get(owner);
      if (!owner || !pending?.accepting) throw new Error($t("lib.plugins.legacy-http.text_a5fd2d8fd5"));
      const key = typeof path === "string" ? publicPostPath(path) : undefined;
      if (!key || this.#reserved.has(key) || [...this.#reservedMounts].some(mount => key === mount || key.startsWith(`${mount}/`)) ||
          typeof handler !== "function") {
        throw new Error($t("lib.plugins.legacy-http.text_5cb18e5d9d"));
      }
      if (pending.routes.has(key)) throw new Error($t("lib.plugins.legacy-http.text_ea2a08f592"));
      pending.routes.set(key, { owner, handler });
    },
  });

  reserve(path: string): void {
    const key = publicPostPath(path);
    if (!key) throw new Error($t("lib.plugins.legacy-http.text_6661f7d7ff"));
    this.#reserved.add(key);
  }

  reserveMount(path: string): void {
    const key = publicPostPath(path);
    if (!key) throw new Error($t("lib.plugins.legacy-http.text_b256c7bc28"));
    this.#reservedMounts.add(key);
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
        if (next.has(path)) throw new Error($t("lib.plugins.legacy-http.text_ea2a08f592"));
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
        if (!Number.isInteger(status) || status < 200 || status > 599) throw new Error($t("lib.plugins.legacy-http.text_6a274d4304"));
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
