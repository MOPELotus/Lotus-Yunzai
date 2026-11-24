import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const directories = ["resources/builtin", "packages/skia/assets"];
for (const plugin of await readdir(join(root, "plugins"))) directories.push(`plugins/${plugin}/resources`);
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
const files = [];
for (const file of paths.sort()) {
  const bytes = await readFile(file);
  files.push({ path: relative(root, file).replaceAll("\\", "/"), bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex") });
}
await writeFile(join(root, "resources/builtin/manifest.json"), JSON.stringify({ format: 1, files }, null, 2) + "\n");
console.log(`已记录 ${files.length} 个文件，${files.reduce((n, file) => n + file.bytes, 0)} 字节。`);
