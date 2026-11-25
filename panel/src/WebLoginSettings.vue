<script setup lang="ts">
import { panelText } from './i18n.ts';

import { ElButton } from "element-plus";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import type { WebLoginSettings, WebLoginSnapshot } from "../../lib/panel-web-login-schema.ts";
import { panelFetch, type PanelAuth } from "./api.ts";
import { siteIcpLink, siteIcpMaxLength } from "../../lib/web-icp.ts";

const props = defineProps<{ auth: PanelAuth }>();
const emit = defineEmits<{ unauthorized: []; "dirty-change": [dirty: boolean] }>();
const endpoint = `${import.meta.env.BASE_URL}api/settings/web/login`;
const userDurations = [
  { key: "ticket_minutes", label: panelText('WebLoginSettings.1f0400e9ea'), step: "1" },
  { key: "session_hours", label: panelText('WebLoginSettings.73533dfcc2'), step: "any" },
] as const;
const panelDurations = [
  { key: "panel_ticket_minutes", label: panelText('WebLoginSettings.ad9c9e3880'), step: "1" },
  { key: "panel_session_hours", label: panelText('WebLoginSettings.377a43fbcb'), step: "any" },
] as const;
const durations = [...userDurations, ...panelDurations];
type Draft = Omit<WebLoginSettings, typeof durations[number]["key"]> & Record<typeof durations[number]["key"], string>;

const saved = shallowRef<WebLoginSnapshot>();
const draft = ref<Draft>();
const busy = ref<"GET" | "PUT">();
const error = ref("");
const notice = ref("");
const conflict = ref(false);
const confirmReload = ref(false);
let active: AbortController | undefined;

function asDraft(settings: WebLoginSettings): Draft {
  return {
    ...settings,
    ticket_minutes: String(settings.ticket_minutes), session_hours: String(settings.session_hours),
    panel_ticket_minutes: String(settings.panel_ticket_minutes), panel_session_hours: String(settings.panel_session_hours),
  };
}

const changed = computed(() => {
  if (!draft.value || !saved.value) return {};
  const before = saved.value.settings;
  const values: WebLoginSettings = {
    ...draft.value,
    ticket_minutes: Number(draft.value.ticket_minutes), session_hours: Number(draft.value.session_hours),
    panel_ticket_minutes: Number(draft.value.panel_ticket_minutes), panel_session_hours: Number(draft.value.panel_session_hours),
  };
  return Object.fromEntries(Object.entries(values).filter(([key, value]) => before[key as keyof WebLoginSettings] !== value));
});
const dirty = computed(() => Object.keys(changed.value).length > 0);
watch(dirty, value => { emit("dirty-change", value); if (!value) confirmReload.value = false; });

function isSnapshot(input: unknown): input is WebLoginSnapshot {
  if (!input || typeof input !== "object" || !("revision" in input) || !("settings" in input) ||
      typeof input.revision !== "string" || !/^[a-f0-9]{64}$/u.test(input.revision) ||
      !input.settings || typeof input.settings !== "object") return false;
  const item = input.settings as Partial<WebLoginSettings>;
  return typeof item.enable === "boolean" && typeof item.public_url === "string" && typeof item.path === "string" && typeof item.icp_number === "string" &&
    durations.every(({ key }) => typeof item[key] === "number" && Number.isFinite(item[key]));
}

async function request(method: "GET" | "PUT") {
  if (active || (method === "PUT" && (!saved.value || !dirty.value || conflict.value || confirmReload.value))) return;
  const controller = new AbortController();
  active = controller;
  busy.value = method;
  error.value = "";
  notice.value = "";
  confirmReload.value = false;
  try {
    const body = method === "PUT" ? JSON.stringify({ revision: saved.value!.revision, patch: changed.value }) : undefined;
    const response = await panelFetch(endpoint, props.auth, {
      method, body, headers: body ? { "Content-Type": "application/json" } : undefined,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
    });
    if (active !== controller) return;
    if (response.status === 401) return emit("unauthorized");
    if (response.status === 409) {
      conflict.value = true;
      error.value = panelText('WebLoginSettings.cd92b3cd67');
      return;
    }
    if (response.status === 400 || response.status === 422) {
      error.value = response.status === 400 ? panelText('WebLoginSettings.28a01b885e') : panelText('WebLoginSettings.207da41087');
      return;
    }
    if (!response.ok) throw new Error();
    const snapshot = await response.json() as unknown;
    if (active !== controller) return;
    if (!isSnapshot(snapshot)) throw new Error();
    saved.value = snapshot;
    draft.value = asDraft(snapshot.settings);
    conflict.value = false;
    if (method === "PUT") notice.value = panelText('WebLoginSettings.193f229df3');
  } catch {
    if (active === controller) error.value = panelText('WebLoginSettings.d746bdeb1e');
  } finally {
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

onMounted(() => { void request("GET"); });
onBeforeUnmount(() => {
  active?.abort();
  active = undefined;
  emit("dirty-change", false);
});
</script>

<template>
  <section aria-labelledby="web-login-title" :aria-busy="Boolean(busy)">
    <div class="section-heading">
      <h1 id="web-login-title" tabindex="-1">{{ panelText('WebLoginSettings.658333c8c7') }}</h1>
      <ElButton :loading="busy === 'GET'" :disabled="Boolean(busy) || confirmReload" @click="reload">{{ panelText('WebLoginSettings.df7392cc96') }}</ElButton>
    </div>
    <div v-if="confirmReload" class="login-settings-actions" role="alert">
      <span>{{ panelText('WebLoginSettings.e71b339a4e') }}</span>
      <ElButton @click="confirmReload = false">{{ panelText('WebLoginSettings.fd4b9e3b6c') }}</ElButton>
      <ElButton type="danger" @click="request('GET')">{{ panelText('WebLoginSettings.a5831537bd') }}</ElButton>
    </div>
    <p v-if="error" class="error refresh-error" role="alert">{{ error }}</p>
    <form v-if="draft" class="login-settings" @submit.prevent="request('PUT')">
      <fieldset :disabled="Boolean(busy) || confirmReload">
        <legend>{{ panelText('WebLoginSettings.14c0d006d8') }}</legend>
        <label class="login-toggle">
          <input v-model="draft.enable" type="checkbox" />{{ panelText('WebLoginSettings.113986c4e4') }}
        </label>
        <label>
          {{ panelText('WebLoginSettings.4c24cd68dd') }}
          <input v-model="draft.public_url" type="text" inputmode="url" :placeholder="panelText('WebLoginSettings.697f87f94d')" maxlength="2048" />
        </label>
        <label>
          {{ panelText('WebLoginSettings.a1341f45ea') }}
          <input v-model="draft.path" type="text" :placeholder="panelText('WebLoginSettings.6be3695d99')" maxlength="512" />
        </label>
        <label v-for="field in userDurations" :key="field.key">
          {{ field.label }}
          <input v-model="draft[field.key]" type="number" :step="field.step" :min="field.step === '1' ? 1 : 0" required />
        </label>
      </fieldset>
      <fieldset :disabled="Boolean(busy) || confirmReload">
        <legend>{{ panelText('WebLoginSettings.02f82f9d42') }}</legend>
        <label v-for="field in panelDurations" :key="field.key">
          {{ field.label }}
          <input v-model="draft[field.key]" type="number" :step="field.step" :min="field.step === '1' ? 1 : 0" required />
        </label>
      </fieldset>
      <fieldset :disabled="Boolean(busy) || confirmReload">
        <legend>{{ panelText('WebLoginSettings.378443ac08') }}</legend>
        <label>
          {{ panelText('WebLoginSettings.94a5394702') }}
          <input id="web-icp-number" v-model="draft.icp_number" type="text" :maxlength="siteIcpMaxLength"
            :placeholder="panelText('WebLoginSettings.673940bc65')" aria-describedby="web-icp-note" />
        </label>
        <p id="web-icp-note" class="login-note">{{ panelText('WebLoginSettings.dcf37df668') }}</p>
      </fieldset>
      <p class="login-note">{{ panelText('WebLoginSettings.e104354319') }}</p>
      <div class="login-settings-actions">
        <ElButton type="primary" native-type="submit" :loading="busy === 'PUT'"
          :disabled="!dirty || Boolean(busy) || confirmReload || conflict">{{ panelText('WebLoginSettings.a3030bf8f1') }}</ElButton>
        <span v-if="notice" role="status">{{ notice }}</span>
      </div>
    </form>
    <footer v-if="saved?.settings.icp_number" class="site-footer">
      <a :href="siteIcpLink" target="_blank" rel="noopener noreferrer">{{ saved.settings.icp_number }}</a>
    </footer>
  </section>
</template>

<style scoped>
.site-footer { max-width: 660px; margin-top: 24px; text-align: center; overflow-wrap: anywhere; }
.site-footer a { color: var(--muted); text-underline-offset: 3px; }
.login-settings { display: grid; gap: 12px; max-width: 660px; margin-top: 20px; }
.login-settings fieldset {
  display: grid; gap: 10px; min-width: 0; margin: 0; padding: 14px;
  border: 1px solid var(--line); border-radius: 12px; background: var(--surface);
}
.login-settings legend { padding: 0 4px; font-weight: 650; }
.login-settings label { display: grid; gap: 4px; font-size: 14px; font-weight: 600; }
.login-settings label.login-toggle { display: flex; align-items: center; }
.login-toggle input { accent-color: var(--accent); }
.login-settings input:not([type="checkbox"]) {
  width: 100%; min-height: 36px; padding: 0 9px; border: 1px solid var(--el-border-color);
  border-radius: 4px; background: var(--surface); color: inherit; font: inherit; font-weight: 400;
}
.login-note, .login-settings-actions span { color: var(--muted); font-size: 14px; }
.login-settings-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.login-settings-actions :deep(.el-button + .el-button) { margin-left: 0; }
</style>
