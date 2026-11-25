<script setup lang="ts">
import { panelText } from './i18n.ts';

import { ElButton } from "element-plus";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { globalPermissionLists, globalPermissionPolicies, isPermissionId, sortPermissionIds,
  type GlobalPermissionList, type GlobalPermissionPolicy, type GlobalPermissionSettings, type GlobalPermissionSnapshot } from "../../lib/global-permission-policy.ts";
import { panelFetch, type PanelAuth } from "./api.ts";
import AccountPermissionsSettings from "./AccountPermissionsSettings.vue";

const props = defineProps<{ auth: PanelAuth }>();
const emit = defineEmits<{ unauthorized: []; "dirty-change": [dirty: boolean] }>();
const endpoint = `${import.meta.env.BASE_URL}api/settings/global/permissions`;
const labels: Record<GlobalPermissionList, string> = {
  "users.allow": panelText('GlobalPermissionsSettings.f43124318f'),
  "users.deny": panelText('GlobalPermissionsSettings.995cb11705'),
  "groups.allow": panelText('GlobalPermissionsSettings.cb8426d6e9'),
  "groups.deny": panelText('GlobalPermissionsSettings.4a7a31a535'),
};
const groups = [
  { title: panelText('GlobalPermissionsSettings.369b90961c'), fields: ["users.allow", "users.deny"] as const },
  { title: panelText('GlobalPermissionsSettings.34df589170'), fields: ["groups.allow", "groups.deny"] as const },
];
const saved = shallowRef<GlobalPermissionSnapshot>();
const policy = ref<GlobalPermissionPolicy>("allow");
const draft = ref<Record<GlobalPermissionList, string>>({
  "users.allow": "", "users.deny": "", "groups.allow": "", "groups.deny": "",
});
const busy = ref<"GET" | "PUT">();
const error = ref("");
const notice = ref("");
const conflict = ref(false);
const confirmReload = ref(false);
const groupExportDirty = ref(false);
let active: AbortController | undefined;

const parsed = computed(() => Object.fromEntries(globalPermissionLists.map(field => {
  const inputs = draft.value[field].split(/[\s,，]+/u).filter(Boolean);
  return [field, inputs.every(isPermissionId) ?
    sortPermissionIds([...inputs, ...(saved.value?.locked[field] ?? [])]) : undefined];
})) as Record<GlobalPermissionList, readonly string[] | undefined>);
const invalid = computed(() => globalPermissionLists.some(field => parsed.value[field] === undefined));
const changed = computed(() => {
  const before = saved.value;
  if (!before) return {};
  return Object.fromEntries([
    ...(before.settings.default_policy !== policy.value ? [["default_policy", policy.value]] : []),
    ...globalPermissionLists.flatMap(field => {
      const next = parsed.value[field];
      return next && JSON.stringify(next) !== JSON.stringify(before.settings[field]) ? [[field, next]] : [];
    }),
  ]) as Partial<GlobalPermissionSettings>;
});
const dirty = computed(() => !!saved.value && (invalid.value || Object.keys(changed.value).length > 0));
watch(dirty, value => {
  if (!value) confirmReload.value = false;
});
watch(() => dirty.value || groupExportDirty.value, value => emit("dirty-change", value));

function isSnapshot(input: unknown): input is GlobalPermissionSnapshot {
  if (!input || typeof input !== "object") return false;
  const data = input as Partial<GlobalPermissionSnapshot>;
  const { revision, settings, locked, retained } = data;
  return typeof revision === "string" && /^[a-f0-9]{64}$/u.test(revision) && !!settings && !!locked && !!retained &&
    globalPermissionPolicies.some(policy => policy === settings.default_policy) &&
    globalPermissionLists.every(field => Array.isArray(settings[field]) && settings[field].every(isPermissionId) &&
      (locked[field] === undefined || Array.isArray(locked[field]) && locked[field].every(isPermissionId)) &&
      (retained[field] === undefined || Number.isSafeInteger(retained[field]) && retained[field] > 0));
}

async function request(method: "GET" | "PUT") {
  if (active || (method === "PUT" && (!saved.value || !dirty.value || invalid.value || conflict.value || confirmReload.value))) return;
  const controller = new AbortController();
  active = controller;
  busy.value = method;
  error.value = "";
  notice.value = "";
  confirmReload.value = false;
  try {
    const body = method === "PUT" ? JSON.stringify({ revision: saved.value!.revision, patch: changed.value }) : undefined;
    const response = await panelFetch(endpoint, props.auth, {
      method, body, headers: body ? { "Content-Type": "application/json" } : undefined,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
    });
    if (active !== controller) return;
    if (response.status === 401) return emit("unauthorized");
    if (response.status === 409) {
      conflict.value = true;
      error.value = panelText('GlobalPermissionsSettings.84544813c5');
      return;
    }
    if (response.status === 422) {
      error.value = panelText('GlobalPermissionsSettings.48c32a8b02');
      return;
    }
    if (!response.ok) throw new Error();
    const result: unknown = await response.json();
    if (active !== controller) return;
    if (!isSnapshot(result)) throw new Error();
    saved.value = result;
    policy.value = result.settings.default_policy;
    draft.value = Object.fromEntries(globalPermissionLists.map(field =>
      [field, result.settings[field].filter(id => !result.locked[field]?.includes(id)).join("\n")],
    )) as Record<GlobalPermissionList, string>;
    conflict.value = false;
    if (method === "PUT") notice.value = panelText('GlobalPermissionsSettings.390274a25b');
  } catch {
    if (active === controller) error.value = panelText('GlobalPermissionsSettings.4641e717e6');
  } finally {
    if (active === controller) {
      active = undefined;
      busy.value = undefined;
    }
  }
}

function reload() {
  if (dirty.value) confirmReload.value = true;
  else void request("GET");
}

onMounted(() => { void request("GET"); });
onBeforeUnmount(() => {
  active?.abort();
  active = undefined;
  emit("dirty-change", false);
});
</script>

<template>
  <section aria-labelledby="global-permissions-title" :aria-busy="Boolean(busy)">
    <div class="section-heading">
      <h1 id="global-permissions-title" tabindex="-1">{{ panelText('GlobalPermissionsSettings.3b3f45b021') }}</h1>
      <ElButton :loading="busy === 'GET'" :disabled="Boolean(busy) || confirmReload" @click="reload">{{ panelText('GlobalPermissionsSettings.df7392cc96') }}</ElButton>
    </div>
    <div v-if="confirmReload" class="permission-actions" role="alert">
      <span>{{ panelText('GlobalPermissionsSettings.e71b339a4e') }}</span>
      <ElButton @click="confirmReload = false">{{ panelText('GlobalPermissionsSettings.fd4b9e3b6c') }}</ElButton>
      <ElButton type="danger" @click="request('GET')">{{ panelText('GlobalPermissionsSettings.a5831537bd') }}</ElButton>
    </div>
    <p v-if="error" class="error refresh-error" role="alert">{{ error }}</p>
    <form v-if="saved" class="permission-settings" @submit.prevent="request('PUT')">
      <fieldset :disabled="Boolean(busy) || confirmReload">
        <legend>{{ panelText('GlobalPermissionsSettings.d2b2ec2237') }}</legend>
        <label for="global-permission-default">{{ panelText('GlobalPermissionsSettings.8088cc83b2') }}</label>
        <select id="global-permission-default" v-model="policy">
          <option value="allow">{{ panelText('GlobalPermissionsSettings.ce7ef28b67') }}</option>
          <option value="deny">{{ panelText('GlobalPermissionsSettings.136de7a8c4') }}</option>
        </select>
        <p>{{ panelText('GlobalPermissionsSettings.e2908ba393') }}</p>
      </fieldset>
      <div class="permission-lists">
        <fieldset v-for="group in groups" :key="group.title" :disabled="Boolean(busy) || confirmReload">
          <legend>{{ group.title }}</legend>
          <div v-for="field in group.fields" :key="field" class="permission-list">
            <label :for="`global-permission-${field}`">{{ labels[field] }}</label>
            <textarea :id="`global-permission-${field}`" v-model="draft[field]" rows="3" :placeholder="panelText('GlobalPermissionsSettings.a4f1db3ef0')"
              :aria-invalid="parsed[field] === undefined" spellcheck="false" />
            <p v-if="parsed[field] === undefined" class="error" role="alert">{{ panelText('GlobalPermissionsSettings.61b7eaeaa2') }}</p>
            <p v-if="saved.locked[field]?.length">{{ panelText('GlobalPermissionsSettings.bfafce0000', { value1: saved.locked[field]?.join("、") }) }}</p>
            <p v-if="saved.retained[field]">{{ panelText('GlobalPermissionsSettings.da71fd4170', { value1: saved.retained[field] }) }}</p>
          </div>
        </fieldset>
      </div>
      <p>{{ panelText('GlobalPermissionsSettings.10f3e1bbb0') }}</p>
      <div class="permission-actions">
        <ElButton type="primary" native-type="submit" :loading="busy === 'PUT'"
          :disabled="!dirty || invalid || Boolean(busy) || confirmReload || conflict">{{ panelText('GlobalPermissionsSettings.a3030bf8f1') }}</ElButton>
        <span v-if="notice" role="status">{{ notice }}</span>
      </div>
    </form>
    <AccountPermissionsSettings class="group-export-settings" :auth="auth" section="group-export"
      @unauthorized="emit('unauthorized')" @dirty-change="groupExportDirty = $event" />
  </section>
</template>

<style scoped>
.permission-settings, .permission-list { display: grid; gap: 8px; }
.permission-settings { max-width: 800px; margin-top: 20px; gap: 14px; }
.group-export-settings { margin-top: 26px; }
.permission-lists { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.permission-settings fieldset {
  display: grid; align-content: start; gap: 10px; min-width: 0; margin: 0; padding: 14px;
  border: 1px solid var(--line); border-radius: 12px; background: var(--surface);
}
.permission-settings label, .permission-settings legend { font-size: 14px; font-weight: 650; }
.permission-settings legend { padding: 0 4px; }
.permission-settings select, .permission-settings textarea {
  width: 100%; min-width: 0; padding: 8px 9px; border: 1px solid var(--el-border-color);
  border-radius: 4px; background: var(--surface); color: inherit; font: inherit;
}
.permission-settings textarea { resize: vertical; }
.permission-settings p, .permission-actions span {
  margin: 0; color: var(--muted); font-size: 14px; overflow-wrap: anywhere;
}
.permission-settings .error { color: var(--el-color-danger); }
.permission-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.permission-actions :deep(.el-button + .el-button) { margin-left: 0; }
@media (max-width: 620px) { .permission-lists { grid-template-columns: minmax(0, 1fr); } }
</style>
