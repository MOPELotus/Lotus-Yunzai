<script setup lang="ts">
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
    case "environment": return snapshot.value.usable ? "已从环境变量配置。" : "环境变量中的 Token 格式无效。";
    case "stored": return snapshot.value.usable ? "已保存 Token。" : "已保存的 Token 格式无效，请替换或清除。";
    case "none": return "尚未设置 Token。";
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
    if (response.status === 400) { error.value = "请输入有效的 Token，最多 2048 个非空格 ASCII 字符。"; return; }
    if (response.status === 409) { error.value = "当前由部署环境变量控制。请重新读取设置。"; return; }
    if (!response.ok) { error.value = "无法访问排行榜凭据存储，请检查 Valkey 后重试。"; return; }
    const result = await response.json() as Snapshot;
    if (active !== request) return;
    snapshot.value = result;
    if (method === "GET" && !editable.value) draft.value = "";
    if (method !== "GET") {
      draft.value = "";
      confirming.value = false;
      feedback.value = method === "PUT" ? "Token 已保存。" : "Token 已清除。";
    }
  } catch {
    if (active === request) error.value = "暂时无法读取或修改排行榜凭据。";
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
    <h2 id="rank-credential-title">自定义排行榜高级凭据</h2>
    <p v-if="feedback || summary" role="status">{{ feedback || summary }}</p>
    <p v-if="snapshot?.source === 'environment'">请在部署环境变量 LOTUS_ARK_CUSTOM_RANK_TOKEN 中修改。</p>
    <div v-if="editable" class="rank-credential-field">
      <label for="rank-credential-token">替换 Token</label>
      <input id="rank-credential-token" v-model="draft" type="password" maxlength="2048" autocomplete="new-password"
        spellcheck="false" :disabled="busy || confirming">
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div v-if="confirming" class="rank-credential-actions" aria-label="确认清除">
      <span>清除后，高级排行查询将无法使用此 Token。</span>
      <ElButton type="danger" :disabled="busy" @click="update('DELETE')">确认清除</ElButton>
      <ElButton :disabled="busy" @click="confirming = false">取消</ElButton>
    </div>
    <div v-else class="rank-credential-actions">
      <ElButton v-if="editable" type="primary" native-type="submit" :disabled="busy || !draft.trim()">保存 Token</ElButton>
      <ElButton v-if="editable && snapshot?.source === 'stored'" :disabled="busy" @click="confirming = true">清除 Token</ElButton>
      <ElButton :disabled="busy" @click="update()">重新读取</ElButton>
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
