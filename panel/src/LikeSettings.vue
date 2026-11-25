<script setup lang="ts">
import { panelText } from './i18n.ts';

import { ElButton, ElInput } from "element-plus";
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { panelFetch, type PanelAuth } from "./api.ts";

const props = defineProps<{ auth: PanelAuth }>();
const emit = defineEmits<{
  unauthorized: [];
  "dirty-change": [dirty: boolean];
}>();

const toggles = [
  { key: "enable", label: panelText('LikeSettings.af88aef8a5'), help: panelText('LikeSettings.fd4cf86d34') },
  { key: "cloneAllThumbUp", label: panelText('LikeSettings.e8574dc99e'), help: panelText('LikeSettings.7a3a2f47e1') },
  { key: "strangeThumbUp", label: panelText('LikeSettings.53ddfe2d56'), help: panelText('LikeSettings.bf132d44f7') },
] as const;
const messages = [
  { key: "closeTips", label: panelText('LikeSettings.a48d2f4e1e') },
  { key: "successMsg", label: panelText('LikeSettings.6bd445b0e0') },
  { key: "failsMsg", label: panelText('LikeSettings.2bc04fca5b') },
  { key: "noFriendMsg", label: panelText('LikeSettings.d62a3bee9d') },
] as const;
type ToggleKey = (typeof toggles)[number]["key"];
type MessageKey = (typeof messages)[number]["key"];
type Settings = Record<ToggleKey, boolean> & Record<MessageKey, string | false> & { count: number; recall: number };
type Draft = Omit<Settings, "count" | "recall"> & { count: number | ""; recall: number | "" };
interface Snapshot {
  settings: Settings;
  revision: string;
}
const placeholderHelp = panelText('LikeSettings.9e03f1b1bb');
const keys = [...toggles.map(({ key }) => key), "count", "recall", ...messages.map(({ key }) => key)] as const;
const endpoint = `${import.meta.env.BASE_URL}api/settings/group/likes`;

const baseline = shallowRef<Snapshot>();
const draft = ref<Draft>();
const busy = ref<"GET" | "PUT">();
const error = ref("");
const notice = ref("");
const conflict = ref(false);
const confirmReload = ref(false);
const hiddenMessages = new Map<MessageKey, string>();
let active: AbortController | undefined;

const changed = computed(() => {
  const saved = baseline.value?.settings;
  const edited = draft.value;
  return saved && edited ? keys.filter((key) => saved[key] !== edited[key]) : [];
});
const dirty = computed(() => changed.value.length > 0);
const validCount = computed(() => isCount(draft.value?.count));
const validRecall = computed(() => isRecall(draft.value?.recall));
watch(dirty, (value) => {
  emit("dirty-change", value);
  if (!value) confirmReload.value = false;
});

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 10;
}

function isRecall(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 120;
}

function isSnapshot(value: unknown): value is Snapshot {
  if (value === null || typeof value !== "object" || !("revision" in value) ||
      typeof value.revision !== "string" || !("settings" in value) ||
      value.settings === null || typeof value.settings !== "object") return false;

  const config = value.settings as Record<string, unknown>;
  return isCount(config.count) && isRecall(config.recall) &&
    toggles.every(({ key }) => typeof config[key] === "boolean") &&
    messages.every(({ key }) => config[key] === false || typeof config[key] === "string");
}

function setMessageEnabled(key: MessageKey, enabled: boolean) {
  const edited = draft.value;
  if (!edited) return;
  const before = edited[key];
  if (enabled) edited[key] = hiddenMessages.get(key) ?? "";
  else if (before !== false) {
    hiddenMessages.set(key, before);
    edited[key] = false;
  }
}

async function request(method: "GET" | "PUT") {
  if (active) return;
  const current = baseline.value;
  const edited = draft.value;
  if (method === "PUT" && (!current || !edited || !dirty.value || !validCount.value || !validRecall.value || conflict.value)) return;
  const body = method === "PUT" && current && edited
    ? JSON.stringify({ revision: current.revision, patch: Object.fromEntries(changed.value.map((key) => [key, edited[key]])) })
    : undefined;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  active = controller;
  busy.value = method;
  error.value = "";
  notice.value = "";
  confirmReload.value = false;
  try {
    const headers = new Headers();
    if (body !== undefined) headers.set("Content-Type", "application/json");
    const response = await panelFetch(endpoint, props.auth, {
      method, headers, body, signal: controller.signal,
    });
    if (active !== controller) return;
    if (response.status === 401) {
      emit("unauthorized");
      return;
    }
    if (response.status === 409) {
      conflict.value = true;
      error.value = panelText('LikeSettings.1f7211c562');
      return;
    }
    if (!response.ok) {
      if (response.status === 400) error.value = panelText('LikeSettings.ff7b4bf70c');
      else if (response.status === 404) error.value = panelText('LikeSettings.498148784c');
      else error.value = panelText('LikeSettings.704b200b93');
      return;
    }

    const data: unknown = await response.json().catch(() => undefined);
    if (active !== controller) return;
    if (!isSnapshot(data)) {
      error.value = panelText('LikeSettings.125ddfcbba');
      return;
    }
    baseline.value = data;
    draft.value = { ...data.settings };
    hiddenMessages.clear();
    conflict.value = false;
    if (method === "PUT") notice.value = panelText('LikeSettings.52c8dd437c');
  } catch {
    if (active === controller) error.value = panelText('LikeSettings.19818d1a03');
  } finally {
    clearTimeout(timeout);
    if (active === controller) {
      active = undefined;
      busy.value = undefined;
    }
  }
}

function reload() {
  if (dirty.value) confirmReload.value = true;
  else void request("GET");
}

watch(() => props.auth, () => {
  active?.abort();
  active = undefined;
  busy.value = undefined;
  error.value = "";
  notice.value = "";
  baseline.value = undefined;
  draft.value = undefined;
  conflict.value = false;
  confirmReload.value = false;
  hiddenMessages.clear();
  void request("GET");
}, { immediate: true });

onBeforeUnmount(() => {
  active?.abort();
  active = undefined;
  emit("dirty-change", false);
});
</script>

<template>
  <section class="group-settings" aria-labelledby="like-settings-title" :aria-busy="Boolean(busy)">
    <div class="section-heading">
      <h1 id="like-settings-title" tabindex="-1">{{ panelText('LikeSettings.7f028f6c2c') }}</h1>
      <ElButton :loading="busy === 'GET'" :disabled="Boolean(busy) || confirmReload" @click="reload">{{ panelText('LikeSettings.35588dcb9b') }}</ElButton>
    </div>

    <div v-if="confirmReload" class="feedback">
      <p>{{ panelText('LikeSettings.0079325ab9') }}</p>
      <div class="action-group">
        <ElButton @click="confirmReload = false">{{ panelText('LikeSettings.2cd0f3be87') }}</ElButton>
        <ElButton type="danger" @click="request('GET')">{{ panelText('LikeSettings.c1364194f7') }}</ElButton>
      </div>
    </div>
    <p v-if="error" class="error refresh-error" role="alert">{{ error }}</p>
    <p v-else-if="!draft && busy" class="placeholder" role="status">{{ panelText('LikeSettings.8a044dd742') }}</p>

    <form v-if="draft" novalidate @submit.prevent="request('PUT')">
      <fieldset class="settings-card" aria-labelledby="like-rules-title" :disabled="Boolean(busy)">
        <div class="card-heading"><h2 id="like-rules-title">{{ panelText('LikeSettings.55e410f30f') }}</h2></div>
        <div v-for="toggle in toggles" :key="toggle.key" class="setting-row">
          <label :for="`like-${toggle.key}`">{{ toggle.label }}</label>
          <p class="setting-help" :id="`like-${toggle.key}-help`">{{ toggle.help }}</p>
          <input :id="`like-${toggle.key}`" v-model="draft[toggle.key]" type="checkbox" :aria-describedby="`like-${toggle.key}-help`" />
        </div>
        <div class="setting-row">
          <label for="like-count">{{ panelText('LikeSettings.66aff666a5') }}</label>
          <p class="setting-help" id="like-count-help">{{ panelText('LikeSettings.395921c5fb') }}</p>
          <input id="like-count" v-model.number="draft.count" type="number" min="1" max="10" step="1"
            required aria-describedby="like-count-help" :aria-invalid="!validCount" />
        </div>
        <div class="setting-row">
          <label for="like-recall">{{ panelText('LikeSettings.2953e4e03d') }}</label>
          <p class="setting-help" id="like-recall-help">{{ panelText('LikeSettings.e98a77cc38') }}</p>
          <input id="like-recall" v-model.number="draft.recall" type="number" min="0" max="120" step="any"
            required aria-describedby="like-recall-help" :aria-invalid="!validRecall" />
        </div>
      </fieldset>

      <fieldset class="settings-card" aria-labelledby="like-messages-title" :disabled="Boolean(busy)">
        <div class="card-heading">
          <h2 id="like-messages-title">{{ panelText('LikeSettings.f2933eb9ef') }}</h2>
          <p class="setting-help" v-text="placeholderHelp"></p>
        </div>
        <div class="message-grid">
          <div v-for="field in messages" :key="field.key" class="message-field">
            <div class="message-heading">
              <label :for="`like-${field.key}`">{{ field.label }}</label>
              <label class="message-toggle">
                <input
                  type="checkbox"
                  :aria-label="panelText('LikeSettings.b41c191c0b', { value1: field.label })"
                  :checked="draft[field.key] !== false"
                  @change="setMessageEnabled(field.key, ($event.target as HTMLInputElement).checked)"
                />
                <span>{{ panelText('LikeSettings.edecf0ae6e') }}</span>
              </label>
            </div>
            <ElInput
              :id="`like-${field.key}`"
              type="textarea"
              :rows="2"
              :model-value="draft[field.key] || ''"
              :disabled="Boolean(busy) || draft[field.key] === false"
              :placeholder="panelText('LikeSettings.6bad204934')"
              @update:model-value="draft[field.key] = $event"
            />
          </div>
        </div>
      </fieldset>

      <div class="feedback save-bar">
        <p v-if="notice || dirty" role="status">{{ dirty ? panelText('LikeSettings.535083c5e5') : notice }}</p>
        <ElButton type="primary" native-type="submit"
          :loading="busy === 'PUT'" :disabled="!dirty || !validCount || !validRecall || conflict || Boolean(busy)">
          {{ panelText('LikeSettings.6e584e3d5c') }}
        </ElButton>
      </div>
    </form>
  </section>
</template>

<style scoped>
.card-heading { padding-bottom: 12px; }
.card-heading .setting-help { margin-top: 6px; }
.setting-help, .placeholder { color: var(--muted); font-size: 14px; line-height: 1.55; }

.setting-row {
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-areas: "label control" "help control";
  align-items: center;
  gap: 4px 14px;
  padding: 12px 0;
  border-top: 1px solid var(--line);
}

.setting-row:last-child { padding-bottom: 0; }
.setting-row > label { grid-area: label; }
.setting-row > p { grid-area: help; }
.setting-row > input { grid-area: control; justify-self: end; }

.setting-row label, .message-heading > label:first-child { font-size: 15px; font-weight: 600; }
input[type="checkbox"] { width: 18px; height: 18px; accent-color: var(--accent); }
input[type="number"] {
  width: 88px;
  min-height: 36px;
  padding: 4px 8px;
  border: 1px solid var(--el-border-color);
  border-radius: 5px;
  background: var(--surface);
  color: var(--ink);
  font: inherit;
  font-size: 14px;
}
input[aria-invalid="true"] { border-color: #a23b30; }
input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.message-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 20px; }
.message-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.message-heading { margin-bottom: 6px; }
.message-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 30px;
  color: var(--muted);
  font-size: 13px;
}

@media (max-width: 600px) {
  .message-grid { grid-template-columns: 1fr; }
}
</style>
