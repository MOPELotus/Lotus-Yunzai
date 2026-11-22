<script setup lang="ts">
import { ElButton } from "element-plus";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { panelFetch, type PanelAuth } from "./api.ts";

interface Settings { enable: boolean; check_cron: string; challenge_cron: string; run_on_missing_data: boolean }
interface Snapshot { settings: Settings; revision: string }

const props = defineProps<{ auth: PanelAuth }>();
const emit = defineEmits<{ unauthorized: []; "dirty-change": [dirty: boolean] }>();
const endpoint = `${import.meta.env.BASE_URL}api/settings/atlas/update`;
const saved = ref<Snapshot>();
const draft = ref<Settings>({ enable: false, check_cron: "", challenge_cron: "", run_on_missing_data: true });
const busy = ref<"load" | "save">();
const error = ref("");
const feedback = ref("");
const dirty = computed(() => !!saved.value && JSON.stringify(saved.value.settings) !== JSON.stringify(draft.value));
let active: AbortController | undefined;

watch(dirty, value => emit("dirty-change", value));

async function sync(mode: "load" | "save") {
  if (active || (mode === "save" && !dirty.value)) return;
  if (mode === "load" && dirty.value && !window.confirm("放弃未保存的图鉴自动更新设置？")) return;
  const controller = new AbortController();
  active = controller;
  const timeout = setTimeout(() => controller.abort(), 10_000);
  busy.value = mode;
  error.value = feedback.value = "";
  try {
    const response = await panelFetch(endpoint, props.auth, {
      method: mode === "load" ? "GET" : "PUT",
      headers: mode === "save" ? { "Content-Type": "application/json" } : undefined,
      body: mode === "save" ? JSON.stringify({ settings: draft.value, revision: saved.value?.revision }) : undefined,
      signal: controller.signal,
    });
    if (active !== controller) return;
    if (response.status === 401) return emit("unauthorized");
    if (response.status === 409) {
      error.value = "设置已在其他会话更新，请重新读取后再保存。";
      return;
    }
    if (response.status === 400) {
      const { field } = await response.json().catch(() => ({})) as { field?: string };
      if (active !== controller) return;
      error.value = field === "check_cron" ? "版本检查的 Cron 表达式无效。" : field === "challenge_cron"
        ? "挑战刷新的 Cron 表达式无效。" : "请检查图鉴自动更新设置。";
      return;
    }
    if (!response.ok) {
      error.value = mode === "load" ? "宿主未能读取图鉴自动更新设置。" : "宿主未能保存图鉴自动更新设置。";
      return;
    }
    const result = await response.json() as Snapshot;
    if (active !== controller) return;
    if (typeof result?.revision !== "string" || typeof result?.settings?.enable !== "boolean" ||
        typeof result.settings.run_on_missing_data !== "boolean" ||
        typeof result.settings.check_cron !== "string" || typeof result.settings.challenge_cron !== "string") {
      error.value = "宿主返回了无法识别的图鉴自动更新设置。";
      return;
    }
    saved.value = result;
    draft.value = { ...result.settings };
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

onMounted(() => { void sync("load"); });
onBeforeUnmount(() => {
  active?.abort();
  active = undefined;
});
</script>

<template>
  <section class="atlas-update" aria-labelledby="atlas-update-title" :aria-busy="Boolean(busy)">
    <div class="update-heading">
      <h2 id="atlas-update-title">图鉴自动更新</h2>
      <ElButton :loading="busy === 'load'" :disabled="Boolean(busy)" @click="sync('load')">重新读取</ElButton>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <form v-if="saved" @submit.prevent="sync('save')">
      <fieldset :disabled="Boolean(busy)">
        <label class="update-toggle"><input v-model="draft.enable" type="checkbox" />启用图鉴定时更新</label>
        <label for="atlas-check-cron">版本检查 Cron</label>
        <input id="atlas-check-cron" v-model="draft.check_cron" type="text" maxlength="160" autocomplete="off"
          spellcheck="false" placeholder="0 0 */6 * * ? *" />
        <label for="atlas-challenge-cron">挑战刷新 Cron</label>
        <input id="atlas-challenge-cron" v-model="draft.challenge_cron" type="text" maxlength="160" autocomplete="off"
          spellcheck="false" placeholder="0 15 */2 * * ? *" />
        <label class="update-toggle">
          <input id="atlas-initialize-missing" v-model="draft.run_on_missing_data" type="checkbox"
            aria-describedby="atlas-initialize-missing-note" />受管数据为空时补齐
        </label>
        <p id="atlas-initialize-missing-note" class="subtitle toggle-note">
          选定版本渠道后，定时版本检查和主人普通更新均可补齐受管空目录。停用定时更新仍可手动执行。
        </p>
      </fieldset>
      <p class="subtitle">清空时间表可恢复默认频率。保存后重启宿主生效。</p>
      <div class="update-actions">
        <ElButton type="primary" native-type="submit" :loading="busy === 'save'" :disabled="!dirty || Boolean(busy)">保存自动更新</ElButton>
        <span v-if="feedback" role="status">{{ feedback }}</span>
      </div>
    </form>
  </section>
</template>

<style scoped>
.atlas-update { max-width: 660px; margin-top: 20px; padding: 16px; border: 1px solid var(--line); border-radius: 13px; background: var(--surface); }
.update-heading, .update-actions, .update-toggle { display: flex; align-items: center; flex-wrap: wrap; gap: 9px; }
.update-heading { justify-content: space-between; margin-bottom: 12px; }
.update-heading h2 { margin: 0; font-size: 17px; }
.update-actions span { color: var(--accent); }
fieldset { display: grid; gap: 7px; padding: 0; border: 0; margin: 0; min-width: 0; }
fieldset input[type="text"] { border: 1px solid var(--line); padding: 8px; border-radius: 6px; color: inherit; background: var(--surface); }
.update-toggle input { accent-color: var(--accent); }
.subtitle { margin: 12px 0; }
.toggle-note { margin: 0; }
</style>
