<script setup lang="ts">
import { ElButton } from "element-plus";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { partnerEditableReviewModes, partnerNumbers, partnerResponsesDefaultUrl, partnerReviewModes, partnerScheduleDefault, type PartnerPanelSettings,
  type PartnerPanelSnapshot } from "../../lib/panel-partner-schema.ts";
import { panelFetch, type PanelAuth } from "./api.ts";

const props = defineProps<{ auth: PanelAuth }>();
const emit = defineEmits<{ unauthorized: []; "dirty-change": [dirty: boolean] }>();
const endpoint = `${import.meta.env.BASE_URL}api/settings/media/partner`;
const saved = ref<PartnerPanelSnapshot>();
const draft = ref<PartnerPanelSettings>();
const reviewMode = ref<PartnerPanelSnapshot["reviewMode"]>();
const reviewModel = ref("");
const reviewUrl = ref("");
const reviewKey = ref("");
const resetReviewUrl = ref(false);
const clearReviewKey = ref(false);
const busy = ref<"load" | "save">();
const error = ref("");
const feedback = ref("");
const changes = computed(() => {
  if (!draft.value || !saved.value) return {};
  const before = saved.value.settings;
  const settings = Object.fromEntries(Object.entries(draft.value)
    .filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(before[key as keyof PartnerPanelSettings])));
  return {
    ...settings,
    ...(reviewMode.value !== saved.value.reviewMode ? { review_mode: reviewMode.value } : {}),
    ...(reviewModel.value !== saved.value.review.model ? { review_model: reviewModel.value } : {}),
    ...(resetReviewUrl.value || reviewUrl.value.trim() ? { review_api_url: resetReviewUrl.value ? "" : reviewUrl.value } : {}),
    ...(clearReviewKey.value ? { review_clear_api_key: true } : reviewKey.value.trim() ? { review_api_key: reviewKey.value } : {}),
  };
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
      const messages: Readonly<Record<string, string>> = {
        schedule: "执行时间的 Cron 表达式无效。",
        delay_ms_max: "最大操作间隔应不小于最小间隔，填 0 可停用间隔。",
        review_local: "请先在本机 config/global.yaml 确认乐评来源和 Codex 程序。",
        review_api_url: "请填写完整的 HTTPS Responses 接口。仅本机回环地址允许 HTTP。地址不应含凭据、查询参数或片段。",
        review_api_url_key: "更改 Responses 接口时，请同时填写该接口的密钥或明确清除旧密钥。",
        review_api_key: "Responses 密钥格式无效。填写新密钥和清除原密钥只能选择一项。",
        review_responses: "启用 Responses 前，请填写模型与密钥，并确认接口地址有效。",
      };
      error.value = (field && messages[field]) || "请检查数值范围或评论长度。每条评论最多 500 字，最多 100 条。";
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
        typeof result.review?.model !== "string" || typeof result.review.apiOrigin !== "string" ||
        typeof result.review.apiUrlConfigured !== "boolean" || typeof result.review.apiKeyConfigured !== "boolean" ||
        typeof result.review.customCodexCommand !== "boolean" ||
        !Array.isArray(result.settings.comments) || !result.settings.comments.every(value => typeof value === "string") ||
        !partnerNumbers.every(({ key, min, max }) => Number.isSafeInteger(result.settings[key]) &&
          result.settings[key] >= min && result.settings[key] <= max)) {
      error.value = "宿主返回了无法识别的网易云合伙人设置。";
      return;
    }
    saved.value = result;
    draft.value = { ...result.settings };
    reviewMode.value = result.reviewMode;
    reviewModel.value = result.review.model;
    reviewUrl.value = reviewKey.value = "";
    resetReviewUrl.value = clearReviewKey.value = false;
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
        <label class="partner-toggle"><input id="partner-enable" v-model="draft.enable" type="checkbox"
          :disabled="saved?.reviewMode === 'disabled' && !draft.enable" />启用自动任务</label>
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
        <label for="partner-review-mode">乐评来源</label>
        <select id="partner-review-mode" v-model="reviewMode" :disabled="saved?.reviewMode === 'disabled'">
          <option v-if="saved?.reviewMode === 'disabled' || saved?.reviewMode === 'unknown'" :value="saved.reviewMode" disabled>
            {{ partnerReviewModes[saved.reviewMode] }}
          </option>
          <option v-for="mode in partnerEditableReviewModes" :key="mode" :value="mode"
            :disabled="mode === 'codex' && saved?.review.customCodexCommand && saved.reviewMode !== 'codex'">{{ partnerReviewModes[mode] }}</option>
        </select>
        <p v-if="saved?.reviewMode === 'disabled'" class="subtitle">
          迁移的外部乐评配置需要在本机 <code>config/global.yaml</code> 确认。确认后重新读取。
        </p>
        <p v-else-if="reviewMode === 'codex' || saved?.review.customCodexCommand" class="subtitle">
          Codex 程序和本机登录由部署者配置。自定义程序请在本机 <code>config/global.yaml</code> 选择。
        </p>
        <template v-if="reviewMode === 'responses' || reviewMode === 'codex'">
          <label for="partner-review-model">乐评模型</label>
          <input id="partner-review-model" v-model="reviewModel" :placeholder="reviewMode === 'codex' ? '沿用本机 Codex 默认模型' : '填写服务支持的模型'"
            type="text" maxlength="256" spellcheck="false" autocomplete="off" />
        </template>
        <template v-if="reviewMode === 'responses'">
          <label for="partner-review-url">Responses API 地址</label>
          <input id="partner-review-url" v-model="reviewUrl" type="url" maxlength="2048" :disabled="resetReviewUrl"
            :placeholder="saved?.review.apiUrlConfigured ? '已配置，留空保持' : partnerResponsesDefaultUrl" spellcheck="false" autocomplete="off" />
          <p v-if="saved?.review.apiUrlConfigured && saved.review.apiOrigin" class="subtitle">当前服务 {{ saved.review.apiOrigin }}</p>
          <label v-if="saved?.review.apiUrlConfigured" class="partner-toggle">
            <input v-model="resetReviewUrl" id="partner-review-reset-url" type="checkbox" />恢复默认接口
          </label>
          <label for="partner-review-key">Responses API 密钥</label>
          <input id="partner-review-key" v-model="reviewKey" type="password" maxlength="4096" :disabled="clearReviewKey"
            :placeholder="saved?.review.apiKeyConfigured ? '已配置，留空保持' : '输入密钥'" autocomplete="new-password" />
          <label v-if="saved?.review.apiKeyConfigured" class="partner-toggle">
            <input v-model="clearReviewKey" id="partner-review-clear-key" type="checkbox" />清除已保存的密钥
          </label>
        </template>
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
fieldset input:not([type="checkbox"]), fieldset textarea, fieldset select { border: 1px solid var(--line); padding: 8px; border-radius: 6px; color: inherit; background: var(--surface); }
.partner-toggle, .partner-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 9px; }
.partner-toggle input { accent-color: var(--accent); }
.partner-actions span { color: var(--accent); }
.subtitle { margin: 0 0 5px; }
.partner-actions { margin-top: 14px; }
textarea { resize: vertical; font: inherit; }
</style>
