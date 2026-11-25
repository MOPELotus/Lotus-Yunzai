<script setup lang="ts">
import { panelText } from './i18n.ts';

import { ElButton } from "element-plus";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { accountScopePolicies, accountScopes, groupExportScopes, mediaDownloadScopes, mediaOwnerScopePolicies, mediaOwnerScopes, mediaPreviewScopes,
  type AccountScope, type AccountScopePolicy, type GroupExportScope, type MediaDownloadScope, type MediaOwnerScope, type MediaPreviewScope,
  type ScopePolicySnapshot } from "../../lib/account-scope-policy.ts";
import { panelFetch, type PanelAuth } from "./api.ts";

const props = defineProps<{ auth: PanelAuth; section?: "media-download" | "media-preview" | "media-owner" | "group-export" }>();
const emit = defineEmits<{ unauthorized: []; "dirty-change": [dirty: boolean] }>();
type Scope = AccountScope | MediaDownloadScope | MediaPreviewScope | MediaOwnerScope | GroupExportScope;
type Snapshot = ScopePolicySnapshot<Scope>;
const sections = {
  account: { title: panelText('AccountPermissionsSettings.cd4bf18b7e'), id: "account-permissions", path: "checkin/permissions", scopes: accountScopes },
  "media-download": { title: panelText('AccountPermissionsSettings.09b88616b3'), id: "media-download-permissions", path: "media/download-permissions", scopes: mediaDownloadScopes },
  "media-preview": { title: panelText('AccountPermissionsSettings.75f47bf371'), id: "media-preview-permissions", path: "media/preview-permissions", scopes: mediaPreviewScopes },
  "media-owner": { title: panelText('AccountPermissionsSettings.6f13b28a19'), id: "media-owner-permissions", path: "media/owner-permissions", scopes: mediaOwnerScopes },
  "group-export": { title: panelText('AccountPermissionsSettings.5f8fd6fc1f'), id: "group-export-permissions", path: "group/export-permissions", scopes: groupExportScopes },
} as const;
const section = props.section ?? "account";
const { title, id, path, scopes } = sections[section];
const heading = `${id}-title`;
const endpoint = `${import.meta.env.BASE_URL}api/settings/${path}`;
const labels: Record<Scope, string> = {
  "checkin.register": panelText('AccountPermissionsSettings.258539c0a7'),
  "checkin.refresh": panelText('AccountPermissionsSettings.b868cf2955'),
  "checkin.group_register": panelText('AccountPermissionsSettings.a62305e581'),
  "scheduler.generate": panelText('AccountPermissionsSettings.a3dbe0a672'),
  "scheduler.run_due": panelText('AccountPermissionsSettings.b0cbb6c39c'),
  "scheduler.manage": panelText('AccountPermissionsSettings.639b37f931'),
  "bilibili.download": panelText('AccountPermissionsSettings.f29adfb070'),
  "douyin.download": panelText('AccountPermissionsSettings.ee5601417f'),
  "acfun.play": panelText('AccountPermissionsSettings.a6a4b81e7b'),
  "pipixia.download": panelText('AccountPermissionsSettings.49b461e64a'),
  "weishi.play": panelText('AccountPermissionsSettings.38eadb0b09'),
  "zuiyou.play": panelText('AccountPermissionsSettings.377022ba68'),
  "kuaishou.download": panelText('AccountPermissionsSettings.06963c8504'),
  "acfun.preview": panelText('AccountPermissionsSettings.ebcf57bc30'),
  "weishi.preview": panelText('AccountPermissionsSettings.3da512f609'),
  "zuiyou.preview": panelText('AccountPermissionsSettings.f6ebaab462'),
  "wxchannels.preview": panelText('AccountPermissionsSettings.c4eacfe7d1'),
  "xigua.preview": panelText('AccountPermissionsSettings.f8ea6c144a'),
  "xhs.preview": panelText('AccountPermissionsSettings.a8aca28230'),
  "xhh.preview": panelText('AccountPermissionsSettings.9b463f30f6'),
  "bilibili.login": panelText('AccountPermissionsSettings.4b3685556b'),
  "tools.install": panelText('AccountPermissionsSettings.41dbd0caac'),
  "netease.partner": panelText('AccountPermissionsSettings.d75457cb15'),
  "group.members.export": panelText('AccountPermissionsSettings.be3754f2d4'),
};
const policyLabels: Record<AccountScopePolicy, string> = {
  inherit: panelText('AccountPermissionsSettings.a979ac4d37'), allow: panelText('AccountPermissionsSettings.ce7ef28b67'), deny: panelText('AccountPermissionsSettings.136de7a8c4'), master_only: panelText('AccountPermissionsSettings.dc138aeaa5'),
};
const groups = section === "account" ? [
  { title: panelText('AccountPermissionsSettings.b75732fe7c'), scopes: accountScopes.slice(0, 3) },
  { title: panelText('AccountPermissionsSettings.87587dbb42'), scopes: accountScopes.slice(3) },
] : [{ title: section === "media-download" ? panelText('AccountPermissionsSettings.47d6816892') : section === "media-preview" ? panelText('AccountPermissionsSettings.33d25ad43c') :
  section === "group-export" ? panelText('AccountPermissionsSettings.d52f5ac766') : panelText('AccountPermissionsSettings.b6368439a2'), scopes }];
function choices(scope: Scope) {
  const ownerScope = mediaOwnerScopes.find(name => name === scope);
  return ownerScope ? mediaOwnerScopePolicies(ownerScope) : accountScopePolicies;
}

const saved = shallowRef<Snapshot>();
const draft = ref<Snapshot["settings"]>();
const busy = ref<"GET" | "PUT">();
const error = ref("");
const notice = ref("");
const conflict = ref(false);
const confirmReload = ref(false);
let active: AbortController | undefined;

const changed = computed(() => {
  const before = saved.value?.settings;
  const next = draft.value;
  if (!before || !next) return {};
  return Object.fromEntries(scopes.filter(scope => next[scope] !== before[scope]).map(scope => [scope, next[scope]]));
});
const dirty = computed(() => Object.keys(changed.value).length > 0);
watch(dirty, value => {
  emit("dirty-change", value);
  if (!value) confirmReload.value = false;
});

function isSnapshot(input: unknown): input is Snapshot {
  if (!input || typeof input !== "object" || !("revision" in input) || !("settings" in input) ||
      typeof input.revision !== "string" || !/^[a-f0-9]{64}$/u.test(input.revision) ||
      !input.settings || typeof input.settings !== "object") return false;
  const policies = input.settings as Partial<Snapshot["settings"]>;
  return scopes.every(scope => choices(scope).some(policy => policies[scope] === policy));
}

async function request(method: "GET" | "PUT") {
  if (active || (method === "PUT" && (!saved.value || !dirty.value || conflict.value || confirmReload.value))) return;
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
      error.value = panelText('AccountPermissionsSettings.bd4bbeb4ad', { value1: title });
      return;
    }
    if (!response.ok) throw new Error();
    const result: unknown = await response.json();
    if (active !== controller) return;
    if (!isSnapshot(result)) throw new Error();
    saved.value = result;
    draft.value = { ...result.settings };
    conflict.value = false;
    if (method === "PUT") notice.value = panelText('AccountPermissionsSettings.0e89429981');
  } catch {
    if (active === controller) error.value = panelText('AccountPermissionsSettings.da32a9846a', { value1: title });
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
  <section :aria-labelledby="heading" :aria-busy="Boolean(busy)">
    <div class="section-heading">
      <h2 v-if="props.section" :id="heading">{{ title }}</h2>
      <h1 v-else :id="heading" tabindex="-1">{{ title }}</h1>
      <ElButton :loading="busy === 'GET'" :disabled="Boolean(busy) || confirmReload" @click="reload">{{ panelText('AccountPermissionsSettings.df7392cc96') }}</ElButton>
    </div>
    <div v-if="confirmReload" class="permission-actions" role="alert">
      <span>{{ panelText('AccountPermissionsSettings.e71b339a4e') }}</span>
      <ElButton @click="confirmReload = false">{{ panelText('AccountPermissionsSettings.fd4b9e3b6c') }}</ElButton>
      <ElButton type="danger" @click="request('GET')">{{ panelText('AccountPermissionsSettings.a5831537bd') }}</ElButton>
    </div>
    <p v-if="error" class="error refresh-error" role="alert">{{ error }}</p>
    <form v-if="draft" class="permission-settings" @submit.prevent="request('PUT')">
      <fieldset v-for="group in groups" :key="group.title" :disabled="Boolean(busy) || confirmReload">
        <legend>{{ group.title }}</legend>
        <label v-for="scope in group.scopes" :key="scope">
          {{ labels[scope] }}
          <select v-model="draft[scope]" :name="scope">
            <option v-for="policy in choices(scope)" :key="policy" :value="policy">{{ policyLabels[policy] }}</option>
          </select>
        </label>
      </fieldset>
      <p v-if="section === 'media-download'">{{ panelText('AccountPermissionsSettings.b68feae8f5') }}</p>
      <p v-else-if="section === 'media-preview'">{{ panelText('AccountPermissionsSettings.cd53781ccf') }}</p>
      <p v-else-if="section === 'media-owner'">{{ panelText('AccountPermissionsSettings.665a0f2d46') }}</p>
      <p v-else-if="section === 'group-export'">{{ panelText('AccountPermissionsSettings.451a8de93d') }}</p>
      <p v-else>{{ panelText('AccountPermissionsSettings.111901642a') }}</p>
      <div class="permission-actions">
        <ElButton type="primary" native-type="submit" :loading="busy === 'PUT'"
          :disabled="!dirty || Boolean(busy) || confirmReload || conflict">{{ panelText('AccountPermissionsSettings.a3030bf8f1') }}</ElButton>
        <span v-if="notice" role="status">{{ notice }}</span>
      </div>
    </form>
  </section>
</template>

<style scoped>
.permission-settings { display: grid; gap: 12px; max-width: 660px; margin-top: 20px; }
.permission-settings fieldset {
  display: grid; gap: 10px; min-width: 0; margin: 0; padding: 14px;
  border: 1px solid var(--line); border-radius: 12px; background: var(--surface);
}
.permission-settings legend { padding: 0 4px; font-weight: 650; }
.permission-settings label { display: grid; gap: 4px; font-size: 14px; font-weight: 600; }
.permission-settings select {
  width: 100%; min-height: 36px; padding: 0 9px; border: 1px solid var(--el-border-color);
  border-radius: 4px; background: var(--surface); color: inherit; font: inherit; font-weight: 400;
}
.permission-settings p, .permission-actions span { margin: 0; color: var(--muted); font-size: 14px; }
.permission-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.permission-actions :deep(.el-button + .el-button) { margin-left: 0; }
</style>
