<script setup lang="ts">
import { ElButton } from "element-plus";
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { panelFetch, type PanelAuth } from "./api.ts";

const props = defineProps<{ auth: PanelAuth }>();
const emit = defineEmits<{ unauthorized: []; "dirty-change": [dirty: boolean] }>();
const endpoint = `${import.meta.env.BASE_URL}api/settings/group/cleanup`;
const fields = [
  { key: "dry_run", label: "仅预览清理" },
  { key: "remove_group_fallback", label: "移除当前群的通知回退" },
] as const;
type Settings = Record<typeof fields[number]["key"], boolean>;
interface Snapshot { settings: Settings; archiveRequested: boolean; revision: string }
const saved = shallowRef<Snapshot>();
const draft = ref<Settings>();
const busy = ref<"GET" | "PUT">();
const error = ref("");
const notice = ref("");
const reloadPrompt = ref(false);
const conflict = ref(false);
let active: AbortController | undefined;

const patch = computed(() => {
  const before = saved.value?.settings;
  const current = draft.value;
  if (!before || !current) return {};
  return Object.fromEntries(fields.filter(({ key }) => before[key] !== current[key]).map(({ key }) => [key, current[key]]));
});
const dirty = computed(() => Object.keys(patch.value).length > 0);
watch(dirty, value => emit("dirty-change", value));

async function request(method: "GET" | "PUT") {
  if (active || (method === "PUT" && (!dirty.value || conflict.value || reloadPrompt.value))) return;
  const controller = new AbortController();
  active = controller;
  busy.value = method;
  error.value = notice.value = "";
  reloadPrompt.value = false;
  try {
    const body = method === "PUT" ? JSON.stringify({ revision: saved.value?.revision, patch: patch.value }) : undefined;
    const response = await panelFetch(endpoint, props.auth, { method, body,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
    });
    if (active !== controller) return;
    if (response.status === 401) return emit("unauthorized");
    if (response.status === 409) {
      conflict.value = true;
      error.value = "清理配置已在别处修改。请重新读取后再保存。";
      return;
    }
    if (!response.ok) throw new Error();
    const result = await response.json() as Snapshot;
    if (active !== controller) return;
    if (typeof result?.revision !== "string" || typeof result.archiveRequested !== "boolean" || !result.settings ||
        !fields.every(({ key }) => typeof result.settings[key] === "boolean")) throw new Error();
    saved.value = result;
    draft.value = { ...result.settings };
    conflict.value = false;
    if (method === "PUT") notice.value = "已保存，下次手动清理时读取。";
  } catch {
    if (active === controller) error.value = "暂时无法读取或保存退群档案清理设置。";
  } finally {
    if (active === controller) {
      active = undefined;
      busy.value = undefined;
    }
  }
}

watch(() => props.auth, () => {
  active?.abort();
  active = undefined;
  saved.value = draft.value = undefined;
  void request("GET");
}, { immediate: true });
onBeforeUnmount(() => { active?.abort(); active = undefined; });
</script>

<template>
  <section class="cleanup-settings" aria-labelledby="group-cleanup-title" :aria-busy="Boolean(busy)">
    <div class="cleanup-heading">
      <h2 id="group-cleanup-title">退群档案清理</h2>
      <ElButton :disabled="Boolean(busy) || reloadPrompt" :loading="busy === 'GET'"
        @click="dirty ? reloadPrompt = true : request('GET')">重新读取清理设置</ElButton>
    </div>
    <div v-if="reloadPrompt" class="feedback" role="alert">
      <p>重新读取会放弃未保存的清理设置。</p>
      <div class="action-group">
        <ElButton @click="reloadPrompt = false">继续编辑</ElButton>
        <ElButton type="danger" @click="request('GET')">放弃改动并读取</ElButton>
      </div>
    </div>
    <p v-if="error" class="error refresh-error" role="alert">{{ error }}</p>
    <form v-if="draft" @submit.prevent="request('PUT')">
      <fieldset class="settings-card" aria-labelledby="group-cleanup-title" :disabled="Boolean(busy) || reloadPrompt">
        <p class="subtitle">通过 <code>#群清理退群</code> 手动执行。即使关闭预览，也须在当前群确认目标已离群后才会移除该群的通知回退。</p>
        <p v-if="saved?.archiveRequested" class="subtitle">旧配置已请求归档。当前只会生成预览，同时保留通知回退。</p>
        <p v-else class="subtitle">档案归档仅提供预览。</p>
        <label v-for="{ key, label } in fields" :key="key" class="cleanup-option">
          <span>{{ label }}</span>
          <input :id="`group-cleanup-${key}`" v-model="draft[key]" type="checkbox" />
        </label>
      </fieldset>
      <div class="feedback save-bar">
        <p v-if="notice" role="status">{{ notice }}</p>
        <ElButton type="primary" native-type="submit" :loading="busy === 'PUT'"
          :disabled="!dirty || conflict || Boolean(busy) || reloadPrompt">保存清理设置</ElButton>
      </div>
    </form>
  </section>
</template>

<style scoped>
.cleanup-settings { margin-top: 26px; }
.cleanup-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
.subtitle { margin-bottom: 12px; }
.cleanup-option { display: flex; align-items: center; justify-content: space-between; gap: 14px; min-height: 44px;
  padding: 10px 0; border-top: 1px solid var(--line); font-size: 15px; font-weight: 600; }
.cleanup-option:last-child { padding-bottom: 0; }
.cleanup-option input { flex: 0 0 18px; width: 18px; height: 18px; margin: 0; accent-color: var(--accent); }
.cleanup-option input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
