<script setup lang="ts">
import { ElButton } from "element-plus";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { mediaEnvironmentGroups, type MediaEnvironmentSettings,
  type MediaEnvironmentSnapshot } from "../../lib/panel-media-environment-schema.ts";
import { panelFetch, type PanelAuth } from "./api.ts";

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

watch(dirty, value => emit("dirty-change", value));

async function sync(mode: "load" | "save") {
  if (active || (mode === "save" && !dirty.value)) return;
  if (mode === "load" && dirty.value && !window.confirm("放弃未保存的媒体环境设置？")) return;
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
      error.value = "设置已在其他会话更新，请重新读取后再保存。";
      return;
    }
    if (response.status === 400) {
      error.value = "请填写有效的正整数。每项超时不超过 2147483647 毫秒。";
      return;
    }
    if (!response.ok) {
      error.value = mode === "load" ? "宿主未能读取媒体环境设置。" : "宿主未能保存媒体环境设置。";
      return;
    }
    const result = await response.json() as MediaEnvironmentSnapshot;
    if (active !== controller) return;
    if (typeof result?.revision !== "string" || !result.settings || !mediaEnvironmentGroups.every(group =>
      group.fields.every(({ key, max }) => Number.isSafeInteger(result.settings[key]) && result.settings[key] >= 1 && result.settings[key] <= max))) {
      error.value = "宿主返回了无法识别的媒体环境设置。";
      return;
    }
    saved.value = result;
    draft.value = { ...result.settings };
    if (mode === "save") feedback.value = "已保存，下次工具安装或 TuneWeave 请求时生效。";
  } catch {
    if (active === controller) error.value = "暂时无法连接宿主，请重试。";
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
      <h1 id="media-environment-title" tabindex="-1">媒体环境设置</h1>
      <ElButton :loading="busy === 'load'" :disabled="Boolean(busy)" @click="sync('load')">重新读取</ElButton>
    </div>
    <p v-if="error" class="error refresh-error" role="alert">{{ error }}</p>
    <form v-if="draft" class="media-environment-settings" @submit.prevent="sync('save')">
      <fieldset v-for="group in mediaEnvironmentGroups" :key="group.section" :disabled="Boolean(busy)">
        <legend>{{ group.label }}</legend>
        <template v-for="field in group.fields" :key="field.key">
          <label :for="`media-environment-${field.key}`">{{ field.label }}</label>
          <input :id="`media-environment-${field.key}`" v-model.number="draft[field.key]" type="number" min="1"
            :max="field.max" step="1" required />
        </template>
      </fieldset>
      <div class="media-environment-actions">
        <ElButton type="primary" native-type="submit" :loading="busy === 'save'" :disabled="!dirty || Boolean(busy)">保存</ElButton>
        <span v-if="feedback" role="status">{{ feedback }}</span>
      </div>
    </form>
  </section>
</template>

<style scoped>
.media-environment-settings { max-width: 660px; margin-top: 20px; padding: 16px; border: 1px solid var(--line); border-radius: 13px; background: var(--surface); }
fieldset { display: grid; gap: 7px; padding: 0; border: 0; margin: 0; min-width: 0; }
fieldset + fieldset { margin-top: 16px; }
legend { padding: 0; margin-bottom: 9px; font-weight: 650; }
fieldset input[type="number"] { border: 1px solid var(--line); padding: 8px; border-radius: 6px; color: inherit; background: var(--surface); }
.media-environment-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 9px; }
.media-environment-actions span { color: var(--accent); }
.media-environment-actions { margin-top: 14px; }
</style>
