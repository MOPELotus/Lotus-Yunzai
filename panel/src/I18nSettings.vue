<script setup lang="ts">
import { panelText } from './i18n.ts';

import { ElButton } from "element-plus";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { panelFetch, type PanelAuth } from "./api.ts";
import { panelLanguage, panelLanguages, requestPanelLanguage, type PanelLanguageSnapshot } from "./i18n.ts";

const props = defineProps<{ auth: PanelAuth }>();
const emit = defineEmits<{ unauthorized: []; "dirty-change": [dirty: boolean] }>();
const saved = shallowRef<PanelLanguageSnapshot>();
const namespace = ref("");
const section = ref("");
const query = ref("");
const selectedKey = ref("");
const draft = ref("");
const languageDraft = ref(panelLanguage.value);
const busy = ref(false);
const restarting = ref(false);
const error = ref("");
const feedback = ref("");
let active: AbortController | undefined;
const namespaces = computed(() => Object.entries(saved.value?.defaults ?? {}).map(([key, value]) => ({ key, label: value.description?.split(/[。；\n]/u)[0] || key })));
const defaults = computed(() => saved.value?.defaults?.[namespace.value]);
const sections = computed(() => Object.entries(defaults.value?.sections ?? {}));
const sectionInfo = computed(() => defaults.value?.sections?.[section.value]);
const current = computed(() => saved.value?.catalogs?.[namespace.value] ?? {});
const original = computed(() => defaults.value?.messages[selectedKey.value] ?? "");
const stored = computed(() => current.value[selectedKey.value] ?? original.value);
const parameters = computed(() => defaults.value?.parameters?.[selectedKey.value] ?? {});
const dirty = computed(() => Boolean(selectedKey.value) && draft.value !== stored.value);
function entrySection(key: string) {
  return Object.entries(defaults.value?.sections ?? {}).filter(([id]) => key === id || key.startsWith(id + ".") || key.startsWith(id + "/"))
    .sort(([a], [b]) => b.length - a.length)[0]?.[1];
}
const selectedInfo = computed(() => entrySection(selectedKey.value));
const matches = computed(() => {
  const search = query.value.trim().toLocaleLowerCase();
  return Object.entries(defaults.value?.messages ?? {}).filter(([key, text]) => {
    if (section.value && key !== section.value && !key.startsWith(section.value + ".") && !key.startsWith(section.value + "/")) return false;
    return !search || [key, text, current.value[key] ?? "", entrySection(key)?.description ?? "", entrySection(key)?.source ?? ""].some(value => value.toLocaleLowerCase().includes(search));
  });
});
const page = ref(1);
const pages = computed(() => Math.max(1, Math.ceil(matches.value.length / 60)));
const visible = computed(() => matches.value.slice((page.value - 1) * 60, page.value * 60));
watch([namespace, section, query], () => { page.value = 1; });
watch(dirty, value => emit("dirty-change", value));
watch(namespace, () => { section.value = ""; selectedKey.value = ""; draft.value = ""; });

function choose(key: string) {
  if (dirty.value && !window.confirm(panelText('I18nSettings.db90ac21bb'))) return;
  selectedKey.value = key;
  draft.value = current.value[key] ?? defaults.value?.messages[key] ?? "";
  error.value = feedback.value = "";
}
function changeNamespace(event: Event) {
  const next = (event.target as HTMLSelectElement).value;
  if (dirty.value && !window.confirm(panelText('I18nSettings.db90ac21bb'))) { (event.target as HTMLSelectElement).value = namespace.value; return; }
  namespace.value = next;
}
async function load() {
  if (busy.value || dirty.value && !window.confirm(panelText('I18nSettings.2151a2cc84'))) return;
  const request = new AbortController(); active = request; busy.value = true; error.value = feedback.value = "";
  try {
    const data = await requestPanelLanguage(props.auth, { signal: request.signal });
    if (active !== request) return;
    saved.value = data; languageDraft.value = data.language;
    namespace.value ||= Object.keys(data.defaults ?? {})[0] ?? "";
    if (selectedKey.value) draft.value = data.catalogs[namespace.value]?.[selectedKey.value] ?? original.value;
  } catch (failure) { fail(failure); }
  finally { if (active === request) { active = undefined; busy.value = false; } }
}
function fail(failure: unknown) {
  if ((failure as { status?: number })?.status === 401 || (failure as { status?: number })?.status === 403) emit("unauthorized");
  else error.value = failure instanceof Error ? failure.message : panelText('I18nSettings.27fa28854e');
}
async function save() {
  if (busy.value || !dirty.value) return;
  const request = new AbortController(); active = request; busy.value = true; error.value = feedback.value = "";
  const key = selectedKey.value, value = draft.value;
  try {
    saved.value = await requestPanelLanguage(props.auth, { method: "PATCH", signal: request.signal,
      body: { language: panelLanguage.value, namespace: namespace.value, messages: { [key]: value } } });
    feedback.value = panelText('I18nSettings.f61b0e29b8');
  } catch (failure) { fail(failure); }
  finally { if (active === request) { active = undefined; busy.value = false; } }
}
async function changeLanguage() {
  if (busy.value || languageDraft.value === panelLanguage.value) return;
  if (dirty.value && !window.confirm(panelText('I18nSettings.97c2dfcf75'))) return;
  const request = new AbortController(); active = request; busy.value = true; error.value = feedback.value = "";
  try {
    await requestPanelLanguage(props.auth, { method: "PUT", body: { language: languageDraft.value }, signal: request.signal });
    window.location.reload();
  } catch (failure) { fail(failure); }
  finally { if (active === request) { active = undefined; busy.value = false; } }
}
async function applyChanges() {
  if (busy.value || dirty.value || restarting.value || !saved.value?.restartRequired ||
      !window.confirm(panelText('I18nSettings.confirm_apply'))) return;
  const request = new AbortController(); active = request; busy.value = true; error.value = feedback.value = "";
  try {
    const response = await panelFetch(`${import.meta.env.BASE_URL}api/i18n/apply`, props.auth,
      { method: "POST", signal: AbortSignal.any([request.signal, AbortSignal.timeout(10000)]) });
    if (!response.ok) throw Object.assign(new Error(panelText('I18nSettings.apply_failed')), { status: response.status });
    const result = await response.json();
    if (result?.restarting !== true) throw new Error(panelText('I18nSettings.apply_failed'));
    restarting.value = true;
    feedback.value = panelText('I18nSettings.restarting');
  } catch (failure) { fail(failure); }
  finally { if (active === request) { active = undefined; busy.value = false; } }
}
function downloadTemplate() {
  const messages = Object.fromEntries(Object.entries(saved.value?.defaults ?? {}).map(([name, catalog]) => [name, catalog.messages]));
  const description = Object.fromEntries(Object.entries(saved.value?.defaults ?? {}).map(([name, catalog]) => [name,
    { description: catalog.description, sections: catalog.sections, parameters: catalog.parameters }]));
  const data = new Blob([JSON.stringify({ name: panelText('I18nSettings.9937e365aa'), messages, description }, null, 2) + "\n"], { type: "application/json" });
  const url = URL.createObjectURL(data), link = document.createElement("a");
  link.href = url; link.download = "zh-CN.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
}
onMounted(() => { void load(); });
onBeforeUnmount(() => { active?.abort(); active = undefined; });
</script>

<template>
  <section aria-labelledby="i18n-settings-title" :aria-busy="busy">
    <div class="section-heading">
      <div><h1 id="i18n-settings-title" tabindex="-1">{{ panelText('I18nSettings.c1c579a974') }}</h1><p class="subtitle">{{ panelText('I18nSettings.3d6d7a1fb8') }}</p></div>
      <div class="i18n-actions"><ElButton :disabled="busy" @click="load">{{ panelText('I18nSettings.df7392cc96') }}</ElButton>
        <ElButton :disabled="busy || !saved" @click="downloadTemplate">{{ panelText('I18nSettings.fa7f214ce6') }}</ElButton></div>
    </div>
    <p v-if="error" class="error refresh-error" role="alert">{{ error }}</p>
    <p v-if="feedback" role="status">{{ feedback }}</p>
    <div v-if="saved?.restartRequired" class="i18n-apply" role="status">
      <p>{{ panelText('I18nSettings.restart_required') }}</p>
      <ElButton type="primary" :disabled="busy || dirty || restarting" @click="applyChanges">{{ panelText('I18nSettings.apply_changes') }}</ElButton>
    </div>
    <fieldset class="i18n-language" :disabled="busy">
      <legend>{{ panelText('I18nSettings.afea366123') }}</legend>
      <label for="i18n-language">{{ panelText('I18nSettings.2fbb97fb21') }}</label>
      <select id="i18n-language" v-model="languageDraft"><option v-for="language in panelLanguages" :key="language.id" :value="language.id">{{ language.label }}</option></select>
      <ElButton :disabled="languageDraft === panelLanguage" @click="changeLanguage">{{ panelText('I18nSettings.1d3a69cc0b') }}</ElButton>
      <p>{{ panelText('I18nSettings.b7766214e4') }}</p>
    </fieldset>
    <div v-if="saved" class="i18n-editor">
      <aside class="i18n-index">
        <label for="i18n-namespace">{{ panelText('I18nSettings.7785a5282f') }}</label>
        <select id="i18n-namespace" :value="namespace" :disabled="busy" @change="changeNamespace"><option v-for="item in namespaces" :key="item.key" :value="item.key">{{ item.label }} · {{ item.key }}</option></select>
        <label for="i18n-section">{{ panelText('I18nSettings.a1963a6491') }}</label>
        <select id="i18n-section" v-model="section" :disabled="busy"><option value="">{{ panelText('I18nSettings.a105443485') }}</option><option v-for="[id, item] in sections" :key="id" :value="id">{{ item.description || id }}</option></select>
        <label for="i18n-search">{{ panelText('I18nSettings.44ce7ae909') }}</label><input id="i18n-search" v-model="query" :placeholder="panelText('I18nSettings.4cccf9bd43')" />
        <p v-if="sectionInfo" class="subtitle">{{ sectionInfo.description }}<br /><code>{{ sectionInfo.source }}</code></p>
        <p class="subtitle">{{ panelText('I18nSettings.85ad0e0477', { value1: matches.length }) }}</p>
        <ul class="i18n-keys"><li v-for="[key, text] in visible" :key="key"><button :class="{ selected: key === selectedKey }" :disabled="busy" @click="choose(key)"><code>{{ key }}</code><span>{{ current[key] ?? text }}</span></button></li></ul>
        <div class="i18n-actions"><ElButton :disabled="page <= 1" @click="page--">{{ panelText('I18nSettings.c9b9ae7a61') }}</ElButton><span>{{ page }} / {{ pages }}</span><ElButton :disabled="page >= pages" @click="page++">{{ panelText('I18nSettings.8a8542f696') }}</ElButton></div>
      </aside>
      <form v-if="selectedKey" class="i18n-detail" @submit.prevent="save">
        <h2>{{ selectedKey }}</h2><p v-if="selectedInfo">{{ selectedInfo.description }}<br /><code>{{ selectedInfo.source }}</code></p>
        <label for="i18n-default">{{ panelText('I18nSettings.5c37515097') }}</label><textarea id="i18n-default" :value="original" rows="6" readonly />
        <label for="i18n-draft">{{ panelText('I18nSettings.47d524c3bd') }}</label><textarea id="i18n-draft" v-model="draft" rows="8" :disabled="busy" />
        <div v-if="Object.keys(parameters).length"><h3>{{ panelText('I18nSettings.e887c32424') }}</h3><dl><template v-for="(expression, name) in parameters" :key="name"><dt><code>{{ '{' + name + '}' }}</code></dt><dd>{{ expression }}</dd></template></dl><p>{{ panelText('I18nSettings.5199aef712') }}</p></div>
        <div class="i18n-actions"><ElButton native-type="submit" type="primary" :loading="busy" :disabled="!dirty || busy">{{ panelText('I18nSettings.2788d4e5d9') }}</ElButton><ElButton :disabled="busy" @click="draft = original">{{ panelText('I18nSettings.25970f0c35') }}</ElButton></div>
        <p v-if="dirty" role="status">{{ panelText('I18nSettings.535083c5e5') }}</p>
      </form>
      <p v-else class="empty">{{ panelText('I18nSettings.64fb0b0373') }}</p>
    </div>
  </section>
</template>

<style scoped>
.i18n-apply { border: 1px solid #b78e39; padding: 1rem; margin-block: 1rem; }
.i18n-language { display: flex; flex-wrap: wrap; align-items: center; gap: .7rem; margin-block: 1.3rem; padding: 1rem; }
.i18n-language p { flex-basis: 100%; margin-bottom: 0; }
.i18n-editor { display: grid; grid-template-columns: minmax(240px, .9fr) minmax(300px, 1.4fr); gap: 1.6rem; align-items: start; }
.i18n-index, .i18n-detail { display: flex; flex-direction: column; gap: .6rem; min-width: 0; }
.i18n-actions { display: flex; flex-wrap: wrap; gap: .65rem; align-items: center; }
.i18n-keys { list-style: none; padding: 0; margin: 0; max-height: 60vh; overflow: auto; }
.i18n-keys button { display: grid; gap: .35rem; text-align: left; width: 100%; border: 1px solid var(--el-border-color, #aaa); background: transparent; color: inherit; padding: .7rem; cursor: pointer; }
.i18n-keys button.selected { border-color: #587aca; background: #587aca18; }
.i18n-keys code, .i18n-detail h2 { overflow-wrap: anywhere; }
.i18n-keys span { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 4em; overflow: hidden; }
.i18n-detail textarea { box-sizing: border-box; width: 100%; resize: vertical; font: inherit; }
.i18n-detail dl { display: grid; grid-template-columns: auto 1fr; gap: .5rem 1rem; }
.i18n-detail dd { margin: 0; overflow-wrap: anywhere; }
@media (max-width: 760px) { .i18n-editor { grid-template-columns: 1fr; } .i18n-keys { max-height: 35vh; } }
</style>
