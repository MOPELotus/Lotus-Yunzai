<script setup lang="ts">
import { panelText } from './i18n.ts';

import { ElButton } from "element-plus";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { musicNumbers, musicPlatforms, musicQualities, type MusicPanelSettings,
  type MusicPanelSnapshot } from "../../lib/panel-music-schema.ts";
import { panelFetch, type PanelAuth } from "./api.ts";

const props = defineProps<{ auth: PanelAuth }>();
const emit = defineEmits<{ unauthorized: []; "dirty-change": [dirty: boolean] }>();
const endpoint = `${import.meta.env.BASE_URL}api/settings/media/music`;
const saved = ref<MusicPanelSnapshot>();
const draft = ref<MusicPanelSettings>();
const busy = ref<"load" | "save">();
const error = ref("");
const feedback = ref("");
const changes = computed(() => {
  if (!draft.value || !saved.value) return {};
  const before = saved.value.settings;
  return Object.fromEntries(Object.entries(draft.value).filter(([key, value]) => value !== before[key as keyof MusicPanelSettings]));
});
const dirty = computed(() => Object.keys(changes.value).length > 0);
let active: AbortController | undefined;

watch(dirty, value => emit("dirty-change", value));

async function sync(mode: "load" | "save") {
  if (active || (mode === "save" && !dirty.value)) return;
  if (mode === "load" && dirty.value && !window.confirm(panelText('MusicSettings.bca955b1e3'))) return;
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
      error.value = panelText('MusicSettings.bbc6698bf1');
      return;
    }
    if (response.status === 400) {
      error.value = panelText('MusicSettings.fbcaf17391');
      return;
    }
    if (!response.ok) {
      error.value = mode === "load" ? panelText('MusicSettings.282699d00e') : panelText('MusicSettings.9072ae8151');
      return;
    }
    const result = await response.json() as MusicPanelSnapshot;
    if (active !== controller) return;
    if (typeof result?.revision !== "string" || typeof result?.settings?.enable !== "boolean" ||
        !musicPlatforms.some(({ value }) => value === result.settings.default_platform) ||
        !musicQualities.some(({ value }) => value === result.settings.quality) ||
        !musicNumbers.every(({ key }) => Number.isSafeInteger(result.settings[key]) && result.settings[key] > 0)) {
      error.value = panelText('MusicSettings.fe5ed7a4b8');
      return;
    }
    saved.value = result;
    draft.value = { ...result.settings };
    if (mode === "save") feedback.value = panelText('MusicSettings.105b3ca823');
  } catch {
    if (active === controller) error.value = panelText('MusicSettings.19818d1a03');
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
  <section aria-labelledby="music-settings-title" :aria-busy="Boolean(busy)">
    <div class="section-heading">
      <h1 id="music-settings-title" tabindex="-1">{{ panelText('MusicSettings.a06569eff5') }}</h1>
      <ElButton :loading="busy === 'load'" :disabled="Boolean(busy)" @click="sync('load')">{{ panelText('MusicSettings.df7392cc96') }}</ElButton>
    </div>
    <p v-if="error" class="error refresh-error" role="alert">{{ error }}</p>
    <form v-if="draft" class="music-settings" @submit.prevent="sync('save')">
      <fieldset :disabled="Boolean(busy)">
        <label class="music-toggle"><input v-model="draft.enable" type="checkbox" />{{ panelText('MusicSettings.6e8bc1ea6d') }}</label>
        <label for="music-platform">{{ panelText('MusicSettings.6ba8708460') }}</label>
        <select id="music-platform" v-model="draft.default_platform">
          <option v-for="{ value, label } in musicPlatforms" :key="value" :value="value">{{ label }}</option>
        </select>
        <label for="music-quality">{{ panelText('MusicSettings.3024a0f90b') }}</label>
        <select id="music-quality" v-model="draft.quality">
          <option v-for="{ value, label } in musicQualities" :key="value" :value="value">{{ label }}</option>
        </select>
        <template v-for="field in musicNumbers" :key="field.key">
          <label :for="`music-${field.key}`">{{ field.label }}</label>
          <input :id="`music-${field.key}`" v-model.number="draft[field.key]" type="number" min="1"
            :max="'max' in field ? field.max : Number.MAX_SAFE_INTEGER" step="1" required />
        </template>
      </fieldset>
      <p class="subtitle">{{ panelText('MusicSettings.b5b4cff25f') }}</p>
      <div class="music-actions">
        <ElButton type="primary" native-type="submit" :loading="busy === 'save'" :disabled="!dirty || Boolean(busy)">{{ panelText('MusicSettings.a3030bf8f1') }}</ElButton>
        <span v-if="feedback" role="status">{{ feedback }}</span>
      </div>
    </form>
  </section>
</template>

<style scoped>
.music-settings { max-width: 660px; margin-top: 20px; padding: 16px; border: 1px solid var(--line); border-radius: 13px; background: var(--surface); }
fieldset { display: grid; gap: 7px; padding: 0; border: 0; margin: 0; min-width: 0; }
fieldset input[type="number"], fieldset select { border: 1px solid var(--line); padding: 8px; border-radius: 6px; color: inherit; background: var(--surface); }
.music-toggle, .music-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 9px; }
.music-toggle input { accent-color: var(--accent); }
.music-actions span { color: var(--accent); }
.subtitle { margin: 12px 0; }
</style>
