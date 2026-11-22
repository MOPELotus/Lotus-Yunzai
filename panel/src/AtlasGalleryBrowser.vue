<script setup lang="ts">
import { ElButton } from "element-plus";
import { onBeforeUnmount, onMounted, ref } from "vue";
import { panelFetch, type PanelAuth } from "./api.ts";

const props = defineProps<{ auth: PanelAuth }>();
const emit = defineEmits<{ unauthorized: [] }>();
type Item = { path: string; bytes: number };
type BrowseResult = { version: number | null; folders: string[]; page: number; pages: number; total: number; items: Item[] };
const game = ref("gi");
const folder = ref("");
const filter = ref("");
const result = ref<BrowseResult>();
const selected = ref<Item>();
const thumbnail = ref("");
const browseError = ref("");
const previewError = ref("");
const loading = ref(false);
const previewing = ref(false);
const number = new Intl.NumberFormat("zh-CN");
const endpoint = `${import.meta.env.BASE_URL}api/settings/atlas/gallery`;
let browseRequest: AbortController | undefined;
let previewRequest: AbortController | undefined;

function clearPreview() {
  previewRequest?.abort();
  previewRequest = undefined;
  selected.value = undefined;
  thumbnail.value = "";
  previewError.value = "";
  previewing.value = false;
}

async function browse(page = 1) {
  browseRequest?.abort();
  clearPreview();
  const controller = new AbortController();
  browseRequest = controller;
  loading.value = true;
  browseError.value = "";
  const query = new URLSearchParams({ view: "browse", game: game.value, folder: folder.value, q: filter.value, page: String(page) });
  try {
    const response = await panelFetch(`${endpoint}?${query}`, props.auth, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
    });
    if (browseRequest !== controller) return;
    if (response.status === 401) return emit("unauthorized");
    if (!response.ok) throw new Error();
    const data = await response.json() as BrowseResult;
    if (browseRequest === controller) result.value = data;
  } catch {
    if (browseRequest === controller) {
      result.value = undefined;
      browseError.value = "暂时无法读取图库目录。";
    }
  } finally {
    if (browseRequest === controller) {
      browseRequest = undefined;
      loading.value = false;
    }
  }
}

function changeGame() {
  folder.value = "";
  result.value = undefined;
  void browse();
}

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error());
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function preview(item: Item) {
  if (!result.value) return;
  clearPreview();
  const controller = new AbortController();
  previewRequest = controller;
  previewing.value = true;
  selected.value = item;
  const query = new URLSearchParams({
    view: "preview", game: game.value, path: item.path, version: String(result.value.version),
  });
  try {
    const response = await panelFetch(`${endpoint}?${query}`, props.auth, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
    });
    if (previewRequest !== controller) return;
    if (response.status === 401) return emit("unauthorized");
    if (response.status === 409) {
      previewError.value = "图库快照已变更，请重新查询。";
      return;
    }
    if (!response.ok || response.headers.get("Content-Type") !== "image/png") throw new Error();
    const source = await dataUrl(await response.blob());
    if (previewRequest === controller) thumbnail.value = source;
  } catch {
    if (previewRequest === controller) previewError.value = "暂时无法预览这张图片。";
  } finally {
    if (previewRequest === controller) {
      previewRequest = undefined;
      previewing.value = false;
    }
  }
}

onMounted(() => void browse());
onBeforeUnmount(() => {
  browseRequest?.abort();
  browseRequest = undefined;
  clearPreview();
});
</script>

<template>
  <section class="atlas-gallery-browser" aria-labelledby="atlas-browser-title">
    <h3 id="atlas-browser-title">浏览当前图库</h3>
    <form class="gallery-filters" @submit.prevent="browse()">
      <label>游戏
        <select v-model="game" @change="changeGame">
          <option value="gi">原神</option>
          <option value="hsr">星铁</option>
          <option value="zzz">绝区零</option>
        </select>
      </label>
      <label>目录
        <select v-model="folder" :disabled="loading || !result?.folders.length" @change="browse()">
          <option value="">全部</option>
          <option v-for="name in result?.folders" :key="name">{{ name }}</option>
        </select>
      </label>
      <label>搜索
        <input v-model="filter" type="search" maxlength="100" placeholder="名称或路径" />
      </label>
      <ElButton native-type="submit" :loading="loading">查询</ElButton>
    </form>
    <p v-if="browseError" role="alert">{{ browseError }}</p>
    <template v-if="result">
      <p class="gallery-status" role="status">
        {{ result.version ? `快照 ${result.version} · ` : "" }}{{ number.format(result.total) }} 张
        <template v-if="result.total"> · 第 {{ result.page }} / {{ result.pages }} 页</template>
      </p>
      <p v-if="!result.total">没有符合条件的图片。</p>
      <div v-else class="gallery-browser-grid" :aria-busy="loading">
        <div>
          <ul class="gallery-file-list" aria-label="图片列表">
            <li v-for="item in result.items" :key="item.path">
              <button type="button" :disabled="loading" :aria-pressed="selected?.path === item.path" @click="preview(item)">
                {{ item.path }}
              </button>
            </li>
          </ul>
          <div v-if="result.pages > 1" class="gallery-pages">
            <ElButton :disabled="loading || result.page === 1" @click="browse(result.page - 1)">上一页</ElButton>
            <ElButton :disabled="loading || result.page === result.pages" @click="browse(result.page + 1)">下一页</ElButton>
          </div>
        </div>
        <figure v-if="selected" class="gallery-preview" :aria-busy="previewing">
          <figcaption>
            <strong>{{ selected.path }}</strong>
            <span>{{ number.format(selected.bytes) }} B</span>
          </figcaption>
          <p v-if="previewing" role="status">正在读取预览…</p>
          <p v-else-if="previewError" role="alert">{{ previewError }}</p>
          <img v-else-if="thumbnail" :src="thumbnail" :alt="`预览 ${selected.path}`" />
        </figure>
      </div>
    </template>
  </section>
</template>

<style scoped>
.atlas-gallery-browser { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--line); }
h3 { margin: 0 0 12px; font-size: 16px; }
.gallery-filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-end; }
.gallery-filters label { display: grid; gap: 4px; font-size: 13px; min-width: 0; }
.gallery-filters select, .gallery-filters input {
  font: inherit; min-height: 32px; max-width: 100%; border: 1px solid var(--line);
  border-radius: 6px; padding: 4px 8px; background: var(--surface); color: inherit;
}
.gallery-status, figcaption span { color: var(--muted); font-size: 13px; }
.gallery-browser-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
.gallery-file-list { display: grid; gap: 4px; list-style: none; margin: 0; padding: 0; }
.gallery-file-list button {
  width: 100%; border: 1px solid var(--line); border-radius: 6px; background: var(--surface);
  color: inherit; padding: 6px 8px; text-align: start; font: inherit; cursor: pointer; overflow-wrap: anywhere;
}
.gallery-file-list button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
.gallery-pages { margin-top: 8px; }
.gallery-preview { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.gallery-preview figcaption { display: grid; margin-bottom: 8px; }
.gallery-preview img { display: block; width: auto; height: auto; max-width: 100%; border-radius: 8px; }
@media (max-width: 640px) { .gallery-browser-grid { grid-template-columns: 1fr; } }
</style>
