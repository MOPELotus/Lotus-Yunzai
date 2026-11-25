<script setup lang="ts">
import { panelText } from './i18n.ts';

import { ElButton } from "element-plus";
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { accountScopePolicies, type AccountScopePolicy } from "../../lib/account-scope-policy.ts";
import { panelFetch, type PanelAuth } from "./api.ts";

const props = defineProps<{ auth: PanelAuth }>();
const emit = defineEmits<{ unauthorized: []; "dirty-change": [dirty: boolean] }>();
const endpoint = `${import.meta.env.BASE_URL}api/settings/group/cleanup`;
const fields = [
  { key: "dry_run", label: panelText('GroupCleanupSettings.184c17621c') },
  { key: "remove_group_fallback", label: panelText('GroupCleanupSettings.47ed0d036e') },
] as const;
const policyLabels: Record<AccountScopePolicy, string> = {
  inherit: panelText('GroupCleanupSettings.a979ac4d37'), allow: panelText('GroupCleanupSettings.ce7ef28b67'), deny: panelText('GroupCleanupSettings.136de7a8c4'), master_only: panelText('GroupCleanupSettings.dc138aeaa5'),
};
type Settings = Record<typeof fields[number]["key"], boolean>;
interface Snapshot { settings: Settings; archiveRequested: boolean; scopePolicy: AccountScopePolicy; revision: string }
const saved = shallowRef<Snapshot>();
const draft = ref<Settings>();
const draftPolicy = ref<AccountScopePolicy>();
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
  return {
    ...Object.fromEntries(fields.filter(({ key }) => before[key] !== current[key]).map(({ key }) => [key, current[key]])),
    ...(draftPolicy.value !== saved.value?.scopePolicy && { scope_policy: draftPolicy.value }),
  };
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
      error.value = panelText('GroupCleanupSettings.2feb9ffcd0');
      return;
    }
    if (!response.ok) throw new Error();
    const result = await response.json() as Snapshot;
    if (active !== controller) return;
    if (typeof result?.revision !== "string" || typeof result.archiveRequested !== "boolean" ||
        !accountScopePolicies.includes(result.scopePolicy) || !result.settings ||
        !fields.every(({ key }) => typeof result.settings[key] === "boolean")) throw new Error();
    saved.value = result;
    draft.value = { ...result.settings };
    draftPolicy.value = result.scopePolicy;
    conflict.value = false;
    if (method === "PUT") notice.value = panelText('GroupCleanupSettings.be20c51482');
  } catch {
    if (active === controller) error.value = panelText('GroupCleanupSettings.78f8d28f41');
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
  draftPolicy.value = undefined;
  void request("GET");
}, { immediate: true });
onBeforeUnmount(() => { active?.abort(); active = undefined; });
</script>

<template>
  <section class="cleanup-settings" aria-labelledby="group-cleanup-title" :aria-busy="Boolean(busy)">
    <div class="cleanup-heading">
      <h2 id="group-cleanup-title">{{ panelText('GroupCleanupSettings.403263b84b') }}</h2>
      <ElButton :disabled="Boolean(busy) || reloadPrompt" :loading="busy === 'GET'"
        @click="dirty ? reloadPrompt = true : request('GET')">{{ panelText('GroupCleanupSettings.063c36ad54') }}</ElButton>
    </div>
    <div v-if="reloadPrompt" class="feedback" role="alert">
      <p>{{ panelText('GroupCleanupSettings.6da69f3b9f') }}</p>
      <div class="action-group">
        <ElButton @click="reloadPrompt = false">{{ panelText('GroupCleanupSettings.fd4b9e3b6c') }}</ElButton>
        <ElButton type="danger" @click="request('GET')">{{ panelText('GroupCleanupSettings.a5831537bd') }}</ElButton>
      </div>
    </div>
    <p v-if="error" class="error refresh-error" role="alert">{{ error }}</p>
    <form v-if="draft" @submit.prevent="request('PUT')">
      <fieldset class="settings-card" aria-labelledby="group-cleanup-title" :disabled="Boolean(busy) || reloadPrompt">
        <p class="subtitle">{{ panelText('GroupCleanupSettings.1e9f2561b7') }} <code>{{ panelText('GroupCleanupSettings.4c7190f2a3') }}</code> {{ panelText('GroupCleanupSettings.da43880785') }}</p>
        <p v-if="saved?.archiveRequested" class="subtitle">{{ panelText('GroupCleanupSettings.098353b525') }}</p>
        <p v-else class="subtitle">{{ panelText('GroupCleanupSettings.89ec461bad') }}</p>
        <label class="cleanup-option cleanup-policy" for="group-cleanup-scope-policy">
          <span>{{ panelText('GroupCleanupSettings.3fa0315617') }}</span>
          <select id="group-cleanup-scope-policy" v-model="draftPolicy" aria-describedby="group-cleanup-policy-note">
            <option v-for="mode in accountScopePolicies" :key="mode" :value="mode">{{ policyLabels[mode] }}</option>
          </select>
        </label>
        <p id="group-cleanup-policy-note" class="subtitle">
          {{ panelText('GroupCleanupSettings.ca45a4ce12') }}
        </p>
        <label v-for="{ key, label } in fields" :key="key" class="cleanup-option">
          <span>{{ label }}</span>
          <input :id="`group-cleanup-${key}`" v-model="draft[key]" type="checkbox" />
        </label>
      </fieldset>
      <div class="feedback save-bar">
        <p v-if="notice" role="status">{{ notice }}</p>
        <ElButton type="primary" native-type="submit" :loading="busy === 'PUT'"
          :disabled="!dirty || conflict || Boolean(busy) || reloadPrompt">{{ panelText('GroupCleanupSettings.95de16c95f') }}</ElButton>
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
.cleanup-policy { flex-wrap: wrap; }
.cleanup-policy select {
  min-height: 36px; padding: 0 9px; border: 1px solid var(--el-border-color);
  border-radius: 4px; background: var(--surface); color: inherit; font: inherit; font-weight: 400;
}
</style>
