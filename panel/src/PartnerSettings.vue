<script setup lang="ts">
import { panelText } from './i18n.ts';

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
  if (mode === "load" && dirty.value && !window.confirm(panelText('PartnerSettings.308fe50f57'))) return;
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
      error.value = panelText('PartnerSettings.bbc6698bf1');
      return;
    }
    if (response.status === 400) {
      const { field } = await response.json().catch(() => ({})) as { field?: string };
      if (active !== controller) return;
      const messages: Readonly<Record<string, string>> = {
        schedule: panelText('PartnerSettings.a30f4150d9'),
        delay_ms_max: panelText('PartnerSettings.f4668f0ea3'),
        review_local: panelText('PartnerSettings.01626f5e50'),
        review_api_url: panelText('PartnerSettings.cae55b8fe4'),
        review_api_url_key: panelText('PartnerSettings.89845238ba'),
        review_api_key: panelText('PartnerSettings.a0615d30ac'),
        review_responses: panelText('PartnerSettings.5129e8d81f'),
      };
      error.value = (field && messages[field]) || panelText('PartnerSettings.61f31f5cf9');
      return;
    }
    if (!response.ok) {
      error.value = mode === "load" ? panelText('PartnerSettings.24a5787be9') : panelText('PartnerSettings.7fa9bf39ff');
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
      error.value = panelText('PartnerSettings.9e9a1d5ec5');
      return;
    }
    saved.value = result;
    draft.value = { ...result.settings };
    reviewMode.value = result.reviewMode;
    reviewModel.value = result.review.model;
    reviewUrl.value = reviewKey.value = "";
    resetReviewUrl.value = clearReviewKey.value = false;
    if (mode === "save") feedback.value = panelText('PartnerSettings.42b59a0c3b');
  } catch {
    if (active === controller) error.value = panelText('PartnerSettings.19818d1a03');
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
      <h1 id="partner-settings-title" tabindex="-1">{{ panelText('PartnerSettings.6d62da50a0') }}</h1>
      <ElButton :loading="busy === 'load'" :disabled="Boolean(busy)" @click="sync('load')">{{ panelText('PartnerSettings.df7392cc96') }}</ElButton>
    </div>
    <p v-if="error" class="error refresh-error" role="alert">{{ error }}</p>
    <form v-if="draft" class="partner-settings" @submit.prevent="sync('save')">
      <fieldset :disabled="Boolean(busy)">
        <legend>{{ panelText('PartnerSettings.44dc0ac37a') }}</legend>
        <label class="partner-toggle"><input id="partner-enable" v-model="draft.enable" type="checkbox"
          :disabled="saved?.reviewMode === 'disabled' && !draft.enable" />{{ panelText('PartnerSettings.fccc127a59') }}</label>
        <label for="partner-schedule">{{ panelText('PartnerSettings.1748e7a1a1') }}</label>
        <input id="partner-schedule" v-model="draft.schedule" type="text" :placeholder="partnerScheduleDefault"
          maxlength="160" spellcheck="false" autocomplete="off" />
        <label class="partner-toggle"><input id="partner-catch-up" v-model="draft.auto_catch_up" type="checkbox" />{{ panelText('PartnerSettings.c378904bc1') }}</label>
        <p class="subtitle">{{ panelText('PartnerSettings.1a67ad2146') }}</p>
        <label class="partner-toggle"><input id="partner-notify" v-model="draft.notify_master" type="checkbox" />{{ panelText('PartnerSettings.cdeabfb256') }}</label>
      </fieldset>
      <fieldset :disabled="Boolean(busy)">
        <legend>{{ panelText('PartnerSettings.0a915af02f') }}</legend>
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
        <p class="subtitle">{{ panelText('PartnerSettings.ffad6802af') }}</p>
      </fieldset>
      <fieldset :disabled="Boolean(busy)">
        <legend>{{ panelText('PartnerSettings.abe3447cb1') }}</legend>
        <label for="partner-review-mode">{{ panelText('PartnerSettings.112659beb7') }}</label>
        <select id="partner-review-mode" v-model="reviewMode" :disabled="saved?.reviewMode === 'disabled'">
          <option v-if="saved?.reviewMode === 'disabled' || saved?.reviewMode === 'unknown'" :value="saved.reviewMode" disabled>
            {{ partnerReviewModes[saved.reviewMode] }}
          </option>
          <option v-for="mode in partnerEditableReviewModes" :key="mode" :value="mode"
            :disabled="mode === 'codex' && saved?.review.customCodexCommand && saved.reviewMode !== 'codex'">{{ partnerReviewModes[mode] }}</option>
        </select>
        <p v-if="saved?.reviewMode === 'disabled'" class="subtitle">
          {{ panelText('PartnerSettings.d76f8fc911') }} <code>{{ panelText('PartnerSettings.04e1aebac7') }}</code> {{ panelText('PartnerSettings.274ed8e444') }}
        </p>
        <p v-else-if="reviewMode === 'codex' || saved?.review.customCodexCommand" class="subtitle">
          {{ panelText('PartnerSettings.644a7b3e59') }} <code>{{ panelText('PartnerSettings.04e1aebac7') }}</code> {{ panelText('PartnerSettings.a275ef6167') }}
        </p>
        <template v-if="reviewMode === 'responses' || reviewMode === 'codex'">
          <label for="partner-review-model">{{ panelText('PartnerSettings.cf8160c5a7') }}</label>
          <input id="partner-review-model" v-model="reviewModel" :placeholder="reviewMode === 'codex' ? panelText('PartnerSettings.d602f48e20') : panelText('PartnerSettings.6f66ef8029')"
            type="text" maxlength="256" spellcheck="false" autocomplete="off" />
        </template>
        <template v-if="reviewMode === 'responses'">
          <label for="partner-review-url">{{ panelText('PartnerSettings.50285b885b') }}</label>
          <input id="partner-review-url" v-model="reviewUrl" type="url" maxlength="2048" :disabled="resetReviewUrl"
            :placeholder="saved?.review.apiUrlConfigured ? panelText('PartnerSettings.c21d2ee034') : partnerResponsesDefaultUrl" spellcheck="false" autocomplete="off" />
          <p v-if="saved?.review.apiUrlConfigured && saved.review.apiOrigin" class="subtitle">{{ panelText('PartnerSettings.70f4913bc5', { value1: saved.review.apiOrigin }) }}</p>
          <label v-if="saved?.review.apiUrlConfigured" class="partner-toggle">
            <input v-model="resetReviewUrl" id="partner-review-reset-url" type="checkbox" />{{ panelText('PartnerSettings.ba5bc22edd') }}
          </label>
          <label for="partner-review-key">{{ panelText('PartnerSettings.20a5f41cd3') }}</label>
          <input id="partner-review-key" v-model="reviewKey" type="password" maxlength="4096" :disabled="clearReviewKey"
            :placeholder="saved?.review.apiKeyConfigured ? panelText('PartnerSettings.c21d2ee034') : panelText('PartnerSettings.90e94e28ac')" autocomplete="new-password" />
          <label v-if="saved?.review.apiKeyConfigured" class="partner-toggle">
            <input v-model="clearReviewKey" id="partner-review-clear-key" type="checkbox" />{{ panelText('PartnerSettings.7e6f1c6963') }}
          </label>
        </template>
        <label for="partner-comments">{{ panelText('PartnerSettings.4d74c7ff83') }}</label>
        <textarea id="partner-comments" v-model="commentsText" rows="4" maxlength="16000" />
        <p class="subtitle">{{ panelText('PartnerSettings.2fa6f6a5b1') }}</p>
        <template v-for="field in reviewNumbers" :key="field.key">
          <label :for="`partner-${field.key}`">{{ field.label }}</label>
          <input :id="`partner-${field.key}`" v-model.number="draft[field.key]" type="number" :min="field.min"
            :max="field.max" step="1" required />
        </template>
      </fieldset>
      <div class="partner-actions">
        <ElButton type="primary" native-type="submit" :loading="busy === 'save'" :disabled="!dirty || Boolean(busy)">{{ panelText('PartnerSettings.a3030bf8f1') }}</ElButton>
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
