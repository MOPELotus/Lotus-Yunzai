<script setup lang="ts">
import { computed, ref } from "vue";
import { ElButton } from "element-plus";

const fields = [
  { key: "special", label: "群每日专票数", min: 0, max: 10_000 },
  { key: "regular", label: "群每日通票数", min: 0, max: 10_000 },
  { key: "recallSeconds", label: "群结果图撤回延时（秒）", min: 0, max: 120 },
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
    <legend>按群覆盖</legend>
    <div class="warp-row">
      <label>编辑已有群
        <select v-model="scope">
          <option value="">选择群</option>
          <option v-for="id in choices" :key="id" :value="id">{{ id }}</option>
        </select>
      </label>
      <label>指定其他群号
        <input v-model="groupId" inputmode="numeric" maxlength="16">
      </label>
      <ElButton :disabled="!canSelect || props.disabled" @click="scope = other">编辑群</ElButton>
    </div>
    <p class="warp-hint">留空时继承全局设置。票数填 0 时停发该种票，已领余额保留。撤回填 0 时保留消息。</p>
    <div v-if="scope" class="warp-fields">
      <label v-for="field in fields" :key="field.key">{{ field.label }}
        <input :value="current?.[field.key]" type="number" :min="field.min" :max="field.max" step="1"
          :placeholder="String(props.allowance[field.key] ?? '')" @input="setField(field.key, $event)">
      </label>
      <div>
        <ElButton :disabled="!current || props.disabled" @click="clearGroup">移除此群覆盖</ElButton>
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
