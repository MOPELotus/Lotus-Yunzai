<script setup lang="ts">
import { ElButton } from "element-plus";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { AtlasScopeField, AtlasScopePatch, AtlasScopeSelections } from "../../lib/panel-atlas-scope-schema.ts";
import { atlasLocales, defaultAtlasLocale, parseAtlasLocale, type AtlasLocale } from "../../plugins/atlas/locale.ts";
import { atlasRoleFields, readAtlasRoleSettings, type AtlasRoleSettings } from "../../plugins/atlas/role-switches.ts";
import { parseAtlasSearchLimit } from "../../plugins/atlas/search-limit.ts";
import { panelFetch, type PanelAuth } from "./api.ts";

interface Settings { enable: boolean; check_cron: string; challenge_cron: string; run_on_missing_data: boolean }
interface Snapshot {
  settings: Settings;
  revision: string;
  locale: AtlasLocale;
  syncAfterUpdate: boolean;
  syncGallery: boolean;
  syncCharacterGallery: boolean;
  roleQueries?: AtlasRoleSettings;
  scopes?: AtlasScopeSelections;
  searchLimit?: number;
}

const scopeLabels: Record<AtlasScopeField, string> = { update_args: "版本更新范围", challenge_args: "挑战刷新范围" };
const scopeFields = ["update_args", "challenge_args"] as const;
const gameLabels = { gi: "原神", hsr: "崩坏：星穹铁道", zzz: "绝区零" };
const games = Object.entries(gameLabels);
const pages: Readonly<Record<string, string>> = {
  character: "角色", artifact: "圣遗物", monster: "敌人", weapon: "武器", "zzz/weapon": "音擎",
  "achievement/achievement": "成就", leyline: "地脉", rolecombat: "幻想真境剧诗", tower: "深境螺旋",
  lightcone: "光锥", relicset: "遗器", maze_boss: "末日幻影", maze: "混沌回忆", maze_peak: "异相仲裁",
  maze_extra: "虚构叙事", monstervalue: "敌人数值", EliteGroup: "精英敌人组", HardLevelGroup: "关卡敌人组",
  InfiniteEliteGroup: "虚构敌人组", bangboo: "邦布", equipment: "驱动盘", boss: "危局强袭战",
  shiyu: "式舆防卫战", gcg: "七圣召唤",
};

const props = defineProps<{ auth: PanelAuth }>();
const emit = defineEmits<{ unauthorized: []; "dirty-change": [dirty: boolean] }>();
const endpoint = `${import.meta.env.BASE_URL}api/settings/atlas/update`;
const saved = ref<Snapshot>();
const draft = ref<Settings>({ enable: false, check_cron: "", challenge_cron: "", run_on_missing_data: true });
const scopeDraft = ref<AtlasScopePatch>({});
const searchLimit = ref<number>();
const roleDraft = ref(readAtlasRoleSettings(undefined));
const roleLabels: Record<keyof AtlasRoleSettings, string> = {
  role_wiki: "角色图鉴和资料",
  role_talent: "角色天赋、技能、行迹和命座／星魂",
  role_photo: "角色照片和写真",
  role_q_face: "角色资料图使用 Q 版头像",
};
const roleChanges = computed(() => Object.fromEntries(atlasRoleFields.flatMap(field =>
  saved.value?.roleQueries && saved.value.roleQueries[field] !== roleDraft.value[field] ? [[field, roleDraft.value[field]]] : [],
)));

const locale = ref<AtlasLocale>(defaultAtlasLocale);
const syncAfterUpdate = ref(true);
const syncGallery = ref(true);
const syncCharacterGallery = ref(true);
const busy = ref<"load" | "save">();
const error = ref("");
const feedback = ref("");
const scopePatch = computed<AtlasScopePatch>(() => Object.fromEntries(scopeFields.flatMap(field => {
  const original = saved.value?.scopes?.[field].selected;
  const selected = scopeDraft.value[field];
  return original && selected &&
    (selected.length !== original.length || original.some(item => !selected.includes(item))) ? [[field, selected]] : [];
})));
const scopeInvalid = computed(() => Object.values(scopePatch.value).some(scope => !scope.length));
const searchInvalid = computed(() => saved.value?.searchLimit !== undefined &&
  (typeof searchLimit.value !== "number" || parseAtlasSearchLimit(searchLimit.value) === undefined));
const searchDirty = computed(() => saved.value?.searchLimit !== searchLimit.value);
const syncDirty = computed(() => saved.value?.syncAfterUpdate !== syncAfterUpdate.value);
const galleryDirty = computed(() => saved.value?.syncGallery !== syncGallery.value);
const characterGalleryDirty = computed(() => saved.value?.syncCharacterGallery !== syncCharacterGallery.value);
const localeDirty = computed(() => saved.value?.locale !== locale.value);
const dirty = computed(() => !!saved.value && (localeDirty.value || searchDirty.value || syncDirty.value || galleryDirty.value || characterGalleryDirty.value ||
  Object.keys(roleChanges.value).length > 0 || Object.keys(scopePatch.value).length > 0 || JSON.stringify(saved.value.settings) !== JSON.stringify(draft.value)));
let active: AbortController | undefined;

watch(dirty, value => emit("dirty-change", value));

async function sync(mode: "load" | "save") {
  if (active || (mode === "save" && (!dirty.value || scopeInvalid.value || searchInvalid.value))) return;
  if (mode === "load" && dirty.value && !window.confirm("放弃未保存的图鉴设置？")) return;
  const controller = new AbortController();
  active = controller;
  const timeout = setTimeout(() => controller.abort(), 10_000);
  busy.value = mode;
  error.value = feedback.value = "";
  try {
    const response = await panelFetch(endpoint, props.auth, {
      method: mode === "load" ? "GET" : "PUT",
      headers: mode === "save" ? { "Content-Type": "application/json" } : undefined,
      body: mode === "save" ? JSON.stringify({ settings: draft.value, revision: saved.value?.revision,
        ...(localeDirty.value && { locale: locale.value }),
        ...(searchDirty.value && { searchLimit: searchLimit.value }),
        ...(syncDirty.value && { syncAfterUpdate: syncAfterUpdate.value }),
        ...(galleryDirty.value && { syncGallery: syncGallery.value }),
        ...(characterGalleryDirty.value && { syncCharacterGallery: syncCharacterGallery.value }),
        ...(Object.keys(roleChanges.value).length && { roleQueries: roleChanges.value }),
        ...(Object.keys(scopePatch.value).length && { scopePatch: scopePatch.value }) }) : undefined,
      signal: controller.signal,
    });
    if (active !== controller) return;
    if (response.status === 401) return emit("unauthorized");
    if (response.status === 409) {
      error.value = "设置已在其他会话更新，请重新读取后再保存。";
      return;
    }
    if (response.status === 422) {
      const { field } = await response.json().catch(() => ({})) as { field?: AtlasScopeField };
      if (active !== controller) return;
      const label = field && scopeLabels[field];
      error.value = `无法安全改写${label ?? "图鉴分类范围"}。请在本机配置中调整原参数，并重新读取。`;
      return;
    }
    if (response.status === 400) {
      const { field } = await response.json().catch(() => ({})) as { field?: string };
      if (active !== controller) return;
      error.value = field === "check_cron" ? "版本检查的 Cron 表达式无效。" : field === "challenge_cron"
        ? "挑战刷新的 Cron 表达式无效。" : field === "searchLimit"
          ? "查询条数须为有效的正整数。" : field === "locale" ? "请选择图鉴语言。" : "请检查图鉴设置。";
      return;
    }
    if (!response.ok) {
      error.value = mode === "load" ? "宿主未能读取图鉴设置。" : "宿主未能保存图鉴设置。";
      return;
    }
    const result = await response.json() as Snapshot;
    if (active !== controller) return;
    if (typeof result?.revision !== "string" || parseAtlasLocale(result.locale) === undefined || typeof result?.settings?.enable !== "boolean" ||
        typeof result.syncAfterUpdate !== "boolean" || typeof result.syncGallery !== "boolean" || typeof result.syncCharacterGallery !== "boolean" ||
        (result.roleQueries !== undefined && (!result.roleQueries || atlasRoleFields.some(field => typeof result.roleQueries?.[field] !== "boolean"))) ||
        typeof result.settings.run_on_missing_data !== "boolean" ||
        typeof result.settings.check_cron !== "string" || typeof result.settings.challenge_cron !== "string" ||
        (result.searchLimit !== undefined && (typeof result.searchLimit !== "number" || parseAtlasSearchLimit(result.searchLimit) === undefined))) {
      error.value = "宿主返回了无法识别的图鉴设置。";
      return;
    }
    saved.value = result;
    draft.value = { ...result.settings };
    searchLimit.value = result.searchLimit;
    locale.value = result.locale;
    syncAfterUpdate.value = result.syncAfterUpdate;
    syncGallery.value = result.syncGallery;
    syncCharacterGallery.value = result.syncCharacterGallery;
    roleDraft.value = result.roleQueries ? { ...result.roleQueries } : readAtlasRoleSettings(undefined);
    scopeDraft.value = Object.fromEntries(scopeFields.flatMap(field => {
      const selected = result.scopes?.[field].selected;
      return selected ? [[field, [...selected]]] : [];
    }));
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
      <h2 id="atlas-update-title">查询与自动更新</h2>
      <ElButton :loading="busy === 'load'" :disabled="Boolean(busy)" @click="sync('load')">重新读取</ElButton>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <form v-if="saved" @submit.prevent="sync('save')">
      <fieldset :disabled="Boolean(busy)">
        <label for="atlas-locale">图鉴语言</label>
        <select id="atlas-locale" v-model="locale" aria-describedby="atlas-locale-note">
          <option v-for="(language, id) in atlasLocales" :key="id" :value="id">{{ language.folder }}</option>
        </select>
        <p id="atlas-locale-note" class="subtitle toggle-note">
          重启后生效。更换语言后可发送 #更新图鉴 下载对应资料。繁體中文使用自备图鉴目录。
        </p>
        <template v-if="saved.searchLimit !== undefined">
          <label for="atlas-search-limit">每次查询最多返回</label>
          <input id="atlas-search-limit" v-model.number="searchLimit" type="number" min="1" step="1" required
            aria-describedby="atlas-search-limit-note" />
          <p id="atlas-search-limit-note" class="subtitle toggle-note">控制同名或模糊查询返回的条目数。</p>
        </template>
        <template v-if="saved.roleQueries">
          <h3 id="atlas-role-queries">原神和星铁角色查询</h3>
          <label v-for="field in atlasRoleFields" :key="field" class="update-toggle">
            <input :id="'atlas-' + field" v-model="roleDraft[field]" type="checkbox" aria-describedby="atlas-role-queries-note" />
            {{ roleLabels[field] }}
          </label>
          <p id="atlas-role-queries-note" class="subtitle toggle-note">重启后生效，默认开启。头像选项适用于原神和星铁的天赋／星魂图、面板列表、角色名册及抽卡详情和统计。</p>
        </template>
        <label class="update-toggle"><input v-model="draft.enable" type="checkbox" />启用图鉴定时更新</label>
        <label class="update-toggle">
          <input id="atlas-sync-after-update" v-model="syncAfterUpdate" type="checkbox" aria-describedby="atlas-sync-after-update-note" />
          下载校验后发布图鉴
        </label>
        <p id="atlas-sync-after-update-note" class="subtitle toggle-note">
          关闭后，手动和定时更新仅保存已校验的候选，当前查询继续使用现有资料。
        </p>
        <label class="update-toggle">
          <input id="atlas-sync-gallery" v-model="syncGallery" type="checkbox" aria-describedby="atlas-sync-gallery-note" />
          发布图鉴时同步插图
        </label>
        <p id="atlas-sync-gallery-note" class="subtitle toggle-note">
          关闭后，发布新条目时沿用已有图鉴插图。恢复后可发送 #全量更新图鉴 补齐图片。
        </p>
        <label class="update-toggle">
          <input id="atlas-sync-character-gallery" v-model="syncCharacterGallery" type="checkbox"
            aria-describedby="atlas-sync-character-gallery-note" />
          自动同步三游角色图库
        </label>
        <p id="atlas-sync-character-gallery-note" class="subtitle toggle-note">
          每 12 小时检查原神、星铁和绝区零的角色图片。关闭后保留已同步的图片。
        </p>
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
        <details v-for="field in scopeFields" v-show="saved.scopes" :key="field" class="scope-editor">
          <summary>{{ scopeLabels[field] }}
            <span v-if="scopeDraft[field]" class="subtitle">已选 {{ scopeDraft[field]?.length }} 项</span>
            <span v-else class="subtitle">需在本机编辑</span>
          </summary>
          <template v-if="saved.scopes?.[field].selected">
            <ElButton size="small" @click="scopeDraft[field] = [...saved.scopes[field].available]">全部选中</ElButton>
            <fieldset v-for="[game, gameLabel] in games" :key="game" class="scope-game">
              <legend>{{ gameLabel }}</legend>
              <label v-for="item in saved.scopes[field].available.filter(value => value.startsWith(game + '/'))"
                :key="item" class="update-toggle">
                <input v-model="scopeDraft[field]" type="checkbox" :value="item" :name="field" />
                {{ pages[item] ?? pages[item.slice(game.length + 1)] ?? item.slice(game.length + 1) }}
              </label>
            </fieldset>
            <p v-if="!scopeDraft[field]?.length" class="error">请至少选择一类资料。</p>
          </template>
          <p v-else class="subtitle">现有参数无法在页面中安全编辑，已保留原配置。请在本机 YAML 中调整。</p>
        </details>
      </fieldset>
      <p class="subtitle">清空时间表可恢复默认频率。保存后重启宿主生效。</p>
      <div class="update-actions">
        <ElButton type="primary" native-type="submit" :loading="busy === 'save'" :disabled="!dirty || scopeInvalid || searchInvalid || Boolean(busy)">保存图鉴设置</ElButton>
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
fieldset input:is([type="text"], [type="number"]) { border: 1px solid var(--line); padding: 8px; border-radius: 6px; color: inherit; background: var(--surface); }
.update-toggle input { accent-color: var(--accent); }
.subtitle { margin: 12px 0; }
.toggle-note { margin: 0; }
.scope-editor { border: 1px solid var(--line); padding: 9px 12px; border-radius: 6px; }
.scope-editor summary { cursor: pointer; overflow-wrap: anywhere; }
.scope-editor summary .subtitle { margin-left: 7px; }
.scope-editor > button { margin-top: 7px; }
.scope-game { display: flex; flex-wrap: wrap; column-gap: 12px; padding: 6px 0; }
.scope-game legend { font-weight: 650; }
</style>
