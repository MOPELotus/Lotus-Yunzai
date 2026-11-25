<script setup lang="ts">
import { panelText } from './i18n.ts';

import { ElButton } from "element-plus";
import AtlasGalleryInventory from "./AtlasGalleryInventory.vue";
import AtlasUpdateSettings from "./AtlasUpdateSettings.vue";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { panelFetch, type PanelAuth } from "./api.ts";

type Channel = "live" | "latest";

const options = [
  { value: "live", label: panelText('AtlasChannelSettings.93a48223a5'), description: panelText('AtlasChannelSettings.8ea79c1f9d') },
  { value: "latest", label: panelText('AtlasChannelSettings.00bb111576'), description: panelText('AtlasChannelSettings.49de692813') },
] as const satisfies ReadonlyArray<{ value: Channel; label: string; description: string }>;

const props = defineProps<{ auth: PanelAuth }>();
const emit = defineEmits<{ unauthorized: []; "dirty-change": [dirty: boolean] }>();
const endpoint = `${import.meta.env.BASE_URL}api/settings/atlas/channel`;
const saved = ref<Channel | null>();
const draft = ref<Channel | null>(null);
const updateDirty = ref(false);
const busy = ref<"load" | "save">();
const feedback = ref("");
const error = ref("");
const dirty = computed(() => saved.value !== undefined && draft.value !== saved.value);
const savedLabel = computed(() => options.find(({ value }) => value === saved.value)?.label ?? panelText('AtlasChannelSettings.c5768ca972'));
let active: AbortController | undefined;

watch(() => dirty.value || updateDirty.value, (value) => emit("dirty-change", value));

async function synchronize(mode: "load" | "save") {
  if (active || (mode === "save" && (!dirty.value || !draft.value))) return;
  const controller = new AbortController();
  active = controller;
  const timeout = setTimeout(() => controller.abort(), 10_000);
  busy.value = mode;
  error.value = "";
  feedback.value = "";
  try {
    const response = await panelFetch(endpoint, props.auth, {
      method: mode === "save" ? "PUT" : "GET",
      headers: mode === "save" ? { "Content-Type": "application/json" } : undefined,
      body: mode === "save" ? JSON.stringify({ previous: saved.value, channel: draft.value }) : undefined,
      signal: controller.signal,
    });
    if (active !== controller) return;
    if (response.status === 401) return emit("unauthorized");
    if (response.status === 409) {
      error.value = panelText('AtlasChannelSettings.fe6aeb5f64');
      return;
    }
    if (!response.ok) {
      error.value = mode === "save" ? panelText('AtlasChannelSettings.a77d5d574c') : panelText('AtlasChannelSettings.0764ce36ff');
      return;
    }
    const result = await response.json() as { channel?: unknown } | null;
    if (active !== controller) return;
    const channel = result?.channel;
    if (channel !== null && channel !== "live" && channel !== "latest") {
      error.value = panelText('AtlasChannelSettings.7a28d8650e');
      return;
    }
    saved.value = draft.value = channel;
    if (mode === "save") feedback.value = panelText('AtlasChannelSettings.42d8c144a9');
  } catch {
    if (active === controller) error.value = panelText('AtlasChannelSettings.19818d1a03');
  } finally {
    clearTimeout(timeout);
    if (active === controller) {
      active = undefined;
      busy.value = undefined;
    }
  }
}

onMounted(() => { void synchronize("load"); });
onBeforeUnmount(() => {
  active?.abort();
  active = undefined;
});
</script>

<template>
  <section aria-labelledby="atlas-channel-title" :aria-busy="Boolean(busy)">
    <div class="section-heading">
      <div>
        <h1 id="atlas-channel-title" tabindex="-1">{{ panelText('AtlasChannelSettings.eda98902b2') }}</h1>
        <p class="subtitle" v-if="saved !== undefined">{{ panelText('AtlasChannelSettings.0644f33305', { value1: savedLabel }) }}</p>
      </div>
      <ElButton :loading="busy === 'load'" :disabled="Boolean(busy)" @click="synchronize('load')">{{ panelText('AtlasChannelSettings.df7392cc96') }}</ElButton>
    </div>
    <p v-if="error" class="error refresh-error" role="alert">{{ error }}</p>

    <form v-if="saved !== undefined" class="atlas-settings" @submit.prevent="synchronize('save')">
      <fieldset :disabled="Boolean(busy)">
        <legend>{{ panelText('AtlasChannelSettings.37497feecd') }}</legend>
        <label v-for="option in options" :key="option.value" class="atlas-option"
          :class="{ 'atlas-option-selected': draft === option.value }">
          <input v-model="draft" type="radio" name="atlas-channel" :value="option.value" />
          <span>
            <strong>{{ option.label }}</strong>
            <small>{{ option.description }}</small>
          </span>
        </label>
      </fieldset>
      <p class="atlas-note">{{ panelText('AtlasChannelSettings.b79f708596') }}</p>
      <div class="atlas-actions">
        <ElButton type="primary" native-type="submit" :loading="busy === 'save'" :disabled="!dirty || Boolean(busy)">
          {{ panelText('AtlasChannelSettings.a3030bf8f1') }}
        </ElButton>
        <span v-if="feedback" role="status">{{ feedback }}</span>
      </div>
    </form>
    <AtlasUpdateSettings :auth="auth" @unauthorized="emit('unauthorized')" @dirty-change="updateDirty = $event" />
    <AtlasGalleryInventory :auth="auth" @unauthorized="emit('unauthorized')" />
  </section>
</template>

<style scoped>
.atlas-settings {
  max-width: 660px;
  margin-top: 20px;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 13px;
  background: var(--surface);
}
.atlas-settings fieldset { display: grid; gap: 8px; border: 0; margin: 0; padding: 0; min-width: 0; }
.atlas-settings legend { padding: 0; margin-bottom: 9px; font-weight: 650; }
.atlas-option {
  display: flex;
  gap: 11px;
  align-items: center;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  cursor: pointer;
}
.atlas-option-selected { border-color: var(--accent); }
.atlas-option input { margin: 0; accent-color: var(--accent); }
.atlas-option strong, .atlas-option small { display: block; }
.atlas-option small, .atlas-note { color: var(--muted); font-size: 14px; }
.atlas-note { margin: 14px 0; }
.atlas-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 9px; }
.atlas-actions span { color: var(--accent); font-size: 14px; }
</style>
