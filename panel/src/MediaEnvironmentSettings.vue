<script setup lang="ts">
import { panelText } from './i18n.ts';

import { ElButton } from "element-plus";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { mediaEnvironmentGroups, type MediaEnvironmentSettings,
  type MediaEnvironmentSnapshot } from "../../lib/panel-media-environment-schema.ts";
import { panelFetch, type PanelAuth } from "./api.ts";
import AccountPermissionsSettings from "./AccountPermissionsSettings.vue";

const props = defineProps<{ auth: PanelAuth }>();
const emit = defineEmits<{ unauthorized: []; "dirty-change": [dirty: boolean] }>();
const endpoint = `${import.meta.env.BASE_URL}api/settings/media/environment`;
const saved = ref<MediaEnvironmentSnapshot>();
const draft = ref<MediaEnvironmentSettings>();
const busy = ref<"load" | "save">();
const error = ref("");
const feedback = ref("");
const changes = computed(() => {
  if (!draft.value || !saved.value) return {};
  const before = saved.value.settings;
  return Object.fromEntries(Object.entries(draft.value).filter(([key, value]) => value !== before[key as keyof MediaEnvironmentSettings]));
});
const dirty = computed(() => Object.keys(changes.value).length > 0);
let active: AbortController | undefined;

const permissionsDirty = ref(false);
const previewPermissionsDirty = ref(false);
const ownerPermissionsDirty = ref(false);
watch(() => dirty.value || permissionsDirty.value || previewPermissionsDirty.value || ownerPermissionsDirty.value,
  value => emit("dirty-change", value));

async function sync(mode: "load" | "save") {
  if (active || (mode === "save" && !dirty.value)) return;
  if (mode === "load" && dirty.value && !window.confirm(panelText('MediaEnvironmentSettings.70081fd60b'))) return;
  const changedFields = Object.keys(changes.value);
  const startsNextBoot = changedFields.includes("update_delay_ms");
  const hasOtherChanges = changedFields.some(field => field !== "update_delay_ms");
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
      error.value = panelText('MediaEnvironmentSettings.bbc6698bf1');
      return;
    }
    if (response.status === 400) {
      error.value = panelText('MediaEnvironmentSettings.460cab4c0c');
      return;
    }
    if (!response.ok) {
      error.value = mode === "load" ? panelText('MediaEnvironmentSettings.577de693a0') : panelText('MediaEnvironmentSettings.7178673551');
      return;
    }
    const result = await response.json() as MediaEnvironmentSnapshot;
    if (active !== controller) return;
    if (typeof result?.revision !== "string" || !result.settings || !mediaEnvironmentGroups.every(group =>
      group.fields.every(({ key, max }) => Number.isSafeInteger(result.settings[key]) && result.settings[key] >= (key === "update_delay_ms" ? 0 : 1) && result.settings[key] <= max))) {
      error.value = panelText('MediaEnvironmentSettings.c0618f41b1');
      return;
    }
    saved.value = result;
    draft.value = { ...result.settings };
    if (mode === "save") {
      if (startsNextBoot) feedback.value = hasOtherChanges
        ? panelText('MediaEnvironmentSettings.d48aed502a')
        : panelText('MediaEnvironmentSettings.47f7438936');
      else feedback.value = panelText('MediaEnvironmentSettings.960af22dd2');
    }
  } catch {
    if (active === controller) error.value = panelText('MediaEnvironmentSettings.19818d1a03');
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
  <section aria-labelledby="media-environment-title" :aria-busy="Boolean(busy)">
    <div class="section-heading">
      <h1 id="media-environment-title" tabindex="-1">{{ panelText('MediaEnvironmentSettings.8b884a36f7') }}</h1>
      <ElButton :loading="busy === 'load'" :disabled="Boolean(busy)" @click="sync('load')">{{ panelText('MediaEnvironmentSettings.df7392cc96') }}</ElButton>
    </div>
    <p v-if="error" class="error refresh-error" role="alert">{{ error }}</p>
    <form v-if="draft" class="media-environment-settings" @submit.prevent="sync('save')">
      <fieldset v-for="group in mediaEnvironmentGroups" :key="group.section" :disabled="Boolean(busy)">
        <legend>{{ group.label }}</legend>
        <template v-for="field in group.fields" :key="field.key">
          <label :for="`media-environment-${field.key}`">{{ field.label }}</label>
          <input :id="`media-environment-${field.key}`" v-model.number="draft[field.key]" type="number" :min="field.key === 'update_delay_ms' ? 0 : 1"
            :max="field.max" step="1" required
            :aria-describedby="field.key === 'update_delay_ms' ? 'media-startup-delay-note' : undefined" />
          <p v-if="field.key === 'update_delay_ms'" id="media-startup-delay-note" class="subtitle">
            {{ panelText('MediaEnvironmentSettings.9f60ee48c1') }}
          </p>
        </template>
      </fieldset>
      <div class="media-environment-actions">
        <ElButton type="primary" native-type="submit" :loading="busy === 'save'" :disabled="!dirty || Boolean(busy)">{{ panelText('MediaEnvironmentSettings.a3030bf8f1') }}</ElButton>
        <span v-if="feedback" role="status">{{ feedback }}</span>
      </div>
    </form>
    <AccountPermissionsSettings class="media-download-permissions" :auth="auth" section="media-download"
      @unauthorized="emit('unauthorized')" @dirty-change="permissionsDirty = $event" />
    <AccountPermissionsSettings class="media-preview-permissions" :auth="auth" section="media-preview"
      @unauthorized="emit('unauthorized')" @dirty-change="previewPermissionsDirty = $event" />
    <AccountPermissionsSettings class="media-owner-permissions" :auth="auth" section="media-owner"
      @unauthorized="emit('unauthorized')" @dirty-change="ownerPermissionsDirty = $event" />
  </section>
</template>

<style scoped>
.media-download-permissions, .media-preview-permissions, .media-owner-permissions { margin-top: 26px; }
.media-environment-settings { max-width: 660px; margin-top: 20px; padding: 16px; border: 1px solid var(--line); border-radius: 13px; background: var(--surface); }
fieldset { display: grid; gap: 7px; padding: 0; border: 0; margin: 0; min-width: 0; }
fieldset + fieldset { margin-top: 16px; }
legend { padding: 0; margin-bottom: 9px; font-weight: 650; }
fieldset .subtitle { margin: 0; }
fieldset input[type="number"] { border: 1px solid var(--line); padding: 8px; border-radius: 6px; color: inherit; background: var(--surface); }
.media-environment-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 9px; }
.media-environment-actions span { color: var(--accent); }
.media-environment-actions { margin-top: 14px; }
</style>
