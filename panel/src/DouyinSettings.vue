<script setup lang="ts">
import { panelText } from './i18n.ts';

import { ElButton } from "element-plus";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { douyinDownloadNumbers, douyinPagePolicies, douyinQualities, type DouyinPanelSettings,
  type DouyinPanelSnapshot } from "../../lib/panel-douyin-schema.ts";
import { panelFetch, type PanelAuth } from "./api.ts";

const props = defineProps<{ auth: PanelAuth }>();
const emit = defineEmits<{ unauthorized: []; "dirty-change": [dirty: boolean] }>();
const endpoint = `${import.meta.env.BASE_URL}api/settings/media/douyin`;
const saved = ref<DouyinPanelSnapshot>();
const draft = ref<DouyinPanelSettings>();
const busy = ref<"load" | "save">();
const error = ref("");
const feedback = ref("");
const changes = computed(() => {
  if (!draft.value || !saved.value) return {};
  const before = saved.value.settings;
  return Object.fromEntries(Object.entries(draft.value).filter(([key, value]) => value !== before[key as keyof DouyinPanelSettings]));
});
const dirty = computed(() => Object.keys(changes.value).length > 0);
let active: AbortController | undefined;

watch(dirty, value => emit("dirty-change", value));

async function sync(mode: "load" | "save") {
  if (active || (mode === "save" && !dirty.value)) return;
  if (mode === "load" && dirty.value && !window.confirm(panelText('DouyinSettings.23119d2208'))) return;
  const controller = new AbortController();
  active = controller;
  const timeout = setTimeout(() => controller.abort(), 10_000);
  busy.value = mode;
  error.value = feedback.value = "";
  try {
    const response = await panelFetch(endpoint, props.auth, {
      method: mode === "load" ? "GET" : "PUT",
      headers: mode === "save" ? { "Content-Type": "application/json" } : undefined,
      body: mode === "save" ? JSON.stringify({ patch: changes.value, revision: saved.value?.revision }) : undefined,
      signal: controller.signal,
    });
    if (active !== controller) return;
    if (response.status === 401) return emit("unauthorized");
    if (response.status === 409) {
      error.value = panelText('DouyinSettings.bbc6698bf1');
      return;
    }
    if (response.status === 400) {
      error.value = panelText('DouyinSettings.4b83d140c5');
      return;
    }
    if (!response.ok) {
      error.value = mode === "load" ? panelText('DouyinSettings.4657c7a137') : panelText('DouyinSettings.ca207f4ed1');
      return;
    }
    const result = await response.json() as DouyinPanelSnapshot;
    if (active !== controller) return;
    if (typeof result?.revision !== "string" || typeof result?.settings?.enable !== "boolean" ||
        !douyinPagePolicies.some(([value]) => value === result.settings.multi_page_policy) ||
        typeof result.settings.download_enabled !== "boolean" ||
        !douyinQualities.some(([value]) => value === result.settings.quality) ||
        !Number.isSafeInteger(result.settings.request_timeout_ms) || result.settings.request_timeout_ms <= 0 ||
        !douyinDownloadNumbers.every(({ key, min }) => Number.isSafeInteger(result.settings[key]) && result.settings[key] >= min)) {
      error.value = panelText('DouyinSettings.8765858676');
      return;
    }
    saved.value = result;
    draft.value = { ...result.settings };
    if (mode === "save") feedback.value = panelText('DouyinSettings.b443a51fc1');
  } catch {
    if (active === controller) error.value = panelText('DouyinSettings.19818d1a03');
  } finally {
    clearTimeout(timeout);
    if (active === controller) {
      active = undefined;
      busy.value = undefined;
    }
  }
}

onMounted(() => { void sync("load"); });
onBeforeUnmount(() => {
  active?.abort();
  active = undefined;
});
</script>

<template>
  <section aria-labelledby="douyin-settings-title" :aria-busy="Boolean(busy)">
    <div class="section-heading">
      <h1 id="douyin-settings-title" tabindex="-1">{{ panelText('DouyinSettings.fa2110c800') }}</h1>
      <ElButton :loading="busy === 'load'" :disabled="Boolean(busy)" @click="sync('load')">{{ panelText('DouyinSettings.df7392cc96') }}</ElButton>
    </div>
    <p v-if="error" class="error refresh-error" role="alert">{{ error }}</p>
    <form v-if="draft" class="douyin-settings" @submit.prevent="sync('save')">
      <fieldset :disabled="Boolean(busy)">
        <legend>{{ panelText('DouyinSettings.fbff7b5046') }}</legend>
        <label class="douyin-toggle"><input id="douyin-parse" v-model="draft.enable" type="checkbox" />{{ panelText('DouyinSettings.6c8518b072') }}</label>
        <label for="douyin-request-timeout">{{ panelText('DouyinSettings.d5e85480ab') }}</label>
        <input id="douyin-request-timeout" v-model.number="draft.request_timeout_ms" type="number" min="1"
          :max="Number.MAX_SAFE_INTEGER" step="1" required />
      </fieldset>
      <fieldset :disabled="Boolean(busy)">
        <legend>{{ panelText('DouyinSettings.4673a23061') }}</legend>
        <label class="douyin-toggle"><input id="douyin-download" v-model="draft.download_enabled" type="checkbox" />{{ panelText('DouyinSettings.c063d8795b') }}</label>
        <label for="douyin-quality">{{ panelText('DouyinSettings.b84b8852db') }}</label>
        <select id="douyin-quality" v-model="draft.quality">
          <option v-for="[value, label] in douyinQualities" :key="value" :value="value">{{ label }}</option>
        </select>
        <label for="douyin-page-policy">{{ panelText('DouyinSettings.ac7f0dd13d') }}</label>
        <select id="douyin-page-policy" v-model="draft.multi_page_policy">
          <option v-for="[value, label] in douyinPagePolicies" :key="value" :value="value">{{ label }}</option>
        </select>
        <template v-for="field in douyinDownloadNumbers" :key="field.key">
          <label :for="`douyin-${field.key}`">{{ field.label }}</label>
          <input :id="`douyin-${field.key}`" v-model.number="draft[field.key]" type="number" :min="field.min"
            :max="Number.MAX_SAFE_INTEGER" step="1" required />
        </template>
        <p class="subtitle">{{ panelText('DouyinSettings.48540559fe') }}</p>
      </fieldset>
      <div class="douyin-actions">
        <ElButton type="primary" native-type="submit" :loading="busy === 'save'" :disabled="!dirty || Boolean(busy)">{{ panelText('DouyinSettings.a3030bf8f1') }}</ElButton>
        <span v-if="feedback" role="status">{{ feedback }}</span>
      </div>
    </form>
  </section>
</template>

<style scoped>
.douyin-settings { max-width: 660px; margin-top: 20px; padding: 16px; border: 1px solid var(--line); border-radius: 13px; background: var(--surface); }
fieldset { display: grid; gap: 7px; padding: 0; border: 0; margin: 0; min-width: 0; }
fieldset + fieldset { margin-top: 16px; }
legend { padding: 0; margin-bottom: 9px; font-weight: 650; }
fieldset input[type="number"], fieldset select { border: 1px solid var(--line); padding: 8px; border-radius: 6px; color: inherit; background: var(--surface); }
.douyin-toggle, .douyin-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 9px; }
.douyin-toggle input { accent-color: var(--accent); }
.douyin-actions span { color: var(--accent); }
.subtitle { margin: 12px 0; }
</style>
