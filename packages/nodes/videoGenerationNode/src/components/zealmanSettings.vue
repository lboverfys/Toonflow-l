<template>
  <section class="zealmanSettings nodrag nopan nowheel" aria-label="U06 快捷生成设置" @pointerdown.stop @mousedown.stop @dblclick.stop @keydown.stop @wheel.stop>
    <div class="settingsHeader">
      <span>U06 快捷生成</span>
      <el-button text size="small" :loading="loading" :disabled="disabled" @click="emit('refresh')">刷新面板选项</el-button>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <template v-if="options">
      <div class="modelRow">
        <label class="settingField">
          <span>主模型 UNet</span>
          <el-select :modelValue="String(settings.modelKey)" filterable :disabled="disabled" aria-label="U06 主模型" @update:modelValue="update('modelKey', $event)">
            <el-option v-for="item in options.models" :key="item.key" :value="item.key" :label="choiceLabel(item)" :title="`${item.file}\n${item.note ?? ''}`">
              <span>{{ choiceLabel(item) }}</span>
            </el-option>
          </el-select>
        </label>
        <label class="settingField">
          <span>提示词编码器 CLIP</span>
          <el-select :modelValue="String(settings.clipKey)" filterable :disabled="disabled" aria-label="U06 提示词编码器" @update:modelValue="update('clipKey', $event)">
            <el-option v-for="item in options.clips" :key="item.key" :value="item.key" :label="choiceLabel(item)" :title="`${item.file}\n${item.note ?? ''}`" />
          </el-select>
        </label>
      </div>
      <div class="loraRow">
        <label class="settingField">
          <span>加速 LoRA</span>
          <el-select :modelValue="String(settings.loraKey)" filterable :disabled="disabled || !settings.accelerated" aria-label="U06 加速 LoRA" @update:modelValue="update('loraKey', $event)">
            <el-option v-for="item in options.loras" :key="item.key" :value="item.key" :label="choiceLabel(item)" :disabled="!!loraMismatch(item, selectedModel)" :title="loraMismatch(item, selectedModel) || item.file" />
          </el-select>
        </label>
        <label class="strengthField">
          <span>强度</span>
          <el-input-number :modelValue="Number(settings.loraStrength)" :min="0" :max="2" :step="0.05" :precision="2" :controls="false" :disabled="disabled || !settings.accelerated" aria-label="加速 LoRA 强度" @update:modelValue="update('loraStrength', $event)" />
        </label>
        <label class="settingField">
          <span>额外 LoRA</span>
          <el-select :modelValue="String(settings.extraLoraKey)" filterable :disabled="disabled" aria-label="U06 额外 LoRA" @update:modelValue="update('extraLoraKey', $event)">
            <el-option v-for="item in options.loras" :key="item.key" :value="item.key" :label="item.key === 'none' ? '不使用额外 LoRA' : choiceLabel(item)" :disabled="!!loraMismatch(item, selectedModel)" :title="loraMismatch(item, selectedModel) || item.file" />
          </el-select>
        </label>
        <label class="strengthField">
          <span>强度</span>
          <el-input-number :modelValue="Number(settings.extraLoraStrength)" :min="0" :max="2" :step="0.05" :precision="2" :controls="false" :disabled="disabled || settings.extraLoraKey === 'none'" aria-label="额外 LoRA 强度" @update:modelValue="update('extraLoraStrength', $event)" />
        </label>
      </div>
      <div class="optionRow">
        <el-radio-group :modelValue="settings.accelerated === true" :disabled="disabled" aria-label="U06 加速模式" @update:modelValue="setAccelerated($event === true)">
          <el-radio-button :value="false">原版</el-radio-button>
          <el-radio-button :value="true">加速</el-radio-button>
        </el-radio-group>
        <el-checkbox :modelValue="settings.forceVramCleanupBeforeVae === true" :disabled="disabled" @update:modelValue="update('forceVramCleanupBeforeVae', $event)">VAE 前清理</el-checkbox>
        <el-switch :modelValue="settings.upscale === true" activeText="超清 2×" aria-label="RTX 超清 2 倍" :disabled="disabled || !options.rtxSupported" :title="options.rtxSupported ? '生成后以 RTX 放大 2 倍' : options.rtxReason" @update:modelValue="update('upscale', $event)" />
      </div>
      <div class="outputRow">
        <label class="ratioField"><span>比例</span><el-select v-model="ratio" :disabled="disabled" aria-label="U06 画面比例"><el-option v-for="item in options.ratios" :key="item" :value="item" :label="item" /></el-select></label>
        <label class="settingField"><span>分辨率</span><el-select v-model="resolution" :disabled="disabled" aria-label="U06 分辨率"><el-option v-for="item in options.resolutions" :key="item" :value="`${item}MP`" :label="`${zealmanSize(ratio, item)} · ${item}MP`" /></el-select></label>
        <label class="numberField"><span>时长（秒）</span><el-input-number v-model="duration" :min="1" :max="options.maxDuration" :precision="0" :controls="false" :disabled="disabled" aria-label="U06 视频时长" /></label>
        <label class="numberField"><span>采样步数</span><el-input-number :modelValue="Number(settings.steps)" :min="1" :max="99" :precision="0" :controls="false" :disabled="disabled" aria-label="U06 采样步数" @update:modelValue="update('steps', $event)" /></label>
      </div>
      <div class="seedRow">
        <el-radio-group :modelValue="seed == null ? 'random' : 'fixed'" :disabled="disabled" aria-label="U06 种子模式" @update:modelValue="seed = $event === 'random' ? null : options.defaults.seed">
          <el-radio-button value="random">随机种子</el-radio-button><el-radio-button value="fixed">固定种子</el-radio-button>
        </el-radio-group>
        <el-input-number v-if="seed != null" v-model="seed" :min="0" :max="Number.MAX_SAFE_INTEGER" :precision="0" :controls="false" :disabled="disabled" aria-label="U06 固定种子" />
        <span v-else class="hint">每次生成随机取值，恢复任务沿用原值</span>
      </div>
      <div v-if="selectionError" class="selectionError" role="alert">{{ selectionError }}</div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { ElAlert, ElButton, ElCheckbox, ElInputNumber, ElOption, ElRadioButton, ElRadioGroup, ElSelect, ElSwitch } from "element-plus";
import { zealmanSelectionError, loraMismatch, zealmanSize, type ZealmanChoice, type ZealmanOptions } from "../zealmanOptions";

const props = defineProps<{ disabled?: boolean; options?: ZealmanOptions; loading: boolean; error: string }>();
const emit = defineEmits<{ refresh: [] }>();
const settings = defineModel<Record<string, unknown>>({ required: true });
const ratio = defineModel<string>("ratio", { required: true });
const resolution = defineModel<string>("resolution", { required: true });
const duration = defineModel<number | undefined>("duration", { required: true });
const seed = defineModel<number | null | undefined>("seed", { required: true });
const selectedModel = computed(() => props.options?.models.find(item => item.key === settings.value.modelKey));
const selectionError = computed(() => props.options ? zealmanSelectionError(settings.value, props.options) : "");

function choiceLabel(item: ZealmanChoice) {
  const mark = ({ full: "完整", pruned: "剪枝", none: "通用" } as Record<string, string>)[item.adaln ?? ""];
  const name = item.file?.split("/").at(-1)?.replace(/\.safetensors$/, "") ?? item.label;
  return `${name}${item.sizeGB ? ` · ${item.sizeGB}G` : ""}${mark ? ` · ${mark}` : ""}${item.author ? ` · ${item.author}` : ""}`;
}
function update(key: string, value: unknown) { settings.value = { ...settings.value, [key]: value }; }
function setAccelerated(value: boolean) {
  settings.value = { ...settings.value, accelerated: value, steps: value ? props.options!.acceleratedSteps : props.options!.originalSteps };
}
</script>

<style scoped lang="scss">
.zealmanSettings {
  container-type: inline-size;
  display: grid;
  gap: 12px;
  margin: 10px 0 14px;
  padding: 14px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 12px;
  background: var(--el-fill-color-extra-light);
  .settingsHeader { display: flex; align-items: center; justify-content: space-between; font-size: 13px; font-weight: 600; }
  .modelRow { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .loraRow { display: grid; grid-template-columns: minmax(0, 1fr) 72px minmax(0, 1fr) 72px; gap: 8px; }
  .outputRow { display: grid; grid-template-columns: 85px minmax(0, 1fr) 86px 82px; gap: 8px; }
  .modelRow, .loraRow, .outputRow {
    label { display: grid; gap: 5px; min-width: 0; font-size: 11px; color: var(--el-text-color-secondary); }
    :deep(.el-select), :deep(.el-input-number) { width: 100%; }
  }
  .optionRow, .seedRow { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
  .seedRow { :deep(.el-input-number) { width: 230px; } .hint { font-size: 11px; color: var(--el-text-color-secondary); } }
  .selectionError { color: var(--el-color-danger); font-size: 12px; }
  @container (max-width: 600px) {
    .modelRow { grid-template-columns: 1fr; }
    .loraRow { grid-template-columns: minmax(0, 1fr) 72px; }
    .outputRow { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
}
</style>
