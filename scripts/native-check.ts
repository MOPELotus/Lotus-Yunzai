import "../lib/i18n-preload.ts";
import { createRequire } from "node:module";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { detectNativeCpu, needsBaselineBuild } from "../lib/native-cpu.ts";
import { nativeBuildCacheRoot } from "../lib/native-build.ts";
import { prepareNativeComponent } from "../lib/native-compatibility.ts";
import { runNativeCommand } from "../lib/native-process.ts";
import { nativeComponents, type NativeComponent } from "../lib/native-policy.ts";
import { recoverSkiaBinary } from "./skia-binary.ts";
import { installTerminalLogging } from "../lib/terminal-log-format.ts";
import { createTranslator } from "../packages/i18n/index.ts";
import catalog from "../i18n/zh-CN.json";
const $t = createTranslator("core", catalog.messages);
installTerminalLogging();

const root = fileURLToPath(new URL("..", import.meta.url));
const cpu = await detectNativeCpu();
console.info($t("lib.native-build.cpu", { arch: cpu.arch,
  features: cpu.known ? cpu.features.filter(feature => ["sse4_2", "avx", "avx2", "bmi1", "bmi2", "fma"].includes(feature)).join(" ") : $t("lib.native-build.unknown") }));
if (needsBaselineBuild(cpu, nativeComponents.bun.features)) throw new Error($t("lib.native-build.runtime_unsupported", { features: "SSE4.2" }));
const directory = await mkdtemp(join(tmpdir(), "lotus-native-probe-"));
const abort = new AbortController();
const stop = () => abort.abort();
process.once("SIGTERM", stop); process.once("SIGINT", stop);
try {
  const html = join(directory, "probe.html"), input = join(directory, "entry.js");
  await writeFile(html, "<html><body>Native compatibility probe</body></html>");
  await writeFile(input, "export default 1");
  const definitions: { component: NativeComponent; anchor: string; module: string; code: (module: string) => string; binary?: string; nativeModule?: string }[] = [
    { component: "skia-canvas", anchor: "packages/skia/package.json", module: "skia-canvas", binary: "lib/skia.node",
      code: module => `const {Canvas}=require(${module});const c=new Canvas(8,8);c.gpu=false;c.getContext('2d').fillRect(0,0,8,8);if(!(await c.toBuffer('png')).length)throw Error('PNG');` },
    { component: "sharp", anchor: "packages/captcha/package.json", module: "sharp", binary: "src/build/Release/sharp-linux-x64-{version}.node",
      code: module => `if(!(await require(${module})({create:{width:8,height:8,channels:3,background:'white'}}).png().toBuffer()).length)throw Error('PNG');` },
    { component: "resvg", anchor: "packages/captcha/package.json", module: "@resvg/resvg-js", nativeModule: "@resvg/resvg-js-linux-x64-gnu",
      code: module => `const{Resvg}=require(${module});if(!new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>').render().asPng().length)throw Error('SVG');` },
    { component: "onnxruntime", anchor: "packages/captcha/package.json", module: "onnxruntime-node",
      code: module => `const o=require(${module});const model=Buffer.from('CAg6XQoRCgFhCgFiEgF5IgZNYXRNdWwSCXN5bnRoZXRpY1oTCgFhEg4KDAgBEggKAggCCgIIAloTCgFiEg4KDAgBEggKAggCCgIIAmITCgF5Eg4KDAgBEggKAggCCgIIAkICEA0=','base64');const s=await o.InferenceSession.create(model,{intraOpNumThreads:1,interOpNumThreads:1});try{const t=new o.Tensor('float32',new Float32Array([1,1,1,1]),[2,2]);const r=await s.run({a:t,b:t});if([...r.y.data].some(v=>v!==2))throw Error('MatMul');}finally{await s.release();}` },
    { component: "shotium", anchor: "package.json", module: "@pixel.js/shotium",
      code: module => `const{default:s}=await import(${module});s.start({cacheDir:null});try{if(!(await s.screenshot({file:${JSON.stringify(html)}})).image.length)throw Error('PNG');}finally{await s.stop();}` },
    { component: "rolldown", anchor: "panel/node_modules/vite/package.json", module: "rolldown", nativeModule: "@rolldown/binding-linux-x64-gnu",
      code: module => `const r=require(${module});const b=await r.rolldown({input:${JSON.stringify(input)}});try{if(!(await b.generate({format:'es'})).output.length)throw Error('bundle');}finally{await b.close();}` },
  ];
  for (const item of definitions) {
    abort.signal.throwIfAborted();
    const require = createRequire(await realpath(join(root, item.anchor)));
    const metadata = await realpath(require.resolve(item.module + "/package.json"));
    const { version } = await Bun.file(metadata).json();
    const module = JSON.stringify(require.resolve(item.module));
    const probe = () => runNativeCommand([process.execPath, "--no-env-file", "--eval", `(async()=>{${item.code(module)}})().catch(e=>{console.error(e);process.exitCode=1})`],
      { cwd: root, signal: abort.signal, timeoutMs: 60_000 });
    if (item.component === "skia-canvas") await recoverSkiaBinary(new URL("../", import.meta.url));
    const native = item.nativeModule && cpu.platform === "linux" && cpu.arch === "x64" && !cpu.system?.includes("non-glibc")
      ? createRequire(metadata).resolve(item.nativeModule) : undefined;
    await prepareNativeComponent({ component: item.component, version, cpu, cacheRoot: nativeBuildCacheRoot(),
      binary: item.binary ? join(dirname(metadata), item.binary.replace("{version}", version)) : native ?? metadata, probe, signal: abort.signal, progress: console.info });
  }
} finally {
  process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop);
  await rm(directory, { recursive: true, force: true });
}
