import { computed, defineAsyncComponent, markRaw, nextTick, onBeforeUnmount, onMounted, provide, ref, shallowReactive, shallowRef, type Component } from "vue";
import type { NodeTypesObject, useVueFlow } from "@vue-flow/core";
import axios from "axios";
import { ElMessage } from "element-plus";
import * as vueRuntime from "vue";
import * as vueFlowRuntime from "@vue-flow/core";
import * as elementPlusRuntime from "element-plus";
import type * as threeRuntime from "three";
import { runAgentLoop } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { useNodeEvent } from "@toonflow/nodes-scaffold/nodeEvent";
import groupNode from "./components/groupNode.vue";
import { loadNodeComponent } from "./loadNodeComponent";

export function useRemoteNodes(flow: ReturnType<typeof useVueFlow>, options: { signal(): AbortSignal; revision(): number }) {
  const nodeTypes = shallowRef<NodeTypesObject>({ canvasGroup: markRaw(groupNode) });
  const nodeConfigs = shallowRef<Record<string, Record<string, unknown>>>({});
  const nodeOptions = ref<{ type: string; label: string }[]>([]);
  const nodeLoads = shallowReactive(new Map<string, Promise<void>>());
  const nodeReloads = new Set<string>();
  const nodeErrors = ref<Record<string, string>>({});
  const availableNodes = computed(() => nodeOptions.value.filter(node => nodeTypes.value[node.type] && !nodeErrors.value[node.type]));
  const nodeListLoading = ref(true);
  const remoteNodeTypes = computed(() => [
    ...new Set(flow.nodes.value.map(item => item.type).filter((type): type is string => !!type?.startsWith("remote-"))),
  ]);
  let loadRequest = 0;

  const nodeWindow = window as typeof window & {
    toonflowNodeHost?: { vue: typeof vueRuntime; vueFlow: typeof vueFlowRuntime; elementPlus: typeof elementPlusRuntime; three?: typeof threeRuntime; ai: { runAgentLoop: typeof runAgentLoop; createAssistantMessageEventStream: typeof createAssistantMessageEventStream } };
    toonflowNodes?: NodeTypesObject;
  };
  nodeWindow.toonflowNodeHost ??= { vue: vueRuntime, vueFlow: vueFlowRuntime, elementPlus: elementPlusRuntime, ai: { runAgentLoop, createAssistantMessageEventStream } };
  provide("nodeConfig", (nodeType: string) => nodeConfigs.value[nodeType] ?? {});

  provide("reloadRemoteNode", (type: string) => {
    const name = type.replace(/^remote-/, "");
    if (!type.startsWith("remote-") || !/^[a-z][a-zA-Z0-9]*$/.test(name)) throw new Error("节点类型无效");
    return loadNode(name, `/api/nodes/files?name=${name}`, true);
  });

  async function loadNode(name: string, url: string, force = false): Promise<void> {
    const nodeType = `remote-${name}`;
    const signal = options.signal();
    const pending = nodeLoads.get(nodeType);
    if (pending) {
      if (!force) return pending;
      await pending.catch(() => {});
    }
    if (!force && nodeTypes.value[nodeType] && !(nodeTypes.value[nodeType] as { __asyncLoader?: unknown }).__asyncLoader && !nodeErrors.value[nodeType]) return;
    if (force) {
      signal.throwIfAborted();
      // ACT: 复用画布修订号收敛等待期间的编辑；持续修改画布时延后刷新，不额外维护节点修订状态。
      let revision: number;
      do {
        revision = options.revision();
        await Promise.all(flow.getNodes.value.filter(node => node.type === nodeType).map(node => useNodeEvent(node.id, flow).emit("save", "reload")));
        await nextTick();
        signal.throwIfAborted();
      } while (revision !== options.revision());
      const loading = nodeLoads.get(nodeType);
      if (loading) return loading;
    }
    delete nodeErrors.value[nodeType];
    const nodeLoad = loadNodeComponent(name, url, force)
      .then((remoteNode) => {
        // 同类型节点共享组件，运行错误由每个节点自己的边界显示。
        nodeTypes.value = { ...nodeTypes.value, [nodeType]: markRaw(remoteNode) };
      })
      .catch((error) => {
        nodeErrors.value[nodeType] = error instanceof Error ? error.message : String(error);
        throw error;
      })
      .finally(() => nodeLoads.delete(nodeType));
    nodeLoads.set(nodeType, nodeLoad);
    return nodeLoad;
  }

  async function ensureNodeType(type: string) {
    const component = nodeTypes.value[type] as { __asyncLoader?: () => Promise<unknown> } | undefined;
    if (!component) throw new Error("节点类型未启用");
    await component.__asyncLoader?.();
  }

  async function prepareNodeMenu() {
    await Promise.all(availableNodes.value.map(node => ensureNodeType(node.type)));
  }

  async function loadRemoteNodes(reloadName?: string) {
    if (reloadName) nodeReloads.add(reloadName);
    const requestId = ++loadRequest;
    const signal = options.signal();
    nodeListLoading.value = true;
    try {
      const { data } = await axios.get<{ code: number; data: { name: string; displayName: string; url: string; revision?: string; enabled?: boolean; config?: Record<string, unknown> }[] }>(
        "/api/nodes/get",
        { headers: { "Cache-Control": "no-cache", "x-toonflow-workspace": "1" } }
      );
      if (requestId !== loadRequest) return;
      if (data.code !== 200 || !Array.isArray(data.data)) throw new Error("节点列表格式错误");
      const nodes = data.data.filter(node => {
        if (!node || typeof node.name !== "string" || !/^[a-z][a-zA-Z0-9]*$/.test(node.name) || node.url !== `/api/nodes/files?name=${node.name}`) {
          console.error("节点地址无效", node);
          return false;
        }
        return true;
      });
      nodeConfigs.value = Object.fromEntries(nodes.map(node => [`remote-${node.name}`, node.config ?? {}]));
      const enabledNodes = nodes.filter(node => node.enabled !== false);
      // 节点各自加载完成后即可出现在菜单中，不等待其他节点的脚本。
      nodeOptions.value = enabledNodes.map(node => ({ type: `remote-${node.name}`, label: node.displayName }))
        .sort((left, right) => left.type.localeCompare(right.type));
      // ACT: 安装事件合并到最新列表请求，避免连续更新不同节点时丢失较早的刷新名称。
      const reloadNames = new Set(nodeReloads);
      nodeReloads.clear();
      await Promise.all(
        enabledNodes.map(async (node) => {
          const nodeType = `remote-${node.name}`;
          const url = node.revision ? `${node.url}&revision=${encodeURIComponent(node.revision)}` : node.url;
          try {
            if (nodeTypes.value[nodeType] && !nodeErrors.value[nodeType] && !reloadNames.has(node.name)) return;
            if (!remoteNodeTypes.value.includes(nodeType) && !reloadNames.has(node.name)) {
              nodeTypes.value = { ...nodeTypes.value, [nodeType]: markRaw(defineAsyncComponent(async () => {
                await loadNode(node.name, url);
                return nodeTypes.value[nodeType] as Component;
              })) };
            } else await loadNode(node.name, url, reloadNames.has(node.name));
          } catch (error) {
            console.error("加载远端节点失败", node, error);
            // 保存拒绝时旧组件仍可用，不从节点菜单中移除；脚本加载错误仍排除。
            if (nodeTypes.value[nodeType] && !nodeErrors.value[nodeType]) {
              if (reloadNames.has(node.name) && !signal.aborted) ElMessage.warning({
                message: `${node.displayName}已安装，但当前节点无法刷新。请等待任务结束后，点击节点右上角的刷新按钮。`,
                grouping: true,
              });
            }
          }
        })
      );
    } catch (error) {
      if (requestId === loadRequest) console.error("获取远端节点列表失败", error);
    } finally {
      if (requestId === loadRequest) nodeListLoading.value = false;
    }
  }

  function refreshInstalled(event: WindowEventMap["toonflow:plugin-installed"]) {
    if (event.detail.type === "node") void loadRemoteNodes(event.detail.name);
  }
  const refreshNodeConfig = () => { void loadRemoteNodes(); };
  onMounted(() => {
    window.addEventListener("toonflow:plugin-installed", refreshInstalled);
    window.addEventListener("toonflow:node-config-updated", refreshNodeConfig);
    void loadRemoteNodes();
  });
  onBeforeUnmount(() => {
    window.removeEventListener("toonflow:plugin-installed", refreshInstalled);
    window.removeEventListener("toonflow:node-config-updated", refreshNodeConfig);
    loadRequest++;
  });
  return { nodeTypes, nodeLoads, nodeErrors, nodeListLoading, remoteNodeTypes, availableNodes, ensureNodeType, prepareNodeMenu };
}
