<script setup lang="ts">
import { panelText } from './i18n.ts';

import { computed, ref } from "vue";
import { ElButton } from "element-plus";

const fields = [
  { key: "special", label: panelText('GroupWarpSettings.d8df41f12e'), min: 0, max: 10_000 },
  { key: "regular", label: panelText('GroupWarpSettings.caab68b6bc'), min: 0, max: 10_000 },
  { key: "recallSeconds", label: panelText('GroupWarpSettings.30d31a25ad'), min: 0, max: 120 },
] as const;
type AllowanceKey = typeof fields[number]["key"];
type Allowance = Partial<Record<AllowanceKey, number | string>>;
type Groups = Record<string, Allowance>;

const props = defineProps<{ disabled: boolean; allowance: Allowance }>();
const groups = defineModel<Groups>({ required: true });
const groupId = ref("");
const scope = ref("");
const other = computed(() => groupId.value.trim());
const canSelect = computed(() => /^[1-9]\d{0,15}$/u.test(other.value) && Number.isSafeInteger(Number(other.value)));
const choices = computed(() => [...new Set([...Object.keys(groups.value), ...(scope.value ? [scope.value] : [])])]);
const current = computed(() => groups.value[scope.value]);

function setField(key: AllowanceKey, event: Event) {
  const input = event.target as HTMLInputElement;
  const next = { ...current.value };
  if (input.value === "") delete next[key];
  else next[key] = input.valueAsNumber;
  const changed = { ...groups.value };
  if (Object.keys(next).length) changed[scope.value] = next;
  else delete changed[scope.value];
  groups.value = changed;
}

function clearGroup() {
  const next = { ...groups.value };
  delete next[scope.value];
  groups.value = next;
}
</script>

<template>
  <fieldset class="warp-groups" :disabled="props.disabled">
    <legend>{{ panelText('GroupWarpSettings.0d7583d991') }}</legend>
    <div class="warp-row">
      <label>{{ panelText('GroupWarpSettings.3f7a035931') }}
        <select v-model="scope">
          <option value="">{{ panelText('GroupWarpSettings.ad7025f890') }}</option>
          <option v-for="id in choices" :key="id" :value="id">{{ id }}</option>
        </select>
      </label>
      <label>{{ panelText('GroupWarpSettings.f5d8b09091') }}
        <input v-model="groupId" inputmode="numeric" maxlength="16">
      </label>
      <ElButton :disabled="!canSelect || props.disabled" @click="scope = other">{{ panelText('GroupWarpSettings.fab4a63cc5') }}</ElButton>
    </div>
    <p class="warp-hint">{{ panelText('GroupWarpSettings.f88c7ea90a') }}</p>
    <div v-if="scope" class="warp-fields">
      <label v-for="field in fields" :key="field.key">{{ field.label }}
        <input :value="current?.[field.key]" type="number" :min="field.min" :max="field.max" step="1"
          :placeholder="String(props.allowance[field.key] ?? '')" @input="setField(field.key, $event)">
      </label>
      <div>
        <ElButton :disabled="!current || props.disabled" @click="clearGroup">{{ panelText('GroupWarpSettings.a942355f91') }}</ElButton>
      </div>
    </div>
  </fieldset>
</template>

<style scoped>
.warp-groups { display: grid; gap: 12px; min-width: 0; margin: 0; padding: 12px; border: 1px solid var(--el-border-color); border-radius: 4px; }
legend { padding: 0 4px; font-weight: 600; }
.warp-row, .warp-fields { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 150px), 1fr)); }
.warp-row { align-items: end; }
label { display: grid; gap: 6px; }
input, select { width: 100%; min-width: 0; min-height: 34px; padding: 6px 9px; color: var(--el-text-color-primary); background: var(--el-fill-color-blank); border: 1px solid var(--el-border-color); border-radius: 4px; font: inherit; }
.warp-hint { margin: 0; color: var(--el-text-color-secondary); font-size: .875rem; overflow-wrap: anywhere; }
</style>
