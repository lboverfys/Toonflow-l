<template>
  <div v-if="available" class="clientFilesControl">
    <template v-if="authorized">
      <span class="directoryName" :title="authorized.name">本机只读：{{ authorized.name }}</span>
      <el-button link :disabled="revoking" @click="revokeDirectory">撤销授权</el-button>
    </template>
    <el-button v-else text :disabled="disabled || pending || revoking" :loading="pending" @click="selectDirectory">授权本机文件夹</el-button>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { translate } from "@toonflow/i18n/core";
import type { ClientFileDirectory, ClientFileResult } from "@toonflow/tools-scaffold/runtime";
import type { AgentEvent } from "@toonflow/server/agent/types";

const props = defineProps<{ disabled: boolean; visible: boolean }>();
const emit = defineEmits<{ revoked: [] }>();
const query = new URLSearchParams(window.location.search);
const available = query.get("desktop") === "1" && query.get("remote") === "1";
const scopeId = crypto.randomUUID();
const authorized = ref<ClientFileDirectory>();
const pending = ref(false);
const revoking = ref(false);
let disposed = false;
let renewal: ReturnType<typeof setInterval> | undefined;
let run: { runId: string; directory: ClientFileDirectory } | undefined;

async function nativePost<T>(operation: "grant" | "revoke" | "renew" | "run" | "execute", body: object, signal?: AbortSignal, keepalive = false): Promise<T> {
  const timeout = operation === "grant" ? undefined : AbortSignal.timeout(20000);
  const signals = [signal, timeout].filter((value): value is AbortSignal => !!value);
  const response = await fetch(`/api/desktop/clientFiles/${operation}`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-toonflow-desktop": "1" },
    body: JSON.stringify({ scopeId, ...body }), signal: signals.length ? AbortSignal.any(signals) : undefined, keepalive,
  });
  const result = await response.json();
  if (!response.ok || result.code !== 200) throw new Error(result.message || translate("本机文件操作失败"));
  return result.data;
}

async function revokeDirectory() {
  clearInterval(renewal);
  authorized.value = undefined;
  emit("revoked");
  revoking.value = true;
  try { await nativePost("revoke", {}); }
  catch (error) { ElMessage.error(`${translate("已停止读取，目录授权将在 90 秒内失效。撤销请求失败：")}${error instanceof Error ? error.message : String(error)}`); }
  finally { revoking.value = false; }
}

async function selectDirectory() {
  pending.value = true;
  try {
    await ElMessageBox.confirm(translate("选择后，本聊天的 AI 可以只读访问该文件夹及子目录。读取的文本会传到共享主机和模型，并可能保存在共享聊天记录中。"), translate("授权本机文件夹"), {
      confirmButtonText: translate("选择文件夹"), cancelButtonText: translate("取消"), type: "info",
    });
    if (disposed || !props.visible) return;
    const directory = await nativePost<ClientFileDirectory | null>("grant", {});
    if (!directory) return;
    if (disposed || !props.visible) { await nativePost("revoke", {}); return; }
    authorized.value = directory;
    renewal = setInterval(() => {
      void nativePost("renew", { id: directory.id }).catch(error => {
        if (authorized.value?.id !== directory.id) return;
        ElMessage.error(error instanceof Error ? error.message : translate("本机目录授权已失效"));
        void revokeDirectory();
      });
    }, 30000);
  } catch (error) {
    if (error !== "cancel" && error !== "close" && !disposed) ElMessage.error(error instanceof Error ? error.message : translate("授权本机目录失败"));
  } finally { pending.value = false; }
}

async function start(signal: AbortSignal) {
  if (!authorized.value) return;
  run = { runId: crypto.randomUUID(), directory: { ...authorized.value } };
  await nativePost("run", { id: run.directory.id, runId: run.runId, active: true }, signal);
  signal.throwIfAborted();
  return run;
}

async function execute(event: Extract<AgentEvent, { type: "clientFileCall" }>, signal: AbortSignal) {
  if (!run || run.runId !== event.runId || run.directory.id !== event.directoryId || authorized.value?.id !== event.directoryId) {
    throw new Error(translate("本机文件请求不属于当前聊天或授权已撤销"));
  }
  const result = await nativePost<ClientFileResult>("execute", { id: event.directoryId, runId: event.runId, request: event.request }, signal);
  signal.throwIfAborted();
  if (authorized.value?.id !== event.directoryId || run?.runId !== event.runId) throw new Error(translate("本机目录授权已撤销"));
  return result;
}

async function stop() {
  const current = run;
  run = undefined;
  if (!current || authorized.value?.id !== current.directory.id) return;
  try { await nativePost("run", { id: current.directory.id, runId: current.runId, active: false }, undefined, true); }
  catch (error) {
    if (disposed) return;
    ElMessage.error(error instanceof Error ? error.message : translate("结束本机文件读取失败"));
    await revokeDirectory();
  }
}

function dispose() {
  if (disposed) return;
  disposed = true;
  clearInterval(renewal);
  emit("revoked");
  if (authorized.value || pending.value) {
    void nativePost("revoke", {}, undefined, true).catch(error => console.warn("撤销本机目录授权失败，将等待授权过期：", error));
  }
  authorized.value = undefined;
}

window.addEventListener("pagehide", dispose);
watch(() => props.visible, visible => {
  if (!visible && (authorized.value || pending.value)) void revokeDirectory();
});
onBeforeUnmount(() => { window.removeEventListener("pagehide", dispose); dispose(); });
defineExpose({ pending, authorized, start, execute, stop });
</script>

<style scoped lang="scss">
.clientFilesControl {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 0 4px;

  .directoryName {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
    color: var(--el-text-color-secondary);
  }
}
</style>
