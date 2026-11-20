import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type MessageReply, segment } from "../lib/messages.ts";
import { legacyTemplateRender } from "../lib/renderer/legacy-template.ts";

test("V3 静态模板按插件资源定位，并保留旧回调与两个图片发送模式", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-legacy-render-"));
  const plugin = join(root, "approved");
  const resources = join(plugin, "resources");
  const templates = join(resources, "help");
  const index = join(templates, "index.html");
  const other = join(templates, "other.html");
  const outside = join(root, "external.html");
  const image = segment.image(new Uint8Array([1, 4, 9]));
  const sent: MessageReply[] = [];
  const rendered: { name: string; data: object }[] = [];
  let active = true;
  const render = legacyTemplateRender(reply => { sent.push(reply); return true; },
    name => active && name === "approved" ? plugin : undefined,
    async (name, data) => { rendered.push({ name, data }); return image; });

  try {
    await mkdir(templates, { recursive: true });
    await Promise.all([index, other, outside].map(file => writeFile(file, "<main></main>")));
    await symlink(outside, join(templates, "escape.html"));
    const options = {
      retType: "base64",
      beforeRender({ data }: { data: Record<string, unknown> }) {
        expect(this).toBe(options);
        data.title = "原地添加";
      },
    };
    expect(await render("approved", "/help//index.html", { save_id: "legacy", _plugin: "foreign", tplFile: outside }, options)).toBe(image);
    expect(sent).toEqual([]);
    const base = pathToFileURL(resources + "/").href;
    expect(rendered[0]).toMatchObject({ name: "approved/help/index", data: {
      tplFile: index, _plugin: "approved", _htmlPath: "help/index", _res_path: base, pluResPath: base,
      saveId: "legacy", title: "原地添加", sys: { scale: 1 },
    } });

    expect(await render("approved", "help/index", {}, {
      beforeRender: () => ({ tplFile: other, title: "完全替换" }),
    })).toBe(true);
    expect(rendered[1]).toEqual({ name: "approved/help/index", data: { tplFile: other, title: "完全替换" } });
    expect(sent).toEqual([image]);

    for (const name of ["help/../index", "help\\index", "help/escape", "missing"]) {
      expect(await render("approved", name, {}, { retType: "base64" })).toBe(false);
    }
    expect(await render("unloaded", "help/index")).toBe(true);
    expect(await render("approved", "help/index", {}, { beforeRender: () => ({ tplFile: outside }) })).toBe(true);
    await expect(render("approved", "help/index", {}, { beforeRender() { throw new Error("旧回调失败"); } }))
      .rejects.toThrow("旧回调失败");
    expect(rendered).toHaveLength(2);
    expect(sent).toEqual([image]);

    const late = legacyTemplateRender(reply => { sent.push(reply); return true; },
      () => active ? plugin : undefined,
      async () => { active = false; return image; });
    expect(await late("approved", "help/index")).toBe(true);
    expect(sent).toEqual([image]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
