import type { CommandContext, CommandModule, CommandReply } from "./commands.ts";
import { segment } from "./messages.ts";

type PublicFetch = (url: URL, init: RequestInit) => Promise<Response>;

const catSources = [
  ["https://shibe.online/api/cats?count=10", "", ["cdn.shibe.online", "shibe.online"]],
  ["https://api.thecatapi.com/v1/images/search?limit=10", "url", ["cdn2.thecatapi.com"]],
] as const;
const maxImageBytes = 2 * 1024 * 1024;
const maxJsonBytes = 128 * 1024;
const imageBatchSize = 5;

function field(value: unknown, name: string): unknown {
  return value && typeof value === "object" && Object.hasOwn(value, name)
    ? (value as Record<string, unknown>)[name] : undefined;
}

function allowedUrl(input: unknown, hosts: readonly string[]): URL | undefined {
  if (typeof input !== "string" || input.length > 2048) return;
  try {
    const url = new URL(input);
    if (url.protocol === "https:" && !url.username && !url.password && !url.port && hosts.includes(url.hostname)) return url;
  } catch {
    return;
  }
}

async function boundedBody(response: Response, bytes: number, signal: AbortSignal, expectedType: RegExp) {
  if (!response.ok || response.redirected || !response.body || Number(response.headers.get("content-length")) > bytes ||
      !expectedType.test(response.headers.get("content-type") ?? "")) {
    void response.body?.cancel().catch(() => undefined);
    return;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) return;
      if (done) break;
      length += value.byteLength;
      if (length > bytes) return;
      chunks.push(value);
    }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function generalToolCommands(lifecycle: AbortSignal, transport: PublicFetch = fetch): CommandModule {
  const inFlight = new Map<string, Promise<CommandReply>>();
  const fetchBody = async (url: URL, signal: AbortSignal, limit: number, expected: RegExp, accept: string) => {
    try {
      const response = await transport(url, { credentials: "omit", redirect: "error", signal, headers: { Accept: accept } });
      return await boundedBody(response, limit, signal, expected);
    } catch {
      return undefined;
    }
  };
  const json = async (endpoint: string, signal: AbortSignal, timeout = 4_000) => {
    const request = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
    const bytes = await fetchBody(new URL(endpoint), request, maxJsonBytes, /^(?:application|text)\/json\b/iu, "application/json");
    if (!bytes) return;
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch {
      return undefined;
    }
  };
  const image = async (url: URL, signal: AbortSignal, limit: number) => {
    return fetchBody(url, signal, limit, /^image\/(?:jpeg|png|gif|webp)\b/iu, "image/jpeg,image/png,image/gif,image/webp");
  };
  const urls = (items: unknown, hosts: readonly string[], itemField = "") => Array.isArray(items)
    ? items.slice(0, 10).flatMap(item => allowedUrl(itemField ? field(item, itemField) : item, hosts) ?? []) : [];

  function groupCommand(name: string, run: (signal: AbortSignal, limit: number) => Promise<CommandReply>) {
    return async (argument: string, context: CommandContext): Promise<CommandReply> => {
      if (argument || context.message_type !== "group" || context.isDelegated || lifecycle.aborted) return [];
      const limit = Math.min(context.inlineImageByteLimit ?? maxImageBytes, maxImageBytes);
      const key = `${name}:${limit}`;
      let pending = inFlight.get(key);
      if (!pending) {
        if (inFlight.size >= 4) return "查询较忙，请稍后再试。";
        const signal = AbortSignal.any([lifecycle, AbortSignal.timeout(12_000)]);
        pending = run(signal, limit).finally(() => inFlight.delete(key));
        inFlight.set(key, pending);
      }
      const reply = await pending;
      return lifecycle.aborted ? [] : reply;
    };
  }

  async function imageReply(title: string, candidates: readonly URL[], signal: AbortSignal, limit: number): Promise<CommandReply> {
    const unique = [...new Map(candidates.map(url => [url.href, url])).values()];
    const nodes = [];
    for (let start = 0; start < unique.length && !signal.aborted; start += imageBatchSize) {
      const batch = await Promise.all(unique.slice(start, start + imageBatchSize).map(url => image(url, signal, limit)));
      nodes.push(...batch.flatMap(bytes => bytes?.length ? [segment.image(bytes)] : []));
    }
    if (!nodes.length) return `${title}暂时无法获取，请稍后再试。`;
    return { type: "forward", nodes, batchSize: imageBatchSize, senderName: title };
  }

  return {
    name: "@lotus-yunzai/general-tools",
    commands: {
      "#cat": groupCommand("cat", async (signal, limit) => {
        const candidates = await Promise.all(catSources.map(async ([endpoint, itemField, hosts]) =>
          urls(await json(endpoint, signal), hosts, itemField)));
        return imageReply("猫图", candidates.flat(), signal, limit);
      }),
      "#推荐软件": groupCommand("software", async signal => {
        const lists = await Promise.all([["电脑", "pc"], ["安卓", "and"]].map(async ([platform, device]) => {
          const response = await json(`https://www.ghxi.com/ghapi?type=query&n=${device}`, signal, 8_000);
          const list = field(field(response, "data"), "list");
          if (field(response, "code") !== 200 || !Array.isArray(list)) return [];
          return list.slice(0, 20).flatMap(item => {
            const title = field(item, "title");
            const url = allowedUrl(field(item, "url"), ["www.ghxi.com"]);
            if (typeof title !== "string" || !title.trim() || !url) return [];
            return `${platform}推荐软件：${title.replace(/<[^>]*>/gu, "").replace(/[\r\n]+/gu, " ").trim().slice(0, 180)}\n地址：${url.href}`;
          });
        }));
        const nodes = lists.flat();
        return nodes.length ? { type: "forward", nodes, batchSize: 20, senderName: "推荐软件" } : "软件推荐暂时无法获取，请稍后再试。";
      }),
    },
  };
}
