import { spawn } from "node:child_process";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";

type Options = {
  readonly scale?: number;
  readonly imgType?: "png" | "jpeg" | "webp";
  readonly quality?: number;
  readonly viewport?: { readonly width?: number; readonly height?: number };
};
type Result = Record<string, any>;
interface ProtocolReply {
  id?: number;
  result?: Result;
  error?: { message: string };
}

let running = 0;

export async function renderChromiumStatic(executable: string, file: string, temporary: string, options: Options) {
  if (running >= 2) throw new Error("Chromium 静态模板渲染繁忙。");
  running++;
  try {
    return await capture(executable, file, temporary, options);
  } finally {
    running--;
  }
}

async function capture(executable: string, file: string, temporary: string, options: Options) {
  const arguments_ = [
    "--headless=new", "--enable-gpu", "--use-gl=angle", "--use-angle=vulkan",
    "--enable-gpu-rasterization", "--ignore-gpu-blocklist", "--disable-software-rasterizer", "--disable-background-networking",
    "--disable-default-apps", "--disable-extensions", "--disable-sync", "--no-default-browser-check", "--no-first-run",
    "--allow-file-access-from-files", "--blink-settings=scriptEnabled=false",
    "--remote-debugging-pipe", "--user-data-dir=" + join(temporary, "chromium"), "about:blank",
  ];
  if (Bun.env.LOTUS_CHROMIUM_NO_SANDBOX === "1") arguments_.unshift("--no-sandbox");
  const signal = AbortSignal.timeout(15_000);
  const child = spawn(executable, arguments_, { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], signal, killSignal: "SIGKILL" });
  const input = child.stdio[3] as Writable;
  const output = child.stdio[4] as Readable;
  const pending = new Map<number, { resolve: (value: Result) => void; reject: (error: Error) => void }>();
  let counter = 0;
  let accumulated = "";
  let terminal: Error | undefined;
  function fail(error: Error) {
    terminal ??= error;
    for (const pendingCall of pending.values()) pendingCall.reject(error);
    pending.clear();
  }
  child.on("error", fail);
  child.on("exit", () => fail(new Error("Chromium 在截图完成前退出。")));
  input.on("error", fail);
  output.on("error", fail);
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    accumulated += chunk;
    if (accumulated.length > 80 * 1024 * 1024) {
      fail(new Error("Chromium 截图超过体积限制。"));
      child.kill("SIGKILL");
      return;
    }
    for (let end = accumulated.indexOf("\0"); end >= 0; end = accumulated.indexOf("\0")) {
      const raw = accumulated.slice(0, end);
      accumulated = accumulated.slice(end + 1);
      let response: ProtocolReply;
      try { response = JSON.parse(raw); }
      catch { continue; }
      if (!response.id) continue;
      const item = pending.get(response.id);
      pending.delete(response.id);
      if (response.error) item?.reject(new Error(response.error.message));
      else item?.resolve(response.result ?? {});
    }
  });
  function call(method: string, params: Result = {}, sessionId?: string): Promise<Result> {
    signal.throwIfAborted();
    if (terminal) return Promise.reject(terminal);
    const id = ++counter;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      input.write(JSON.stringify({ id, method, params, sessionId }) + "\0");
    });
  }

  try {
    const { gpu } = await call("SystemInfo.getInfo");
    const renderer = gpu?.auxAttributes?.glRenderer;
    if (typeof renderer !== "string" || !/(?:NVIDIA|AMD|ATI|Intel)/iu.test(renderer) ||
      /software|swiftshader|llvmpipe|lavapipe/iu.test(renderer) ||
      !gpu?.featureStatus?.rasterization?.startsWith("enabled")) {
      throw new Error("Chromium 无法启用物理显卡栅格化。");
    }
    const { targetId } = await call("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
    const invoke = (method: string, params?: Result) => call(method, params, sessionId);
    await invoke("Network.enable");
    await invoke("Network.setBlockedURLs", { urls: ["http://*", "https://*", "ws://*", "wss://*", "ftp://*"] });
    await invoke("Page.enable");
    await invoke("Emulation.setDeviceMetricsOverride", {
      width: options.viewport?.width ?? 1280, height: options.viewport?.height ?? 720,
      deviceScaleFactor: options.scale ?? 1, mobile: false,
    });
    const url = pathToFileURL(file).href;
    const navigation = await invoke("Page.navigate", { url });
    if (navigation.errorText) throw new Error("Chromium 无法打开静态模板。");
    let clip: Result | undefined;
    while (!clip) {
      const result = await invoke("Runtime.evaluate", {
        expression: `(async () => {
          if (location.href !== ${JSON.stringify(url)} || document.readyState !== "complete") return null;
          await document.fonts.ready;
          const element = document.querySelector("#container") || document.body;
          if (!element) return null;
          const box = element.getBoundingClientRect();
          return { x: Math.max(0, box.left + scrollX), y: Math.max(0, box.top + scrollY),
            width: Math.ceil(box.width), height: Math.ceil(box.height), scale: 1 };
        })()`, returnByValue: true, awaitPromise: true,
      }).catch(() => ({} as Result));
      clip = result.result?.value ?? undefined;
      if (!clip) await Bun.sleep(20);
    }
    const scale = options.scale ?? 1;
    const width = clip.width * scale;
    const height = clip.height * scale;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 ||
        width > 32_768 || height > 32_768 || width * height > 128_000_000) {
      throw new Error("Chromium 静态模板超出单张绘制范围。");
    }
    const image = await invoke("Page.captureScreenshot", {
      format: options.imgType ?? "png", ...(options.imgType && options.imgType !== "png" ? { quality: options.quality ?? 90 } : {}),
      clip, captureBeyondViewport: true,
    });
    if (typeof image.data !== "string") throw new Error("Chromium 未返回图像。");
    return { image: Buffer.from(image.data, "base64"), renderer };
  } finally {
    const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
    if (child.exitCode === null && child.signalCode === null) {
      void call("Browser.close").catch(() => {});
      await Promise.race([exited, Bun.sleep(750)]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await Promise.race([exited, Bun.sleep(750)]);
    }
  }
}
