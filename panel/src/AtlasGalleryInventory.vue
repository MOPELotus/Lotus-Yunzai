<script setup lang="ts">
import { ElButton } from "element-plus";
import { onBeforeUnmount, ref } from "vue";
import { panelFetch, type PanelAuth } from "./api.ts";

const props = defineProps<{ auth: PanelAuth }>();
const emit = defineEmits<{ unauthorized: [] }>();
const gameNames = { gi: "原神", hsr: "星铁", zzz: "绝区零" } as const;
type Row = { game: keyof typeof gameNames; images: number; bytes: number };
type Inventory = { version: number | null; rows: Row[] };
const inventory = ref<Inventory>();
const busy = ref(false);
const error = ref("");
const format = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });
let active: AbortController | undefined;

function imageSize(bytes: number) {
  if (bytes >= 1024 ** 3) return `${format.format(bytes / 1024 ** 3)} GiB`;
  if (bytes >= 1024 ** 2) return `${format.format(bytes / 1024 ** 2)} MiB`;
  if (bytes >= 1024) return `${format.format(bytes / 1024)} KiB`;
  return `${format.format(bytes)} B`;
}

async function load() {
  if (active) return;
  const controller = new AbortController();
  active = controller;
  busy.value = true;
  error.value = "";
  try {
    const response = await panelFetch(`${import.meta.env.BASE_URL}api/settings/atlas/gallery`, props.auth, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
    });
    if (active !== controller) return;
    if (response.status === 401) return emit("unauthorized");
    if (!response.ok) throw new Error();
    const result = await response.json() as Inventory;
    if (active === controller) inventory.value = result;
  } catch {
    if (active === controller) {
      inventory.value = undefined;
      error.value = "暂时无法读取图鉴图库，请确认图鉴已初始化后重试。";
    }
  } finally {
    if (active === controller) {
      active = undefined;
      busy.value = false;
    }
  }
}

onBeforeUnmount(() => {
  active?.abort();
  active = undefined;
});
</script>

<template>
  <section class="atlas-inventory" aria-labelledby="atlas-gallery-title" :aria-busy="busy">
    <div class="inventory-heading">
      <div>
        <h2 id="atlas-gallery-title">图鉴图库</h2>
        <p v-if="inventory?.version">快照版本 {{ inventory.version }}</p>
      </div>
      <ElButton :loading="busy" :disabled="busy" @click="load">读取图库统计</ElButton>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <table v-if="inventory" aria-labelledby="atlas-gallery-title">
      <thead>
        <tr><th scope="col">游戏</th><th scope="col">图片数</th><th scope="col">大小</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in inventory.rows" :key="row.game">
          <th scope="row">{{ gameNames[row.game] }}</th>
          <td>{{ format.format(row.images) }}</td>
          <td>{{ imageSize(row.bytes) }}</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
.atlas-inventory {
  max-width: 660px;
  margin-top: 20px;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 13px;
  background: var(--surface);
}
.inventory-heading { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; }
h2 { margin: 0; font-size: 17px; font-weight: 650; }
.inventory-heading p { color: var(--muted); font-size: 14px; margin: 4px 0 0; }
table { width: 100%; border-collapse: collapse; margin-top: 13px; }
th, td { border-top: 1px solid var(--line); padding: 8px 0; text-align: right; }
th:first-child { text-align: left; }
th[scope="row"] { font-weight: 400; }
</style>
