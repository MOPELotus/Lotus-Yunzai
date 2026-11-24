import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const directories = ["resources/builtin"];
// Only tracked support files outside the dedicated bundle: never inventory private overrides.
const listed = Bun.spawn(["git", "ls-files", "--recurse-submodules", "-z"], { cwd: root, stdout: "pipe", stderr: "inherit" });
const tracked = (await new Response(listed.stdout).text()).split("\0");
if (await listed.exited !== 0) throw new Error("无法读取公共资源的 Git 清单。");
const supportFile = /^(?:resources\/|packages\/[^/]+\/(?:assets|resources)\/|plugins\/[^/]+\/(?:assets|resources|[^/]*theme)\/|plugins\/[^/]+\/(?:[^/]+\/)*[^/]*-assets\/|vendor\/gt-manual\/public\/)/u;
const paths: string[] = [];
async function walk(path: string) {
  for (const entry of await readdir(path, { withFileTypes: true }).catch(error => {
    if (error.code === "ENOENT") return [];
    throw error;
  })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const file = join(path, entry.name);
    if (entry.isDirectory()) await walk(file);
    else if (entry.isFile() && file !== join(root, "resources/builtin/manifest.json")) paths.push(file);
    else if (!entry.isFile()) throw new Error(`资源不得是符号链接：${relative(root, file)}`);
  }
}
for (const path of directories) await walk(join(root, path));
for (const path of tracked) {
  if (supportFile.test(path) && path !== "resources/builtin/manifest.json") paths.push(join(root, path));
}
const files = [];
for (const file of [...new Set(paths)].sort()) {
  const bytes = await readFile(file);
  files.push({ path: relative(root, file).replaceAll("\\", "/"), bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex") });
}
await writeFile(join(root, "resources/builtin/manifest.json"), JSON.stringify({ format: 1, files }, null, 2) + "\n");
console.log(`已记录 ${files.length} 个文件，${files.reduce((n, file) => n + file.bytes, 0)} 字节。`);
