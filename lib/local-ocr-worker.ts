import { isAbsolute, join } from "node:path";
import { CString, dlopen, ptr, read, FFIType as F } from "bun:ffi";

import { localOcrImageBytes, localOcrOutputBytes } from "./local-ocr.ts";

const languages = ["chi_sim", "eng"] as const;
const symbols = {
  TessBaseAPICreate: { args: [], returns: F.ptr },
  TessBaseAPIDelete: { args: [F.ptr], returns: F.void },
  TessBaseAPIInit2: { args: [F.ptr, F.ptr, F.ptr, F.i32], returns: F.i32 },
  TessBaseAPIGetLoadedLanguagesAsVector: { args: [F.ptr], returns: F.ptr },
  TessDeleteTextArray: { args: [F.ptr], returns: F.void },
  TessBaseAPISetPageSegMode: { args: [F.ptr, F.i32], returns: F.void },
  TessBaseAPISetImage2: { args: [F.ptr, F.ptr], returns: F.void },
  TessBaseAPIRecognize: { args: [F.ptr, F.ptr], returns: F.i32 },
  TessBaseAPIGetUTF8Text: { args: [F.ptr], returns: F.ptr },
  TessDeleteText: { args: [F.ptr], returns: F.void },
  pixReadMem: { args: [F.ptr, F.u64], returns: F.ptr },
  pixDestroy: { args: [F.ptr], returns: F.void },
} as const;

function openEngine() {
  const linux = process.platform === "linux";
  if (!linux && process.platform !== "darwin") return;
  const soname = linux ? "libtesseract.so.5" : "libtesseract.5.dylib";
  const triplet = process.arch === "x64" ? "x86_64-linux-gnu" : "aarch64-linux-gnu";
  const system = linux ? [`/usr/lib/${triplet}`, "/usr/lib64", "/usr/lib", "/usr/local/lib64", "/usr/local/lib"]
    : ["/opt/homebrew/lib", "/usr/local/lib", "/opt/local/lib", "/usr/lib"];
  const loader = linux ? process.env.LD_LIBRARY_PATH : process.env.DYLD_LIBRARY_PATH;
  for (const directory of [...(loader?.split(":") ?? []), ...system]) {
    if (!isAbsolute(directory)) continue;
    // A bare soname can make Bun fall back to the current checkout. Resolve only
    // the pinned ABI in system library dirs or an administrator's loader path.
    try { return dlopen(join(directory, soname), symbols); } catch {}
  }
}

/** Calls Tesseract 5's C ABI in a disposable Bun process. */
async function run(prepare: boolean) {
  const engine = openEngine();
  if (!engine) return 2;
  // Leptonica symbols resolve through Tesseract's linked dependency, so PIX
  // objects are created and released using the same library copy.
  const api = engine.symbols;
  const handle = api.TessBaseAPICreate();
  if (!handle) {
    engine.close();
    return 1;
  }
  try {
    const bytes = (value: string) => new TextEncoder().encode(value + "\0");
    const requested = bytes(languages.join("+"));
    const configured = process.env.TESSDATA_PREFIX;
    const data = configured === undefined ? undefined : bytes(configured);
    if (api.TessBaseAPIInit2(handle, data ? ptr(data) : null, ptr(requested), 1) !== 0) return 3;
    const loaded = api.TessBaseAPIGetLoadedLanguagesAsVector(handle);
    if (!loaded) return 3;
    try {
      const remaining = new Set<string>(languages);
      const pointerBytes = BigUint64Array.BYTES_PER_ELEMENT;
      for (let index = 0; index < 256 && remaining.size; index++) {
        const language = read.ptr(loaded, pointerBytes * index);
        if (!language) break;
        remaining.delete(String(new CString(language)));
      }
      if (remaining.size) return 3;
    } finally { api.TessDeleteTextArray(loaded); }
    if (prepare) return 0;

    const image = new Uint8Array(await Bun.stdin.arrayBuffer());
    if (!image.length || image.length > localOcrImageBytes) return 1;
    const input = api.pixReadMem(ptr(image), BigInt(image.length));
    if (!input) return 1;
    try {
      api.TessBaseAPISetPageSegMode(handle, 3);
      api.TessBaseAPISetImage2(handle, input);
      if (api.TessBaseAPIRecognize(handle, null) !== 0) return 1;
      const text = api.TessBaseAPIGetUTF8Text(handle);
      if (!text) return 1;
      try {
        let size = 0;
        while (size <= localOcrOutputBytes && read.u8(text, size) !== 0) size++;
        if (size > localOcrOutputBytes) return 1;
        if (size !== 0) await Bun.write(Bun.stdout, String(new CString(text, 0, size)));
        return 0;
      } finally { api.TessDeleteText(text); }
    } finally {
      const holder = new BigUint64Array([BigInt(input)]);
      api.pixDestroy(ptr(holder));
    }
  } finally {
    api.TessBaseAPIDelete(handle);
    engine.close();
  }
}

if (import.meta.main) {
  const action = Bun.argv[2];
  process.exitCode = action === "prepare" || action === "recognize" ? await run(action === "prepare") : 1;
}
