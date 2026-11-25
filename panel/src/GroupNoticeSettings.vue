<script setup lang="ts">
import { panelText } from './i18n.ts';

import { ElButton } from "element-plus";
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { panelFetch, type PanelAuth } from "./api.ts";
import GroupCleanupSettings from "./GroupCleanupSettings.vue";

const props = defineProps<{ auth: PanelAuth }>();
const emit = defineEmits<{
  unauthorized: [];
  "dirty-change": [dirty: boolean];
}>();

const fields = [
  { key: "privateMessage", label: panelText('GroupNoticeSettings.fc0b8c0305') },
  { key: "groupMessage", label: panelText('GroupNoticeSettings.9a82c8965f') },
  { key: "grouptemporaryMessage", label: panelText('GroupNoticeSettings.0d3b7c33ec') },
  { key: "PrivateRecall", label: panelText('GroupNoticeSettings.12accaff01') },
  { key: "groupRecall", label: panelText('GroupNoticeSettings.607c6db0f1') },
  { key: "friendRequest", label: panelText('GroupNoticeSettings.db01e8f6e4') },
  { key: "groupInviteRequest", label: panelText('GroupNoticeSettings.3e720b37f9') },
  { key: "addGroupApplication", label: panelText('GroupNoticeSettings.8a343626e1') },
  { key: "friendNumberChange", label: panelText('GroupNoticeSettings.59201b4531') },
  { key: "groupNumberChange", label: panelText('GroupNoticeSettings.c3afaed55e') },
  { key: "groupMemberNumberChange", label: panelText('GroupNoticeSettings.9db9d0d6ea') },
  { key: "groupAdminChange", label: panelText('GroupNoticeSettings.17a8c31791') },
  { key: "botBeenBanned", label: panelText('GroupNoticeSettings.028909ae77') },
  { key: "notificationsAll", label: panelText('GroupNoticeSettings.2e9480c647') },
] as const;
const settingsKeys = [...fields.map(({ key }) => key), "msgSaveDeltime"] as const;
const maxRetention = Math.floor(Number.MAX_SAFE_INTEGER / 1_000);
type Settings = Record<(typeof fields)[number]["key"], boolean | null> & { msgSaveDeltime: number | null | "invalid" };
interface Snapshot {
  settings: Settings;
  revision: string;
  writable: boolean;
  scope: string;
  scopes: string[];
}

const endpoint = `${import.meta.env.BASE_URL}api/settings/group/notices`;
const selectedScope = ref("default");
const inputScope = ref("default");
const scoped = computed(() => selectedScope.value !== "default");
const validScope = computed(() => inputScope.value === "default" ||
  (/^(?:[1-9]\d*|bot:[1-9]\d*(?::[1-9]\d*)?)$/u.test(inputScope.value) &&
    inputScope.value.replace(/^bot:/u, "").split(":").every(id => Number.isSafeInteger(Number(id)))));
const baseline = shallowRef<Snapshot>();
const draft = ref<Settings>();
const busy = ref<"GET" | "PUT">();
const error = ref("");
const notice = ref("");
const conflict = ref(false);
const confirmReload = ref(false);
const confirmScope = ref<string>();
let active: AbortController | undefined;

const patch = computed(() => {
  const previous = baseline.value?.settings;
  const current = draft.value;
  if (!previous || !current) return {};
  return Object.fromEntries(settingsKeys.filter(key => previous[key] !== current[key]).map(key => [key, current[key]]));
});
const dirty = computed(() => Object.keys(patch.value).length > 0);
const validRetention = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= maxRetention;
const canSaveRetention = computed(() =>
  draft.value?.msgSaveDeltime === baseline.value?.settings.msgSaveDeltime || validRetention(draft.value?.msgSaveDeltime) ||
  (scoped.value && draft.value?.msgSaveDeltime === null));
const cleanupDirty = ref(false);
const readOnly = computed(() => baseline.value?.writable === false);
watch(dirty, (value) => {
  if (!value) confirmReload.value = false;
});
watch(() => dirty.value || cleanupDirty.value, value => emit("dirty-change", value));

function isSnapshot(value: unknown): value is Snapshot {
  if (value === null || typeof value !== "object" || !("revision" in value) ||
      typeof value.revision !== "string" || !("writable" in value) || typeof value.writable !== "boolean" ||
      !("settings" in value) || value.settings === null || typeof value.settings !== "object" ||
      !("scope" in value) || value.scope !== selectedScope.value || !("scopes" in value) ||
      !Array.isArray(value.scopes) || !value.scopes.every(scope => typeof scope === "string")) return false;

  const settings = value.settings as Record<string, unknown>;
  return fields.every(({ key }) => typeof settings[key] === "boolean" || (scoped.value && settings[key] === null)) &&
    (settings.msgSaveDeltime === null || validRetention(settings.msgSaveDeltime) || (scoped.value && settings.msgSaveDeltime === "invalid"));
}

async function request(method: "GET" | "PUT") {
  if (active) return;
  const current = baseline.value;
  if (method === "PUT" && (!current?.writable || !dirty.value || !canSaveRetention.value || conflict.value || confirmReload.value || confirmScope.value)) return;
  const body = method === "PUT" && current ? JSON.stringify({ revision: current.revision, patch: patch.value }) : undefined;

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
    const response = await panelFetch(`${endpoint}?${new URLSearchParams({ scope: selectedScope.value })}`, props.auth, {
      method, headers, body, signal: controller.signal,
    });
    if (active !== controller) return;
    if (response.status === 401) {
      emit("unauthorized");
      return;
    }
    if (response.status === 409) {
      conflict.value = true;
      error.value = panelText('GroupNoticeSettings.1f7211c562');
      return;
    }
    if (!response.ok) {
      if (response.status === 403) {
        if (current) baseline.value = { ...current, writable: false };
        error.value = method === "PUT" ? panelText('GroupNoticeSettings.c5af3c9792') : panelText('GroupNoticeSettings.0146b98034');
      } else if (response.status === 404) error.value = panelText('GroupNoticeSettings.2eeccf41bb');
      else if (response.status === 400) error.value = panelText('GroupNoticeSettings.cbe2ba19db');
      else error.value = method === "PUT" ? panelText('GroupNoticeSettings.f98c4a6892') : panelText('GroupNoticeSettings.6345760c7c');
      return;
    }

    const data: unknown = await response.json().catch(() => undefined);
    if (active !== controller) return;
    if (!isSnapshot(data)) {
      error.value = panelText('GroupNoticeSettings.9941f89119');
      return;
    }
    baseline.value = data;
    draft.value = { ...data.settings };
    conflict.value = false;
    if (method === "PUT") notice.value = panelText('GroupNoticeSettings.975d8f9297');
  } catch {
    if (active === controller) error.value = panelText('GroupNoticeSettings.19818d1a03');
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

function scopeLabel(scope: string) {
  if (scope === "default") return panelText('GroupNoticeSettings.419bf8bc14');
  if (!scope.startsWith("bot:")) return panelText('GroupNoticeSettings.b053cdf42f', { value1: scope });
  const [, bot, group] = scope.split(":");
  return group ? panelText('GroupNoticeSettings.363ff81e78', { value1: bot, value2: group }) : panelText('GroupNoticeSettings.00a9f18c37', { value1: bot });
}

function loadScope(next: string) {
  confirmScope.value = undefined;
  selectedScope.value = inputScope.value = next;
  baseline.value = undefined;
  draft.value = undefined;
  conflict.value = false;
  void request("GET");
}

function selectScope() {
  if (!validScope.value || inputScope.value === selectedScope.value || busy.value) return;
  if (dirty.value) confirmScope.value = inputScope.value;
  else loadScope(inputScope.value);
}

function setOverride(key: (typeof fields)[number]["key"], event: Event) {
  if (!draft.value) return;
  const value = (event.currentTarget as HTMLSelectElement).value;
  draft.value[key] = value === "inherit" ? null : value === "on";
}

function setRetention(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  if (draft.value) draft.value.msgSaveDeltime = Number.isFinite(input.valueAsNumber) ? input.valueAsNumber : null;
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
  confirmScope.value = undefined;
  selectedScope.value = inputScope.value = "default";
  void request("GET");
}, { immediate: true });

onBeforeUnmount(() => {
  active?.abort();
  active = undefined;
  emit("dirty-change", false);
});
</script>

<template>
  <section class="group-settings" aria-labelledby="group-notice-settings-title" :aria-busy="Boolean(busy)">
    <div class="section-heading">
      <h1 id="group-notice-settings-title" tabindex="-1">{{ panelText('GroupNoticeSettings.a6d489ae13') }}</h1>
      <ElButton :loading="busy === 'GET'" :disabled="Boolean(busy) || confirmReload" @click="reload">{{ panelText('GroupNoticeSettings.35588dcb9b') }}</ElButton>
    </div>

    <form class="settings-card" @submit.prevent="selectScope">
      <label class="notice-option" for="group-notice-target">{{ panelText('GroupNoticeSettings.d77674f908') }}</label>
      <div class="action-group">
        <input id="group-notice-target" v-model.trim="inputScope" list="group-notice-scopes" :disabled="Boolean(busy) || Boolean(confirmScope)" />
        <datalist id="group-notice-scopes">
          <option value="default">{{ panelText('GroupNoticeSettings.419bf8bc14') }}</option>
          <option v-for="scope in baseline?.scopes" :key="scope" :value="scope">{{ scopeLabel(scope) }}</option>
        </datalist>
        <ElButton native-type="submit" :disabled="!validScope || inputScope === selectedScope || Boolean(busy) || Boolean(confirmScope)">{{ panelText('GroupNoticeSettings.a9c1deca85') }}</ElButton>
      </div>
      <p class="subtitle">{{ panelText('GroupNoticeSettings.3415a2e98c') }}</p>
    </form>
    <div v-if="confirmScope" class="feedback">
      <p>{{ panelText('GroupNoticeSettings.ff8b88346a') }}</p>
      <div class="action-group">
        <ElButton @click="confirmScope = undefined">{{ panelText('GroupNoticeSettings.2cd0f3be87') }}</ElButton>
        <ElButton type="danger" @click="loadScope(confirmScope!)">{{ panelText('GroupNoticeSettings.65185812cc') }}</ElButton>
      </div>
    </div>

    <div v-if="confirmReload" class="feedback">
      <p>{{ panelText('GroupNoticeSettings.0079325ab9') }}</p>
      <div class="action-group">
        <ElButton @click="confirmReload = false">{{ panelText('GroupNoticeSettings.2cd0f3be87') }}</ElButton>
        <ElButton type="danger" @click="request('GET')">{{ panelText('GroupNoticeSettings.c1364194f7') }}</ElButton>
      </div>
    </div>
    <p v-if="error" class="error refresh-error" role="alert">{{ error }}</p>
    <p v-else-if="!draft && busy" class="placeholder" role="status">{{ panelText('GroupNoticeSettings.8a044dd742') }}</p>
    <p v-if="readOnly && !error" class="placeholder" role="status">{{ panelText('GroupNoticeSettings.6e6f4994d6') }}</p>

    <form v-if="draft" @submit.prevent="request('PUT')">
      <fieldset class="settings-card" aria-labelledby="group-notice-defaults" aria-describedby="group-notice-scope"
        :disabled="Boolean(busy) || readOnly || confirmReload || Boolean(confirmScope)">
        <h2 id="group-notice-defaults">{{ scopeLabel(selectedScope) }}</h2>
        <p id="group-notice-scope" class="subtitle">{{ panelText('GroupNoticeSettings.9575e95b3f') }}</p>
        <label v-for="{ key, label } in fields" :key="key" class="notice-option">
          <span>{{ label }}
            <small v-if="key === 'notificationsAll' && draft.notificationsAll !== null" class="option-hint">{{ draft.notificationsAll ? panelText('GroupNoticeSettings.e6930ffc2e') : panelText('GroupNoticeSettings.0a2f123f85') }}</small>
          </span>
          <select v-if="scoped" :id="`group-notice-${key}`" :value="draft[key] === null ? 'inherit' : draft[key] ? 'on' : 'off'"
            @change="setOverride(key, $event)">
            <option value="inherit">{{ panelText('GroupNoticeSettings.49f1e2b9d1') }}</option>
            <option value="on">{{ key === 'notificationsAll' ? panelText('GroupNoticeSettings.350b867641') : panelText('GroupNoticeSettings.8da97ddda9') }}</option>
            <option value="off">{{ key === 'notificationsAll' ? panelText('GroupNoticeSettings.5fa03850e5') : panelText('GroupNoticeSettings.3fd47edce4') }}</option>
          </select>
          <input v-else :id="`group-notice-${key}`" v-model="draft[key]" type="checkbox" />
        </label>
        <label class="notice-option" for="group-notice-msgSaveDeltime">
          <span>{{ panelText('GroupNoticeSettings.53f491461a') }}
            <small v-if="!scoped && baseline?.settings.msgSaveDeltime === null || draft.msgSaveDeltime === 'invalid'" class="option-hint">{{ panelText('GroupNoticeSettings.9e0ff537c4') }}</small>
            <small v-else-if="scoped" class="option-hint">{{ panelText('GroupNoticeSettings.4d335b52ef') }}</small>
          </span>
          <input id="group-notice-msgSaveDeltime" class="retention-input" type="number" min="1" :max="maxRetention" step="1"
            :value="typeof draft.msgSaveDeltime === 'number' ? draft.msgSaveDeltime : ''" :aria-invalid="!canSaveRetention" @input="setRetention" />
          <ElButton v-if="scoped && draft.msgSaveDeltime !== null" @click="draft.msgSaveDeltime = null">{{ panelText('GroupNoticeSettings.49f1e2b9d1') }}</ElButton>
        </label>
        <p v-if="!canSaveRetention" class="error" role="alert">{{ panelText('GroupNoticeSettings.caa6a1555c') }}</p>
      </fieldset>
      <div class="feedback save-bar">
        <p v-if="notice || dirty" role="status">{{ dirty ? panelText('GroupNoticeSettings.535083c5e5') : notice }}</p>
        <ElButton type="primary" native-type="submit" :loading="busy === 'PUT'"
          :disabled="!dirty || !canSaveRetention || readOnly || conflict || Boolean(busy) || confirmReload || Boolean(confirmScope)">{{ panelText('GroupNoticeSettings.6e584e3d5c') }}</ElButton>
      </div>
    </form>
    <GroupCleanupSettings :auth="auth" @unauthorized="emit('unauthorized')" @dirty-change="cleanupDirty = $event" />
  </section>
</template>

<style scoped>
.placeholder { color: var(--muted); font-size: 14px; line-height: 1.55; }
.subtitle { margin-bottom: 12px; }

.notice-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  min-height: 44px;
  padding: 10px 0;
  border-top: 1px solid var(--line);
  font-size: 15px;
  font-weight: 600;
}

.notice-option:last-child { padding-bottom: 0; }
.notice-option input[type="checkbox"] { flex: 0 0 18px; width: 18px; height: 18px; margin: 0; accent-color: var(--accent); }
.option-hint { display: block; margin-top: 3px; color: var(--muted); font-weight: 400; }
.retention-input { width: min(125px, 35%); }
.notice-option input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
