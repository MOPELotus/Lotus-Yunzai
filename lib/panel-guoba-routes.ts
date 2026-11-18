import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { loadGuobaForm } from "./panel-guoba.ts";
import { readPanelJson } from "./panel.ts";
import type { PluginLoadReport } from "./plugins/loader.ts";

export function panelGuobaRoutes(directories: PluginLoadReport["directories"]) {
  async function list(request: Request): Promise<Response> {
    if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
    const forms = await Promise.all([...directories].map(async ([name, { path }]) => {
      const resource = await lstat(join(path, "guoba.support.js")).catch(() => undefined);
      return resource?.isFile() ? name : undefined;
    }));
    return Response.json({ plugins: forms.filter((name) => name !== undefined).sort() });
  }

  async function form(request: Request, directory: string): Promise<Response> {
    if (request.method !== "GET" && request.method !== "PUT") {
      return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } });
    }
    try {
      const support = await loadGuobaForm(directory);
      if (!support) return new Response(null, { status: 404 });
      if (request.method === "GET") return Response.json({ schemas: support.schemas, ...await support.read() });

      let data: unknown;
      try {
        data = await readPanelJson(request);
      } catch {
        return new Response(null, { status: 400 });
      }
      const { ok, status, message } = await support.save(data);
      return Response.json({ ok, message }, { status });
    } catch {
      return new Response(null, { status: 500 });
    }
  }

  return (path: string) => {
    if (path === "/panel/api/guoba") return list;
    const name = /^\/panel\/api\/guoba\/([^/]+)$/u.exec(path)?.[1];
    if (!name) return;
    let directory: string | undefined;
    try {
      directory = directories.get(decodeURIComponent(name))?.path;
    } catch {
      return;
    }
    return directory ? (request: Request) => form(request, directory) : undefined;
  };
}
