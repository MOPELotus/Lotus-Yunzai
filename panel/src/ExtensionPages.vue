<script setup lang="ts">
import { panelText } from './i18n.ts';

import { mdiLanConnect, mdiPuzzleOutline } from "@mdi/js";
import { ElButton } from "element-plus";
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { panelFetch, type PanelAuth } from "./api.ts";
interface ExtensionPage {
  id: string;
  plugin: string;
  title: string;
  icon?: string;
  priority: number;
  servicePreview?: boolean;
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
  invalid: panelText('ExtensionPages.77a3f7bb72'),
  "duplicate-id": panelText('ExtensionPages.3eb15db771'),
} as const satisfies Record<Issue["kind"], string>;

const props = defineProps<{ auth: PanelAuth; preferences: Map<string, string> }>();
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
    (value.icon === undefined || typeof value.icon === "string") &&
    (value.servicePreview === undefined || value.servicePreview === true);
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
    if (frame.searchParams.get("__webBase") === "/guoba") {
      frame.searchParams.set("__webBase", new URL("../guoba", panel).pathname);
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
      if (opened.ticket) {
        const path = `${endpoint}/${encodeURIComponent(opened.pageId)}/renew`;
        const response = await panelFetch(path, props.auth, {
          method: "POST",
          headers: { "guoba-access-token": opened.ticket },
          signal: AbortSignal.any([opened.lifetime.signal, AbortSignal.timeout(4_000)]),
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
  if (active) return;
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
    const response = await panelFetch(path, props.auth, {
      method: page || rescan ? "POST" : "GET",
      signal: controller.signal,
    });
    if (active !== controller) return;
    if (response.status === 401) {
      emit("unauthorized");
      return;
    }
    if (!response.ok) {
      error.value = response.status === 404
        ? (page ? panelText('ExtensionPages.5a8e4a8b24') : panelText('ExtensionPages.8a574c1e2f'))
        : (page ? panelText('ExtensionPages.12254e14c8') : panelText('ExtensionPages.63caf91006'));
      return;
    }

    const data: unknown = await response.json().catch(() => undefined);
    if (active !== controller) return;
    if (page) {
      const url = isRecord(data) ? scopedUrl(data.url, page.id) : undefined;
      if (!url) {
        error.value = panelText('ExtensionPages.302c94b0eb');
        return;
      }
      openFrame(url, page);
    } else {
      if (!isRecord(data) || !Array.isArray(data.pages) || !data.pages.every(isPage) ||
          !Array.isArray(data.issues) || !data.issues.every(isIssue)) {
        error.value = panelText('ExtensionPages.42838d494f');
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
    if (active === controller) error.value = panelText('ExtensionPages.19818d1a03');
  } finally {
    clearTimeout(timeout);
    if (active === controller) {
      active = undefined;
      busy.value = undefined;
    }
  }
  if (reopen) await load(reopen);
}

watch(() => props.auth, () => {
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
      <h1 id="extensions-title" tabindex="-1">{{ panelText('ExtensionPages.eccf12cef9') }}</h1>
      <ElButton :loading="busy === 'list'" :disabled="Boolean(busy)" @click="load(undefined, true)">{{ panelText('ExtensionPages.daf5103f90') }}</ElButton>
    </div>

    <p v-if="error" class="error refresh-error" role="alert">{{ error }}</p>
    <p v-if="busy === 'list' && !catalog" class="extension-note" role="status">{{ panelText('ExtensionPages.5aa1ee9ec8') }}</p>

    <div v-if="catalog?.pages.length" class="extension-layout">
      <nav class="extension-nav" :aria-label="panelText('ExtensionPages.ef24959da1')">
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
          <ElButton :loading="busy === 'open'" :disabled="Boolean(busy)" @click="load(selected)">{{ panelText('ExtensionPages.9366e1784d') }}</ElButton>
        </div>
        <iframe v-if="frameUrl" ref="frame" :src="frameUrl" :title="selected.title"
          :sandbox="selected.servicePreview ? 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox' : 'allow-scripts allow-forms'"
          referrerpolicy="no-referrer" />
        <p v-else-if="busy === 'open'" class="extension-note" role="status">{{ panelText('ExtensionPages.6b5799d00a') }}</p>
      </div>
      <div v-else class="extension-view extension-placeholder">{{ panelText('ExtensionPages.1f38fe0aad') }}</div>
    </div>
    <p v-else-if="catalog && !catalog.issues.length && !busy" class="extension-note" role="status">
      {{ panelText('ExtensionPages.f463efe798') }}
    </p>

    <section v-if="catalog?.issues.length" class="extension-issues" aria-labelledby="extension-issues-title">
      <h2 id="extension-issues-title">{{ panelText('ExtensionPages.54aac220ef') }}</h2>
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
