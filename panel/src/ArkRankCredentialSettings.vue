<script setup lang="ts">
import { panelText } from './i18n.ts';

import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ElButton } from "element-plus";
import { panelFetch, type PanelAuth } from "./api";

type Snapshot = { readonly source: "environment" | "stored" | "none"; readonly usable: boolean };
const props = defineProps<{ auth: PanelAuth }>();
const emit = defineEmits<{ unauthorized: []; "dirty-change": [dirty: boolean] }>();
const snapshot = ref<Snapshot>();
const draft = ref("");
const busy = ref(false);
const confirming = ref(false);
const error = ref("");
const feedback = ref("");
const editable = computed(() => snapshot.value !== undefined && snapshot.value.source !== "environment");
let active: AbortController | undefined;

watch(draft, value => emit("dirty-change", value.length > 0));
const summary = computed(() => {
  switch (snapshot.value?.source) {
    case "environment": return snapshot.value.usable ? panelText('ArkRankCredentialSettings.df65cb2f67') : panelText('ArkRankCredentialSettings.3ac5f0865f');
    case "stored": return snapshot.value.usable ? panelText('ArkRankCredentialSettings.fc73469ff6') : panelText('ArkRankCredentialSettings.e431d38f2b');
    case "none": return panelText('ArkRankCredentialSettings.2d2f202139');
    default: return "";
  }
});

async function update(method: "GET" | "PUT" | "DELETE" = "GET") {
  if (busy.value || (method !== "GET" && !editable.value)) return;
  const request = new AbortController();
  const timer = setTimeout(() => request.abort(), 10_000);
  active = request;
  busy.value = true;
  feedback.value = error.value = "";
  try {
    const response = await panelFetch(`${import.meta.env.BASE_URL}api/settings/native/ark-rank-credentials`, props.auth, {
      method,
      headers: method === "PUT" ? { "Content-Type": "application/json" } : undefined,
      body: method === "PUT" ? JSON.stringify({ token: draft.value.trim() }) : undefined,
      signal: request.signal,
    });
    if (active !== request) return;
    if (response.status === 401) { emit("unauthorized"); return; }
    if (response.status === 400) { error.value = panelText('ArkRankCredentialSettings.0ca938655f'); return; }
    if (response.status === 409) { error.value = panelText('ArkRankCredentialSettings.9af952ba07'); return; }
    if (!response.ok) { error.value = panelText('ArkRankCredentialSettings.31de7f1f50'); return; }
    const result = await response.json() as Snapshot;
    if (active !== request) return;
    snapshot.value = result;
    if (method === "GET" && !editable.value) draft.value = "";
    if (method !== "GET") {
      draft.value = "";
      confirming.value = false;
      feedback.value = method === "PUT" ? panelText('ArkRankCredentialSettings.b7116b37ae') : panelText('ArkRankCredentialSettings.17db3d1e85');
    }
  } catch {
    if (active === request) error.value = panelText('ArkRankCredentialSettings.8743fc8668');
  } finally {
    clearTimeout(timer);
    if (active === request) {
      active = undefined;
      busy.value = false;
    }
  }
}

onMounted(() => void update());
onBeforeUnmount(() => {
  const request = active;
  active = undefined;
  request?.abort();
  draft.value = "";
  emit("dirty-change", false);
});
</script>

<template>
  <form class="rank-credential-form" aria-labelledby="rank-credential-title" :aria-busy="busy" @submit.prevent="update('PUT')">
    <h2 id="rank-credential-title">{{ panelText('ArkRankCredentialSettings.06e0c5b5ac') }}</h2>
    <p v-if="feedback || summary" role="status">{{ feedback || summary }}</p>
    <p v-if="snapshot?.source === 'environment'">{{ panelText('ArkRankCredentialSettings.4d84762ef8') }}</p>
    <div v-if="editable" class="rank-credential-field">
      <label for="rank-credential-token">{{ panelText('ArkRankCredentialSettings.2d9514a869') }}</label>
      <input id="rank-credential-token" v-model="draft" type="password" maxlength="2048" autocomplete="new-password"
        spellcheck="false" :disabled="busy || confirming">
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div v-if="confirming" class="rank-credential-actions" :aria-label="panelText('ArkRankCredentialSettings.a5da1dd8fd')">
      <span>{{ panelText('ArkRankCredentialSettings.8d9787bba6') }}</span>
      <ElButton type="danger" :disabled="busy" @click="update('DELETE')">{{ panelText('ArkRankCredentialSettings.a5da1dd8fd') }}</ElButton>
      <ElButton :disabled="busy" @click="confirming = false">{{ panelText('ArkRankCredentialSettings.2cd0f3be87') }}</ElButton>
    </div>
    <div v-else class="rank-credential-actions">
      <ElButton v-if="editable" type="primary" native-type="submit" :disabled="busy || !draft.trim()">{{ panelText('ArkRankCredentialSettings.943dcc9cbb') }}</ElButton>
      <ElButton v-if="editable && snapshot?.source === 'stored'" :disabled="busy" @click="confirming = true">{{ panelText('ArkRankCredentialSettings.9659d31a09') }}</ElButton>
      <ElButton :disabled="busy" @click="update()">{{ panelText('ArkRankCredentialSettings.df7392cc96') }}</ElButton>
    </div>
  </form>
</template>

<style scoped>
.rank-credential-form { display: grid; gap: 12px; margin-top: 20px; max-width: 760px; }
.rank-credential-form h2, .rank-credential-form p { margin: 0; }
.rank-credential-field { display: grid; gap: 6px; }
.rank-credential-field input {
  width: 100%;
  min-height: 34px;
  padding: 6px 9px;
  color: var(--el-text-color-primary);
  background: var(--el-fill-color-blank);
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
  font: inherit;
}
.rank-credential-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.rank-credential-actions :deep(.el-button + .el-button) { margin-left: 0; }
</style>
