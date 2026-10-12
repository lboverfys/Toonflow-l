<template>
  <el-dialog v-model="visible" title="处理画布修改" width="min(900px, calc(100vw - 32px))" appendToBody :closeOnClickModal="false" :closeOnPressEscape="!busy" :showClose="!busy">
    <div class="canvasConflict">
      <p class="canvasPath">{{ path }}</p>
      <el-alert :title="conflict.message" type="warning" :closable="false" />
      <p v-if="recoveryPath" class="recoveryNotice">本机未合并内容已保存为恢复草稿：{{ recoveryPath }}</p>
      <el-alert v-if="recoveryError || error" :title="recoveryError || error" type="error" :closable="false" />
      <div v-for="field in conflict.fields" :key="field.key" class="conflictField">
        <strong>{{ field.label }}</strong>
        <el-radio-group v-model="choices[field.key]" :disabled="busy" :aria-label="field.label + '保留版本'">
          <el-radio value="local">保留本机修改</el-radio><el-radio value="remote">保留主机版本</el-radio>
        </el-radio-group>
        <div class="versions"><div><small>本机修改</small><pre>{{ formatValue(field.local) }}</pre></div><div><small>主机版本</small><pre>{{ formatValue(field.remote) }}</pre></div></div>
      </div>
    </div>
    <template #footer>
      <div class="conflictActions">
        <el-button :disabled="busy" @click="visible = false">稍后处理</el-button>
        <el-button :disabled="busy" @click="resolveChanges(true)">保存本机副本并采用主机版本</el-button>
        <el-button type="primary" :loading="busy" :disabled="conflict.fields.some(field => !choices[field.key])" @click="resolveChanges(false)">合并并保存</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { sameCanvasValue, type CanvasConflict } from "@toonflow/server/canvasMerge";
const props = defineProps<{ path: string; conflict: { fields: CanvasConflict[]; message: string }; recoveryPath: string; recoveryError: string; busy: boolean;
  resolve: (choices: Record<string, "local" | "remote">, useRemote: boolean) => Promise<void> }>();
const visible = defineModel<boolean>({ default: false });
const choices = ref<Record<string, "local" | "remote">>({});
const error = ref("");
watch(() => props.conflict, (value, previous) => {
  if (!sameCanvasValue(value.fields, previous.fields)) choices.value = {};
  error.value = "";
});
const formatValue = (value: unknown) => value === undefined ? "已删除" : typeof value === "string" ? value : JSON.stringify(value, null, 2);
async function resolveChanges(useRemote: boolean) {
  error.value = "";
  try { await props.resolve(choices.value, useRemote); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : "冲突处理失败，修改仍然保留"; }
}
</script>

<style scoped lang="scss">
.canvasConflict {
  display: grid; gap: 14px;
  .canvasPath, .recoveryNotice { margin: 0; overflow-wrap: anywhere; color: var(--el-text-color-secondary); }
  .conflictField { display: grid; gap: 8px; padding: 12px; border: 1px solid var(--el-border-color); border-radius: 8px;
    .versions { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px;
      pre { max-height: 200px; margin: 6px 0 0; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
    }
  }
}
.conflictActions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; .el-button { margin: 0; } }
</style>
