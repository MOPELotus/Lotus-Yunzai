<script setup lang="ts">
import { ElButton } from "element-plus";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { partnerNumbers, partnerReviewModes, partnerScheduleDefault, type PartnerPanelSettings,
  type PartnerPanelSnapshot } from "../../lib/panel-partner-schema.ts";
import { panelFetch, type PanelAuth } from "./api.ts";

const props = defineProps<{ auth: PanelAuth }>();
const emit = defineEmits<{ unauthorized: []; "dirty-change": [dirty: boolean] }>();
const endpoint = `${import.meta.env.BASE_URL}api/settings/media/partner`;
const saved = ref<PartnerPanelSnapshot>();
const draft = ref<PartnerPanelSettings>();
const busy = ref<"load" | "save">();
const error = ref("");
const feedback = ref("");
const changes = computed(() => {
  if (!draft.value || !saved.value) return {};
  const before = saved.value.settings;
  return Object.fromEntries(Object.entries(draft.value).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(before[key as keyof PartnerPanelSettings])));
});
const dirty = computed(() => Object.keys(changes.value).length > 0);
const commentsText = computed({
  get: () => draft.value?.comments.join("\n") ?? "",
  set(value: string) { if (draft.value) draft.value.comments = value.split(/\r?\n/u); },
});
const loginNumbers = partnerNumbers.slice(0, 2);
const delayNumbers = partnerNumbers.slice(2, 4);
const reviewNumbers = partnerNumbers.slice(4);
let active: AbortController | undefined;

watch(dirty, value => emit("dirty-change", value));

async function sync(mode: "load" | "save") {
  if (active || (mode === "save" && !dirty.value)) return;
  if (mode === "load" && dirty.value && !window.confirm("放弃未保存的网易云合伙人设置？")) return;
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
      const { field } = await response.json().catch(() => ({})) as { field?: string };
      if (active !== controller) return;
      error.value = field === "schedule" ? "执行时间的 Cron 表达式无效。" : field === "delay_ms_max"
        ? "最大操作间隔应不小于最小间隔，填 0 可停用间隔。"
        : "请检查数值范围或评论长度。每条评论最多 500 字，最多 100 条。";
      return;
    }
    if (!response.ok) {
      error.value = mode === "load" ? "宿主未能读取网易云合伙人设置。" : "宿主未能保存网易云合伙人设置。";
      return;
    }
    const result = await response.json() as PartnerPanelSnapshot;
    if (active !== controller) return;
    if (typeof result?.revision !== "string" || typeof result?.settings?.enable !== "boolean" ||
        typeof result.settings.auto_catch_up !== "boolean" || typeof result.settings.notify_master !== "boolean" ||
        typeof result.settings.schedule !== "string" || !Object.hasOwn(partnerReviewModes, result.reviewMode) ||
        !Array.isArray(result.settings.comments) || !result.settings.comments.every(value => typeof value === "string") ||
        !partnerNumbers.every(({ key, min, max }) => Number.isSafeInteger(result.settings[key]) &&
          result.settings[key] >= min && result.settings[key] <= max)) {
      error.value = "宿主返回了无法识别的网易云合伙人设置。";
      return;
    }
    saved.value = result;
    draft.value = { ...result.settings };
    if (mode === "save") feedback.value = "已保存。执行时间和启动补跑设置在下次启动时采用。";
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
  <section aria-labelledby="partner-settings-title" :aria-busy="Boolean(busy)">
    <div class="section-heading">
      <h1 id="partner-settings-title" tabindex="-1">网易云合伙人设置</h1>
      <ElButton :loading="busy === 'load'" :disabled="Boolean(busy)" @click="sync('load')">重新读取</ElButton>
    </div>
    <p v-if="error" class="error refresh-error" role="alert">{{ error }}</p>
    <form v-if="draft" class="partner-settings" @submit.prevent="sync('save')">
      <fieldset :disabled="Boolean(busy)">
        <legend>自动任务</legend>
        <label class="partner-toggle"><input id="partner-enable" v-model="draft.enable" type="checkbox" />启用自动任务</label>
        <label for="partner-schedule">执行时间 Cron</label>
        <input id="partner-schedule" v-model="draft.schedule" type="text" :placeholder="partnerScheduleDefault"
          maxlength="160" spellcheck="false" autocomplete="off" />
        <label class="partner-toggle"><input id="partner-catch-up" v-model="draft.auto_catch_up" type="checkbox" />启动后补跑当天任务</label>
        <p class="subtitle">启动补跑只适用于每天固定时间的任务。执行时间和启动补跑随宿主启动配置，清空时间恢复默认。</p>
        <label class="partner-toggle"><input id="partner-notify" v-model="draft.notify_master" type="checkbox" />自动任务结束后私聊通知机器人主人</label>
      </fieldset>
      <fieldset :disabled="Boolean(busy)">
        <legend>扫码登录与任务间隔</legend>
        <template v-for="field in loginNumbers" :key="field.key">
          <label :for="`partner-${field.key}`">{{ field.label }}</label>
          <input :id="`partner-${field.key}`" v-model.number="draft[field.key]" type="number" :min="field.min"
            :max="field.max" step="1" required />
        </template>
        <template v-for="field in delayNumbers" :key="field.key">
          <label :for="`partner-${field.key}`">{{ field.label }}</label>
          <input :id="`partner-${field.key}`" v-model.number="draft[field.key]" type="number" :min="field.min"
            :max="field.max" step="1" required />
        </template>
        <p class="subtitle">最大间隔填 0 可停用操作间隔。</p>
      </fieldset>
      <fieldset :disabled="Boolean(busy)">
        <legend>乐评</legend>
        <p v-if="saved" class="subtitle">当前来源：{{ partnerReviewModes[saved.reviewMode] }}</p>
        <label for="partner-comments">固定评论库，每行一条</label>
        <textarea id="partner-comments" v-model="commentsText" rows="4" maxlength="16000" />
        <p class="subtitle">固定评论模式会用这组内容，留空恢复默认。</p>
        <template v-for="field in reviewNumbers" :key="field.key">
          <label :for="`partner-${field.key}`">{{ field.label }}</label>
          <input :id="`partner-${field.key}`" v-model.number="draft[field.key]" type="number" :min="field.min"
            :max="field.max" step="1" required />
        </template>
      </fieldset>
      <div class="partner-actions">
        <ElButton type="primary" native-type="submit" :loading="busy === 'save'" :disabled="!dirty || Boolean(busy)">保存</ElButton>
        <span v-if="feedback" role="status">{{ feedback }}</span>
      </div>
    </form>
  </section>
</template>

<style scoped>
.partner-settings { max-width: 660px; margin-top: 20px; padding: 16px; border: 1px solid var(--line); border-radius: 13px; background: var(--surface); }
fieldset { display: grid; gap: 7px; padding: 0; border: 0; margin: 0; min-width: 0; }
fieldset + fieldset { margin-top: 16px; }
legend { padding: 0; margin-bottom: 9px; font-weight: 650; }
fieldset input:not([type="checkbox"]), fieldset textarea { border: 1px solid var(--line); padding: 8px; border-radius: 6px; color: inherit; background: var(--surface); }
.partner-toggle, .partner-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 9px; }
.partner-toggle input { accent-color: var(--accent); }
.partner-actions span { color: var(--accent); }
.subtitle { margin: 0 0 5px; }
.partner-actions { margin-top: 14px; }
textarea { resize: vertical; font: inherit; }
</style>
