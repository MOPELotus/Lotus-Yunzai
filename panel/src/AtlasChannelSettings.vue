<script setup lang="ts">
import { ElButton } from "element-plus";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

type Channel = "live" | "latest";

const options = [
  { value: "live", label: "正式版", description: "随游戏正式发布的资料更新。" },
  { value: "latest", label: "网站最新版", description: "随资料网站当前提供的版本更新。" },
] as const satisfies ReadonlyArray<{ value: Channel; label: string; description: string }>;

const props = defineProps<{ token: string }>();
const emit = defineEmits<{ unauthorized: []; "dirty-change": [dirty: boolean] }>();
const endpoint = `${import.meta.env.BASE_URL}api/settings/atlas/channel`;
const saved = ref<Channel | null>();
const draft = ref<Channel | null>(null);
const busy = ref<"load" | "save">();
const feedback = ref("");
const error = ref("");
const dirty = computed(() => saved.value !== undefined && draft.value !== saved.value);
const savedLabel = computed(() => options.find(({ value }) => value === saved.value)?.label ?? "尚未选择");
let active: AbortController | undefined;

watch(dirty, (value) => emit("dirty-change", value));

async function synchronize(mode: "load" | "save") {
  if (active || (mode === "save" && (!dirty.value || !draft.value))) return;
  const controller = new AbortController();
  active = controller;
  const timeout = setTimeout(() => controller.abort(), 10_000);
  busy.value = mode;
  error.value = "";
  feedback.value = "";
  try {
    const response = await fetch(endpoint, {
      method: mode === "save" ? "PUT" : "GET",
      headers: { Authorization: `Bearer ${props.token}`, ...(mode === "save" && { "Content-Type": "application/json" }) },
      body: mode === "save" ? JSON.stringify({ previous: saved.value, channel: draft.value }) : undefined,
      signal: controller.signal,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
    if (active !== controller) return;
    if (response.status === 401) return emit("unauthorized");
    if (response.status === 409) {
      error.value = "选择已在其他会话更新，请重新读取后再保存。";
      return;
    }
    if (!response.ok) {
      error.value = mode === "save" ? "宿主未能保存图鉴版本来源。" : "宿主未能读取图鉴版本来源。";
      return;
    }
    const result = await response.json() as { channel?: unknown } | null;
    if (active !== controller) return;
    const channel = result?.channel;
    if (channel !== null && channel !== "live" && channel !== "latest") {
      error.value = "宿主返回了无法识别的图鉴版本来源。";
      return;
    }
    saved.value = draft.value = channel;
    if (mode === "save") feedback.value = "已保存，重启宿主后生效。";
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
        <h1 id="atlas-channel-title" tabindex="-1">图鉴设置</h1>
        <p class="subtitle" v-if="saved !== undefined">已保存的版本来源：{{ savedLabel }}</p>
      </div>
      <ElButton :loading="busy === 'load'" :disabled="Boolean(busy)" @click="synchronize('load')">重新读取</ElButton>
    </div>
    <p v-if="error" class="error refresh-error" role="alert">{{ error }}</p>

    <form v-if="saved !== undefined" class="atlas-settings" @submit.prevent="synchronize('save')">
      <fieldset :disabled="Boolean(busy)">
        <legend>图鉴版本来源</legend>
        <label v-for="option in options" :key="option.value" class="atlas-option"
          :class="{ 'atlas-option-selected': draft === option.value }">
          <input v-model="draft" type="radio" name="atlas-channel" :value="option.value" />
          <span>
            <strong>{{ option.label }}</strong>
            <small>{{ option.description }}</small>
          </span>
        </label>
      </fieldset>
      <p class="atlas-note">重启宿主后，图鉴自动更新会沿用保存的版本来源。</p>
      <div class="atlas-actions">
        <ElButton type="primary" native-type="submit" :loading="busy === 'save'" :disabled="!dirty || Boolean(busy)">
          保存
        </ElButton>
        <span v-if="feedback" role="status">{{ feedback }}</span>
      </div>
    </form>
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
