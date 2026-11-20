<script setup lang="ts">
import { mdiLanConnect, mdiPuzzleOutline } from "@mdi/js";
import { ElButton } from "element-plus";
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
interface ExtensionPage {
  id: string;
  plugin: string;
  title: string;
  icon?: string;
  priority: number;
}
interface Issue {
  plugin: string;
  kind: "invalid" | "duplicate-id";
  descriptor?: string;
  id?: string;
}
interface Catalog {
  pages: ExtensionPage[];
  issues: Issue[];
}

const extensionIconPaths = new Map([
  ["mdi:lan-connect", mdiLanConnect],
]);
const issueLabels = {
  invalid: "页面注册失败或资源无效",
  "duplicate-id": "页面 ID 重复",
} as const satisfies Record<Issue["kind"], string>;

const props = defineProps<{ token: string; preferences: Map<string, string> }>();
const emit = defineEmits<{ unauthorized: [] }>();
const endpoint = `${import.meta.env.BASE_URL}api/extensions`;
const panelRoot = "/panel/";
const catalog = shallowRef<Catalog>();
const selected = shallowRef<ExtensionPage>();
const frame = shallowRef<HTMLIFrameElement>();
const frameUrl = ref("");
const busy = ref<"list" | "open">();
const error = ref("");
let active: AbortController | undefined;
let frameState: { key: string; nonce: string; pageId: string; ticket?: string; lifetime: AbortController } | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPage(value: unknown): value is ExtensionPage {
  return isRecord(value) && typeof value.id === "string" && /^[A-Za-z0-9_-]+$/u.test(value.id) &&
    typeof value.plugin === "string" && typeof value.title === "string" &&
    typeof value.priority === "number" && Number.isFinite(value.priority) &&
    (value.icon === undefined || typeof value.icon === "string");
}

function isIssue(value: unknown): value is Issue {
  return isRecord(value) && typeof value.plugin === "string" && typeof value.kind === "string" &&
    Object.hasOwn(issueLabels, value.kind) && (value.descriptor === undefined || typeof value.descriptor === "string") &&
    (value.id === undefined || typeof value.id === "string");
}

function scopedUrl(value: unknown, pageId: string): string | undefined {
  const pagePrefix = `${panelRoot}extensions/${encodeURIComponent(pageId)}/`;
  if (typeof value !== "string" || !value.startsWith(pagePrefix)) return;
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin || !url.pathname.startsWith(pagePrefix)) return;
    const panel = new URL("./", window.location.href);
    const frame = new URL(url.pathname.slice(panelRoot.length), panel);
    frame.search = url.search;
    const api = `${panelRoot}extensions-api/${pageId}`;
    if (frame.searchParams.get("__apiBase") === api) {
      frame.searchParams.set("__apiBase", new URL(api.slice(panelRoot.length), panel).pathname);
    }
    frame.hash = url.hash;
    return frame.pathname + frame.search + frame.hash;
  } catch {
    return;
  }
}

function clearFrame() {
  frameState?.lifetime.abort();
  frameState = undefined;
  frameUrl.value = "";
}

function openFrame(url: string, page: ExtensionPage) {
  const key = JSON.stringify([page.plugin, page.id]);
  const nonce = Array.from(crypto.getRandomValues(new Uint32Array(4))).join("-");
  const frameLocation = new URL(url, window.location.origin);
  const state = { nonce, hash: frameLocation.hash, data: props.preferences.get(key) ?? "[]" };
  frameLocation.hash = "#lotus-frame:" + encodeURIComponent(JSON.stringify(state));
  frameState = {
    key, nonce, pageId: page.id,
    ticket: frameLocation.searchParams.get("token") ?? undefined,
    lifetime: new AbortController(),
  };
  frameUrl.value = frameLocation.pathname + frameLocation.search + frameLocation.hash;
}

async function handleFrameMessage(event: MessageEvent<unknown>) {
  const opened = frameState;
  if (!opened || event.origin !== "null" || event.source !== frame.value?.contentWindow) return;
  const value = event.data;
  if (!isRecord(value) || value.nonce !== opened.nonce) return;
  if (value.type === "lotus-frame-api-renew") {
    const [port] = event.ports;
    if (!port) return;
    let ticket: string | undefined;
    try {
      if (opened.ticket && props.token) {
        const path = `${endpoint}/${encodeURIComponent(opened.pageId)}/renew`;
        const response = await fetch(path, {
          method: "POST",
          headers: { Authorization: `Bearer ${props.token}`, "guoba-access-token": opened.ticket },
          signal: AbortSignal.any([opened.lifetime.signal, AbortSignal.timeout(4_000)]),
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
        });
        if (frameState !== opened) return;
        if (response.status === 401) emit("unauthorized");
        if (response.ok) {
          const data: unknown = await response.json();
          if (frameState === opened && isRecord(data) && typeof data.token === "string") {
            ticket = opened.ticket = data.token;
          }
        }
      }
    } catch {
      // Without a renewed ticket the original request still gets its normal response.
    } finally {
      port.postMessage({ token: ticket });
      port.close();
    }
    return;
  }
  if (value.type !== "lotus-frame-storage" || typeof value.data !== "string" || value.data.length > 4096 ||
      new TextEncoder().encode(value.data).byteLength > 4096) return;
  if (value.data === "[]") props.preferences.delete(opened.key);
  else props.preferences.set(opened.key, value.data);
}

async function load(page?: ExtensionPage, rescan = false) {
  if (active || !props.token) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  active = controller;
  busy.value = page ? "open" : "list";
  error.value = "";
  let reopen: ExtensionPage | undefined;
  if (page) {
    selected.value = page;
    clearFrame();
  }
  try {
    const path = page
      ? `${endpoint}/${encodeURIComponent(page.id)}/open?${new URLSearchParams({ plugin: page.plugin })}`
      : rescan ? `${endpoint}/reload` : endpoint;
    const response = await fetch(path, {
      method: page || rescan ? "POST" : "GET",
      headers: { Authorization: `Bearer ${props.token}` },
      signal: controller.signal,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
    if (active !== controller) return;
    if (response.status === 401) {
      emit("unauthorized");
      return;
    }
    if (!response.ok) {
      error.value = response.status === 404
        ? (page ? "此扩展页面已不可用。" : "宿主尚未启用扩展页面。")
        : (page ? "宿主暂时无法打开此扩展页面。" : "宿主暂时无法读取扩展清单。");
      return;
    }

    const data: unknown = await response.json().catch(() => undefined);
    if (active !== controller) return;
    if (page) {
      const url = isRecord(data) ? scopedUrl(data.url, page.id) : undefined;
      if (!url) {
        error.value = "宿主未返回可用的站内扩展页面地址。";
        return;
      }
      openFrame(url, page);
    } else {
      if (!isRecord(data) || !Array.isArray(data.pages) || !data.pages.every(isPage) ||
          !Array.isArray(data.issues) || !data.issues.every(isIssue)) {
        error.value = "宿主返回了无法识别的扩展清单。";
        return;
      }
      catalog.value = { pages: data.pages, issues: data.issues };
      const previous = selected.value;
      const opened = previous && data.pages.find(({ id, plugin }) => id === previous.id && plugin === previous.plugin);
      if (rescan || !opened) clearFrame();
      selected.value = opened;
      if (rescan) reopen = opened;
    }
  } catch {
    if (active === controller) error.value = "暂时无法连接宿主，请重试。";
  } finally {
    clearTimeout(timeout);
    if (active === controller) {
      active = undefined;
      busy.value = undefined;
    }
  }
  if (reopen) await load(reopen);
}

watch(() => props.token, () => {
  active?.abort();
  active = undefined;
  busy.value = undefined;
  selected.value = undefined;
  catalog.value = undefined;
  clearFrame();
  error.value = "";
  void load();
}, { immediate: true });

onMounted(() => window.addEventListener("message", handleFrameMessage));
onBeforeUnmount(() => {
  window.removeEventListener("message", handleFrameMessage);
  clearFrame();
  active?.abort();
  active = undefined;
});
</script>

<template>
  <section class="extensions" aria-labelledby="extensions-title" :aria-busy="Boolean(busy)">
    <div class="section-heading">
      <h1 id="extensions-title" tabindex="-1">扩展页面</h1>
      <ElButton :loading="busy === 'list'" :disabled="Boolean(busy)" @click="load(undefined, true)">重新扫描</ElButton>
    </div>

    <p v-if="error" class="error refresh-error" role="alert">{{ error }}</p>
    <p v-if="busy === 'list' && !catalog" class="extension-note" role="status">正在读取扩展清单…</p>

    <div v-if="catalog?.pages.length" class="extension-layout">
      <nav class="extension-nav" aria-label="已发现的扩展页面">
        <button
          v-for="page in catalog.pages"
          :key="page.id"
          type="button"
          :disabled="Boolean(busy)"
          :aria-current="selected?.id === page.id ? 'page' : undefined"
          @click="load(page)"
        >
          <span v-if="page.icon" class="extension-icon" aria-hidden="true">
            <svg v-if="page.icon.includes(':')" viewBox="0 0 24 24" focusable="false">
              <path :d="extensionIconPaths.get(page.icon) ?? mdiPuzzleOutline" />
            </svg>
            <template v-else>{{ page.icon }}</template>
          </span>
          <span class="extension-title">{{ page.title }}</span>
          <small>{{ page.plugin }}</small>
        </button>
      </nav>

      <div v-if="selected" class="extension-view" aria-labelledby="extension-current-title">
        <div class="section-heading extension-view-header">
          <h2 id="extension-current-title">{{ selected.title }}</h2>
          <ElButton :loading="busy === 'open'" :disabled="Boolean(busy)" @click="load(selected)">刷新页面</ElButton>
        </div>
        <iframe v-if="frameUrl" ref="frame" :src="frameUrl" :title="selected.title" sandbox="allow-scripts allow-forms"
          referrerpolicy="no-referrer" />
        <p v-else-if="busy === 'open'" class="extension-note" role="status">正在打开页面…</p>
      </div>
      <div v-else class="extension-view extension-placeholder">选择要打开的扩展页面。</div>
    </div>
    <p v-else-if="catalog && !catalog.issues.length && !busy" class="extension-note" role="status">
      当前没有可打开的扩展页面。
    </p>

    <section v-if="catalog?.issues.length" class="extension-issues" aria-labelledby="extension-issues-title">
      <h2 id="extension-issues-title">未加载的扩展</h2>
      <ul>
        <li v-for="(issue, index) in catalog.issues" :key="index">
          <strong>{{ issue.plugin }}</strong>
          <code v-if="issue.descriptor">{{ issue.descriptor }}</code>
          <code v-if="issue.id">{{ issue.id }}</code>
          <span>{{ issueLabels[issue.kind] }}</span>
        </li>
      </ul>
    </section>
  </section>
</template>

<style scoped>
.extension-layout {
  display: grid;
  grid-template-columns: minmax(155px, 1fr) minmax(0, 4fr);
  align-items: start;
  gap: 14px;
  margin-top: 20px;
}

.extension-nav, .extension-view, .extension-issues {
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 13px;
  background: var(--surface);
}

.extension-nav { display: grid; padding: 7px; gap: 2px; }
.extension-nav button {
  display: grid;
  width: 100%;
  grid-template-columns: minmax(0, 1fr);
  column-gap: 7px;
  row-gap: 3px;
  padding: 8px 9px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--ink);
  font: inherit;
  text-align: start;
  cursor: pointer;
}

.extension-nav button:hover:not(:disabled), .extension-nav button[aria-current] { background: #e5f1e8; }
.extension-nav button:focus-visible { outline: 2px solid var(--accent); }
.extension-nav button:disabled { opacity: .65; cursor: wait; }
.extension-nav button:has(.extension-icon) { grid-template-columns: 18px minmax(0, 1fr); }
.extension-icon {
  grid-row: 1 / span 2;
  align-self: start;
  overflow: hidden;
  font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", system-ui, sans-serif;
  font-size: 16px;
  line-height: 20px;
  text-align: center;
  white-space: nowrap;
}
.extension-icon svg { display: block; width: 18px; height: 20px; fill: currentColor; }
.extension-title { overflow-wrap: anywhere; font-size: 14px; font-weight: 600; }
.extension-nav small { overflow-wrap: anywhere; color: var(--muted); font-size: 12px; }

.extension-view { overflow: hidden; }
.extension-view-header { padding: 10px 12px; }
.extension-view-header h2 { overflow-wrap: anywhere; font-size: 16px; }
.extension-view iframe {
  display: block;
  width: 100%;
  height: max(420px, 68vh);
  border: 0;
  border-top: 1px solid var(--line);
}
.extension-note, .extension-placeholder { margin-top: 14px; color: var(--muted); font-size: 14px; }
.extension-placeholder, .extension-view > .extension-note { padding: 13px; }
.extension-placeholder { margin-top: 0; }

.extension-issues { margin-top: 16px; padding: 14px; }
.extension-issues h2 { font-size: 16px; }
.extension-issues ul { margin: 9px 0 0; padding: 0; list-style: none; }
.extension-issues li {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 9px;
  padding: 5px 0;
  color: var(--muted);
  overflow-wrap: anywhere;
  font-size: 14px;
}

@media (max-width: 640px) {
  .extension-layout { grid-template-columns: minmax(0, 1fr); gap: 9px; }
  .extension-nav { grid-template-columns: repeat(auto-fit, minmax(126px, 1fr)); }
  .extension-view iframe { height: max(350px, 64vh); }
}
</style>
