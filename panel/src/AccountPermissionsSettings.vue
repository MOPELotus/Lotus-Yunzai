<script setup lang="ts">
import { ElButton } from "element-plus";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { accountScopePolicies, accountScopes, groupExportScopes, mediaDownloadScopes, mediaOwnerScopePolicies, mediaOwnerScopes,
  type AccountScope, type AccountScopePolicy, type GroupExportScope, type MediaDownloadScope, type MediaOwnerScope,
  type ScopePolicySnapshot } from "../../lib/account-scope-policy.ts";
import { panelFetch, type PanelAuth } from "./api.ts";

const props = defineProps<{ auth: PanelAuth; section?: "media-download" | "media-owner" | "group-export" }>();
const emit = defineEmits<{ unauthorized: []; "dirty-change": [dirty: boolean] }>();
type Scope = AccountScope | MediaDownloadScope | MediaOwnerScope | GroupExportScope;
type Snapshot = ScopePolicySnapshot<Scope>;
const sections = {
  account: { title: "签到权限", id: "account-permissions", path: "checkin/permissions", scopes: accountScopes },
  "media-download": { title: "媒体下载权限", id: "media-download-permissions", path: "media/download-permissions", scopes: mediaDownloadScopes },
  "media-owner": { title: "媒体主人权限", id: "media-owner-permissions", path: "media/owner-permissions", scopes: mediaOwnerScopes },
  "group-export": { title: "群成员导出权限", id: "group-export-permissions", path: "group/export-permissions", scopes: groupExportScopes },
} as const;
const section = props.section ?? "account";
const { title, id, path, scopes } = sections[section];
const heading = `${id}-title`;
const endpoint = `${import.meta.env.BASE_URL}api/settings/${path}`;
const labels: Record<Scope, string> = {
  "checkin.register": "注册签到",
  "checkin.refresh": "刷新登录信息",
  "checkin.group_register": "批量注册本群签到",
  "scheduler.generate": "生成全局签到计划",
  "scheduler.run_due": "执行到期签到",
  "scheduler.manage": "聊天中修改调度",
  "bilibili.download": "B 站视频下载",
  "douyin.download": "抖音媒体下载",
  "acfun.play": "AcFun 视频播放",
  "pipixia.download": "皮皮虾视频下载",
  "weishi.play": "微视视频播放",
  "zuiyou.play": "最右视频播放",
  "kuaishou.download": "快手视频下载",
  "bilibili.login": "B 站扫码登录",
  "tools.install": "初始化及按需安装媒体工具",
  "netease.partner": "合伙人手动操作及 TuneWeave 指令",
  "group.members.export": "#群成员",
};
const policyLabels: Record<AccountScopePolicy, string> = {
  inherit: "继承全局权限", allow: "允许", deny: "拒绝", master_only: "仅机器人主人",
};
const groups = section === "account" ? [
  { title: "档案与签到", scopes: accountScopes.slice(0, 3) },
  { title: "调度指令", scopes: accountScopes.slice(3) },
] : [{ title: section === "media-download" ? "下载策略" : section === "group-export" ? "CSV 导出" : "主人指令", scopes }];
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
      error.value = `${title}已在别处修改。请重新读取后再保存。`;
      return;
    }
    if (!response.ok) throw new Error();
    const result: unknown = await response.json();
    if (active !== controller) return;
    if (!isSnapshot(result)) throw new Error();
    saved.value = result;
    draft.value = { ...result.settings };
    conflict.value = false;
    if (method === "PUT") notice.value = "权限设置已保存。";
  } catch {
    if (active === controller) error.value = `暂时无法读取或保存${title}。`;
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
      <ElButton :loading="busy === 'GET'" :disabled="Boolean(busy) || confirmReload" @click="reload">重新读取</ElButton>
    </div>
    <div v-if="confirmReload" class="permission-actions" role="alert">
      <span>重新读取会放弃未保存的改动。</span>
      <ElButton @click="confirmReload = false">继续编辑</ElButton>
      <ElButton type="danger" @click="request('GET')">放弃改动并读取</ElButton>
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
      <p v-if="section === 'media-download'">用户和群拒绝名单优先。下次需要下载权限的操作会采用新设置。</p>
      <p v-else-if="section === 'media-owner'">用户和群拒绝名单优先。这些指令始终要求机器人主人，涉及扫码和合伙人日志时还要求好友私聊。保存后从下一次手动操作开始生效。</p>
      <p v-else-if="section === 'group-export'">用户和群拒绝名单优先。给普通成员放行时，仍须核对此人在目标群内。保存后下次导出生效。</p>
      <p v-else>用户和群拒绝名单仍优先。聊天中修改调度的权限在下次操作时生效，其余项目重启宿主后生效。</p>
      <div class="permission-actions">
        <ElButton type="primary" native-type="submit" :loading="busy === 'PUT'"
          :disabled="!dirty || Boolean(busy) || confirmReload || conflict">保存</ElButton>
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
