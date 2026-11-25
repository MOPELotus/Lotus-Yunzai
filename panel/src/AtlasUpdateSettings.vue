<script setup lang="ts">
import { panelText } from './i18n.ts';

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

const scopeLabels: Record<AtlasScopeField, string> = { update_args: panelText('AtlasUpdateSettings.041ba096bd'), challenge_args: panelText('AtlasUpdateSettings.ab5e61e0cc') };
const scopeFields = ["update_args", "challenge_args"] as const;
const gameLabels = { gi: panelText('AtlasUpdateSettings.d1597c51ed'), hsr: panelText('AtlasUpdateSettings.8cfc959b53'), zzz: panelText('AtlasUpdateSettings.b1110352c9') };
const games = Object.entries(gameLabels);
const pages: Readonly<Record<string, string>> = {
  character: panelText('AtlasUpdateSettings.c47b54e84e'), artifact: panelText('AtlasUpdateSettings.fc2ee58f3d'), monster: panelText('AtlasUpdateSettings.40a2cbbcce'), weapon: panelText('AtlasUpdateSettings.4fe131173e'), "zzz/weapon": panelText('AtlasUpdateSettings.2ce0392ca1'),
  "achievement/achievement": panelText('AtlasUpdateSettings.52b0e1703d'), leyline: panelText('AtlasUpdateSettings.b7e6b57c67'), rolecombat: panelText('AtlasUpdateSettings.8cb870ae6a'), tower: panelText('AtlasUpdateSettings.82f72c6585'),
  lightcone: panelText('AtlasUpdateSettings.e733238b28'), relicset: panelText('AtlasUpdateSettings.2f2b17beb4'), maze_boss: panelText('AtlasUpdateSettings.8dae72d970'), maze: panelText('AtlasUpdateSettings.59977c7f79'), maze_peak: panelText('AtlasUpdateSettings.fdc6c58c58'),
  maze_extra: panelText('AtlasUpdateSettings.d66b949b63'), monstervalue: panelText('AtlasUpdateSettings.a1c6f7a65f'), EliteGroup: panelText('AtlasUpdateSettings.c9324dfa3b'), HardLevelGroup: panelText('AtlasUpdateSettings.9e8644e621'),
  InfiniteEliteGroup: panelText('AtlasUpdateSettings.8205043afb'), bangboo: panelText('AtlasUpdateSettings.aa46a7c35b'), equipment: panelText('AtlasUpdateSettings.d245c1825d'), boss: panelText('AtlasUpdateSettings.4b7b8e83d9'),
  shiyu: panelText('AtlasUpdateSettings.f718dc4321'), gcg: panelText('AtlasUpdateSettings.8c8df27f6c'),
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
  role_wiki: panelText('AtlasUpdateSettings.0d20b94ab6'),
  role_talent: panelText('AtlasUpdateSettings.08e11020f8'),
  role_photo: panelText('AtlasUpdateSettings.e8629739ec'),
  role_q_face: panelText('AtlasUpdateSettings.e866d68dbe'),
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
  if (mode === "load" && dirty.value && !window.confirm(panelText('AtlasUpdateSettings.377a4f5014'))) return;
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
      error.value = panelText('AtlasUpdateSettings.bbc6698bf1');
      return;
    }
    if (response.status === 422) {
      const { field } = await response.json().catch(() => ({})) as { field?: AtlasScopeField };
      if (active !== controller) return;
      const label = field && scopeLabels[field];
      error.value = panelText('AtlasUpdateSettings.a45b5e096c', { value1: label ?? panelText('AtlasUpdateSettings.scope_fallback') });
      return;
    }
    if (response.status === 400) {
      const { field } = await response.json().catch(() => ({})) as { field?: string };
      if (active !== controller) return;
      error.value = field === "check_cron" ? panelText('AtlasUpdateSettings.11793f5855') : field === "challenge_cron"
        ? panelText('AtlasUpdateSettings.0c669fb0bf') : field === "searchLimit"
          ? panelText('AtlasUpdateSettings.2926403b7f') : field === "locale" ? panelText('AtlasUpdateSettings.950c687353') : panelText('AtlasUpdateSettings.3252e75012');
      return;
    }
    if (!response.ok) {
      error.value = mode === "load" ? panelText('AtlasUpdateSettings.41206763e5') : panelText('AtlasUpdateSettings.88f8ab20d8');
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
      error.value = panelText('AtlasUpdateSettings.f918aea48d');
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
    if (mode === "save") feedback.value = panelText('AtlasUpdateSettings.42d8c144a9');
  } catch {
    if (active === controller) error.value = panelText('AtlasUpdateSettings.19818d1a03');
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
      <h2 id="atlas-update-title">{{ panelText('AtlasUpdateSettings.01e6daa4ef') }}</h2>
      <ElButton :loading="busy === 'load'" :disabled="Boolean(busy)" @click="sync('load')">{{ panelText('AtlasUpdateSettings.df7392cc96') }}</ElButton>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <form v-if="saved" @submit.prevent="sync('save')">
      <fieldset :disabled="Boolean(busy)">
        <label for="atlas-locale">{{ panelText('AtlasUpdateSettings.389c832f9d') }}</label>
        <select id="atlas-locale" v-model="locale" aria-describedby="atlas-locale-note">
          <option v-for="(language, id) in atlasLocales" :key="id" :value="id">{{ language.folder }}</option>
        </select>
        <p id="atlas-locale-note" class="subtitle toggle-note">
          {{ panelText('AtlasUpdateSettings.c6d1cc350a') }}
        </p>
        <template v-if="saved.searchLimit !== undefined">
          <label for="atlas-search-limit">{{ panelText('AtlasUpdateSettings.61de27040d') }}</label>
          <input id="atlas-search-limit" v-model.number="searchLimit" type="number" min="1" step="1" required
            aria-describedby="atlas-search-limit-note" />
          <p id="atlas-search-limit-note" class="subtitle toggle-note">{{ panelText('AtlasUpdateSettings.c5ca3114e6') }}</p>
        </template>
        <template v-if="saved.roleQueries">
          <h3 id="atlas-role-queries">{{ panelText('AtlasUpdateSettings.736130609d') }}</h3>
          <label v-for="field in atlasRoleFields" :key="field" class="update-toggle">
            <input :id="'atlas-' + field" v-model="roleDraft[field]" type="checkbox" aria-describedby="atlas-role-queries-note" />
            {{ roleLabels[field] }}
          </label>
          <p id="atlas-role-queries-note" class="subtitle toggle-note">{{ panelText('AtlasUpdateSettings.263a95fbfd') }}</p>
        </template>
        <label class="update-toggle"><input v-model="draft.enable" type="checkbox" />{{ panelText('AtlasUpdateSettings.d2c38c765d') }}</label>
        <label class="update-toggle">
          <input id="atlas-sync-after-update" v-model="syncAfterUpdate" type="checkbox" aria-describedby="atlas-sync-after-update-note" />
          {{ panelText('AtlasUpdateSettings.f70814ad3f') }}
        </label>
        <p id="atlas-sync-after-update-note" class="subtitle toggle-note">
          {{ panelText('AtlasUpdateSettings.63d84214a2') }}
        </p>
        <label class="update-toggle">
          <input id="atlas-sync-gallery" v-model="syncGallery" type="checkbox" aria-describedby="atlas-sync-gallery-note" />
          {{ panelText('AtlasUpdateSettings.afbf3cb128') }}
        </label>
        <p id="atlas-sync-gallery-note" class="subtitle toggle-note">
          {{ panelText('AtlasUpdateSettings.8f7298e7b1') }}
        </p>
        <label class="update-toggle">
          <input id="atlas-sync-character-gallery" v-model="syncCharacterGallery" type="checkbox"
            aria-describedby="atlas-sync-character-gallery-note" />
          {{ panelText('AtlasUpdateSettings.fe26dd5e1e') }}
        </label>
        <p id="atlas-sync-character-gallery-note" class="subtitle toggle-note">
          {{ panelText('AtlasUpdateSettings.5ceb4a5110') }}
        </p>
        <label for="atlas-check-cron">{{ panelText('AtlasUpdateSettings.000d7c7f12') }}</label>
        <input id="atlas-check-cron" v-model="draft.check_cron" type="text" maxlength="160" autocomplete="off"
          spellcheck="false" :placeholder="panelText('AtlasUpdateSettings.fb2553fbaf')" />
        <label for="atlas-challenge-cron">{{ panelText('AtlasUpdateSettings.15fd113c8a') }}</label>
        <input id="atlas-challenge-cron" v-model="draft.challenge_cron" type="text" maxlength="160" autocomplete="off"
          spellcheck="false" :placeholder="panelText('AtlasUpdateSettings.58a842bfb1')" />
        <label class="update-toggle">
          <input id="atlas-initialize-missing" v-model="draft.run_on_missing_data" type="checkbox"
            aria-describedby="atlas-initialize-missing-note" />{{ panelText('AtlasUpdateSettings.9e26797447') }}
        </label>
        <p id="atlas-initialize-missing-note" class="subtitle toggle-note">
          {{ panelText('AtlasUpdateSettings.3e3cbccb23') }}
        </p>
        <details v-for="field in scopeFields" v-show="saved.scopes" :key="field" class="scope-editor">
          <summary>{{ scopeLabels[field] }}
            <span v-if="scopeDraft[field]" class="subtitle">{{ panelText('AtlasUpdateSettings.c762e88370', { value1: scopeDraft[field]?.length }) }}</span>
            <span v-else class="subtitle">{{ panelText('AtlasUpdateSettings.ff2ceb23b3') }}</span>
          </summary>
          <template v-if="saved.scopes?.[field].selected">
            <ElButton size="small" @click="scopeDraft[field] = [...saved.scopes[field].available]">{{ panelText('AtlasUpdateSettings.557dac75ff') }}</ElButton>
            <fieldset v-for="[game, gameLabel] in games" :key="game" class="scope-game">
              <legend>{{ gameLabel }}</legend>
              <label v-for="item in saved.scopes[field].available.filter(value => value.startsWith(game + '/'))"
                :key="item" class="update-toggle">
                <input v-model="scopeDraft[field]" type="checkbox" :value="item" :name="field" />
                {{ pages[item] ?? pages[item.slice(game.length + 1)] ?? item.slice(game.length + 1) }}
              </label>
            </fieldset>
            <p v-if="!scopeDraft[field]?.length" class="error">{{ panelText('AtlasUpdateSettings.9da43eb340') }}</p>
          </template>
          <p v-else class="subtitle">{{ panelText('AtlasUpdateSettings.8969fc95ab') }}</p>
        </details>
      </fieldset>
      <p class="subtitle">{{ panelText('AtlasUpdateSettings.c1433240e2') }}</p>
      <div class="update-actions">
        <ElButton type="primary" native-type="submit" :loading="busy === 'save'" :disabled="!dirty || scopeInvalid || searchInvalid || Boolean(busy)">{{ panelText('AtlasUpdateSettings.a02acd08ff') }}</ElButton>
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
