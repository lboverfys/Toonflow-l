import { nextTick, onScopeDispose, provide, shallowReactive, watch, type Ref } from "vue";
import type { Node, useVueFlow } from "@vue-flow/core";
import type { NodeHandle } from "@toonflow/nodes-scaffold/connection";
import type { NodeOutput } from "@toonflow/nodes-scaffold/values";
import type { NodeDocumentContext, NodeDocumentState } from "@toonflow/nodes-scaffold/nodeDocument";
import { useNodeToolsContext } from "@toonflow/nodes-scaffold/nodeTools";
import useWorkspaceFiles from "@/lib/workspaceFiles";
import type canvasMenu from "./components/canvasMenu.vue";

export function useDocumentNodes(options: {
  directory(): string | undefined;
  canvasId: Ref<string>;
  findNode: ReturnType<typeof useVueFlow>["findNode"];
  canvasDirty: Ref<boolean>;
  canvasSaveError: Ref<string>;
  nodeErrors: Ref<Record<string, string>>;
  flushCanvasSave(action?: () => Promise<void>): Promise<void>;
  signal(): AbortSignal;
  syncDocumentNode: InstanceType<typeof canvasMenu>["syncDocumentNode"];
}) {
  const { canvasId, findNode, canvasDirty, canvasSaveError, nodeErrors, flushCanvasSave } = options;
  const getNodeTools = useNodeToolsContext();
  const nodeDocument: NodeDocumentContext = { targets: shallowReactive(new Map()), mounts: new Map(), states: shallowReactive(new Map()) };
  const documentObservers = new Set<() => void>();
  onScopeDispose(() => { for (const release of documentObservers) release(); });
  provide("nodeDocument", nodeDocument);

  type DocumentNodeData = { label?: string; handles?: NodeHandle[]; outputs?: Record<string, NodeOutput | undefined>; textPath?: string };

  function checkDocumentDirectory(directory: string) {
    if (!directory || directory !== options.directory()) throw new Error("工作目录已切换，请重新打开节点");
  }

  function observeDocumentNode(directory: string, canvasPath: string, nodeId: string, onState: (state: NodeDocumentState) => void) {
    checkDocumentDirectory(directory);
    if (canvasId.value !== canvasPath || !findNode(nodeId)) throw new Error("节点不存在，请刷新文件树");
    const stop = watch((): NodeDocumentState => {
      const node = findNode(nodeId);
      const state = nodeDocument.states.get(nodeId);
      return { dirty: !!node && (canvasDirty.value || !!state?.dirty),
        error: state?.error || canvasSaveError.value || (node && nodeErrors.value[node.type]) || "", deleted: !node };
    }, onState, { immediate: true, flush: "sync" });
    const release = () => { stop(); documentObservers.delete(dispose); };
    const dispose = () => { onState({ dirty: false, error: "", deleted: true }); release(); };
    documentObservers.add(dispose);
    return {
      release,
      async flushSave() {
        checkDocumentDirectory(directory);
        if (!findNode(nodeId)) throw new Error("节点已删除，请刷新文件树");
        await flushCanvasSave();
      },
    };
  }

  async function mountDocumentNode(directory: string, canvasPath: string, nodeId: string, target: HTMLElement) {
    checkDocumentDirectory(directory);
    if (canvasId.value !== canvasPath) throw new Error("画布已切换，请重新打开节点");
    await nextTick();
    checkDocumentDirectory(directory);
    const node = findNode(nodeId);
    if (!node) throw new Error("节点已删除，请刷新文件树");
    if (nodeErrors.value[node.type]) throw new Error(nodeErrors.value[node.type]);
    const mount = nodeDocument.mounts.get(nodeId);
    if (!mount) throw new Error("当前节点未提供文档视图，请确认节点正常加载并更新节点插件");
    const release = mount(target);
    try {
      await nextTick();
      checkDocumentDirectory(directory);
      if (!target.isConnected || !target.querySelector(".documentNode")) throw new Error("节点文档视图加载失败，请重新打开节点");
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }

  function documentHandles(node: Node<DocumentNodeData>) {
    const handles = node.data?.handles;
    if (Array.isArray(handles) && handles.length) {
      return handles.filter(
        (handle) =>
          handle &&
          typeof handle.id === "string" &&
          handle.type === "source" &&
          (Array.isArray(handle.dataType) ? handle.dataType.includes("STRING") : handle.dataType === "STRING")
      );
    }
    return Object.entries(node.data?.outputs ?? {}).flatMap(([id, output]) => (output?.dataType === "STRING" ? [{ id, label: id }] : []));
  }

  async function readDocumentCanvas(directory: string, canvasPath: string, nodeId: string) {
    checkDocumentDirectory(directory);
    const files = useWorkspaceFiles(directory);
    const canvas = await files.readJson<{ toonflowCanvas?: boolean; nodes?: Node<DocumentNodeData>[] }>(canvasPath);
    checkDocumentDirectory(directory);
    if (canvas?.toonflowCanvas !== true || !Array.isArray(canvas.nodes)) throw new Error("文件不是有效画布");
    const node = canvas.nodes.find((item) => item && item.id === nodeId);
    if (!node) throw new Error("节点已删除，请刷新文件树");
    if (node.data !== undefined && (!node.data || typeof node.data !== "object" || Array.isArray(node.data))) throw new Error("节点数据无效");
    const liveNode = canvasId.value === canvasPath ? findNode(nodeId) : undefined;
    if (canvasId.value === canvasPath && !liveNode) throw new Error("节点已删除，请刷新文件树");
    const textPath = node.data?.textPath;
    if (
      textPath !== undefined &&
      (typeof textPath !== "string" ||
        !textPath.trim() ||
        /^(?:[a-z][a-z\d+.-]*:|[\\/])/i.test(textPath) ||
        textPath.includes("\0") ||
        textPath.split(/[\\/]/).includes(".."))
    )
      throw new Error("文本文件路径必须位于工作区内");
    return { files, canvas, node, liveNode, textPath };
  }

  async function readDocumentNode(directory: string, canvasPath: string, nodeId: string) {
    checkDocumentDirectory(directory);
    await flushCanvasSave();
    const { files, node, liveNode, textPath } = await readDocumentCanvas(directory, canvasPath, nodeId);
    const source = liveNode ?? node;
    const handles = documentHandles(source);
    const storedText = textPath === undefined ? undefined : await files.readText(textPath);
    checkDocumentDirectory(directory);
    return {
      label: typeof source.data?.label === "string" ? source.data.label : nodeId,
      outputs: handles.map((handle) => {
        const output = source.data?.outputs?.[handle.id];
        return {
          id: handle.id,
          label: handle.label || handle.id,
          text: output?.dataType === "STRING" && typeof output.value === "string" ? output.value : storedText ?? "",
        };
      }),
    };
  }

  async function saveDocumentNode(directory: string, canvasPath: string, nodeId: string, handleId: string, text: string, expectedText?: string) {
    checkDocumentDirectory(directory);
    await flushCanvasSave(async () => {
      const { files, canvas, node, liveNode, textPath } = await readDocumentCanvas(directory, canvasPath, nodeId);
      if (!documentHandles(liveNode ?? node).some((handle) => handle.id === handleId)) throw new Error("文本输出已删除，请重新打开节点");
      if (expectedText !== undefined) {
        const output = (liveNode ?? node).data?.outputs?.[handleId];
        const currentText = output?.dataType === "STRING" && typeof output.value === "string" ? output.value : textPath === undefined ? "" : await files.readText(textPath);
        if (currentText !== expectedText) throw new Error("文档内容已变化，请重新读取后编辑");
      }
      if (liveNode?.type === "remote-textNode") {
        await getNodeTools().call({ nodeId, name: "node:setText", args: { text } }, options.signal());
        checkDocumentDirectory(directory);
        // 节点工具已同步输出并排队保存；等待期间用户可能继续编辑，不能再写入旧文本快照。
        return;
      }
      if (liveNode && canvasId.value === canvasPath && findNode(nodeId) === liveNode) {
        const output = liveNode.data.outputs?.[handleId];
        if (output?.dataType === "STRING") output.value = text;
        else if (textPath === undefined) (liveNode.data.outputs ??= {})[handleId] = { dataType: "STRING", value: text };
      }
      options.syncDocumentNode(canvasPath, nodeId, handleId, text, textPath === undefined);
      if (textPath !== undefined) {
        await files.write(textPath, text);
      } else {
        const data = (node.data ??= {});
        const output = data.outputs?.[handleId];
        if (output?.dataType === "STRING") output.value = text;
        else (data.outputs ??= {})[handleId] = { dataType: "STRING", value: text };
        await files.writeJson(canvasPath, canvas);
      }
      checkDocumentDirectory(directory);
    });
  }
  return { observeDocumentNode, mountDocumentNode, readDocumentNode, saveDocumentNode };
}
