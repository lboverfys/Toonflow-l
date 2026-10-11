import { nextTick } from "vue";
import { getTransformForBounds, type GraphEdge, type GraphNode, type Node, type useVueFlow } from "@vue-flow/core";
import { graphlib, layout } from "@dagrejs/dagre";
import { validateArrangeGroups, type CanvasArrangeGroup } from "./arrangePlan";

function getArrangeNodes(nodes: GraphNode[], nodesDraggable: boolean) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  if (byId.size !== nodes.length || nodes.some(node => !node.id)) throw new Error("画布存在无效或重复的节点 ID");
  const items = new Map<string, { node: GraphNode; position: { x: number; y: number }; selected: boolean }>();
  for (const node of nodes) {
    if (!(node.draggable ?? nodesDraggable)) throw new Error(`节点 ${node.id} 不允许移动`);
    if (node.dragging || node.resizing) throw new Error("请结束节点拖动或缩放后再整理");
    if (node.type === "canvasGroup" && node.deletable === false) throw new Error(`分组 ${node.id} 不允许重新划分`);
    if (node.extent && node.extent !== "parent") throw new Error(`节点 ${node.id} 设置了移动范围，无法重新分组`);
    const { width, height } = node.dimensions;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new Error(`节点 ${node.id} 尚未完成尺寸测量，请等待节点显示后重试`);
    }
    if (!Number.isFinite(node.position.x) || !Number.isFinite(node.position.y)) throw new Error(`节点 ${node.id} 的位置无效`);
    const position = { ...node.position };
    let selected = node.selected;
    const visited = new Set([node.id]);
    let parentId = node.parentNode;
    while (parentId) {
      const parent = byId.get(parentId);
      if (!parent || visited.has(parentId)) throw new Error(`节点 ${node.id} 的分组关系无效`);
      if (parent.type !== "canvasGroup") throw new Error(`节点 ${node.id} 属于插件内部层级，无法重新分组`);
      visited.add(parentId);
      position.x += parent.position.x;
      position.y += parent.position.y;
      selected ||= parent.selected;
      parentId = parent.parentNode;
    }
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) throw new Error(`节点 ${node.id} 的位置无效`);
    if (node.type !== "canvasGroup") items.set(node.id, { node, position, selected });
  }
  return items;
}

function arrangeGroup(group: CanvasArrangeGroup, items: ReturnType<typeof getArrangeNodes>, edges: GraphEdge[], degree: Map<string, number>) {
  const members = group.nodeIds.map(id => items.get(id)!);
  const pressure = Math.sqrt(Math.max(...group.nodeIds.map(id => degree.get(id) ?? 0)));
  const graph = new graphlib.Graph();
  graph.setGraph({ rankdir: "LR", nodesep: 180 + pressure * 24, ranksep: 320 + pressure * 40, edgesep: 40, marginx: 72, marginy: 96 });
  graph.setDefaultEdgeLabel(() => ({}));
  members.forEach(({ node }) => graph.setNode(node.id, { width: node.dimensions.width, height: node.dimensions.height }));
  edges.forEach(edge => graph.setEdge(edge.source, edge.target, { weight: (graph.edge(edge.source, edge.target)?.weight ?? 0) + 1 }));
  layout(graph);
  const width = graph.graph().width as number;
  const height = graph.graph().height as number;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error(`分组「${group.name}」的排列尺寸无效`);
  const positions = members.map(item => {
    const point = graph.node(item.node.id);
    const position = { x: point.x - item.node.dimensions.width / 2, y: point.y - item.node.dimensions.height / 2 };
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)
      || position.x < 0 || position.y < 0 || position.x + item.node.dimensions.width > width || position.y + item.node.dimensions.height > height) {
      throw new Error(`节点 ${item.node.id} 的排列位置无效`);
    }
    return { ...item, position };
  });
  return { group, width, height, members: positions, position: { x: 0, y: 0 }, id: crypto.randomUUID() };
}

export async function arrangeCanvas(flow: ReturnType<typeof useVueFlow>, groups: CanvasArrangeGroup[], signal?: AbortSignal) {
  signal?.throwIfAborted();
  const nodes = [...flow.getNodes.value];
  const items = getArrangeNodes(nodes, flow.nodesDraggable.value);
  if (!items.size) return { arrangedNodeIds: [], viewport: { ...flow.viewport.value } };
  const nodeExtent = flow.nodeExtent.value;
  if (!Array.isArray(nodeExtent) || nodeExtent.some((point, index) => point.some(value => value !== (index ? Infinity : -Infinity)))) {
    throw new Error("画布设置了移动范围，无法自动整理");
  }
  const plan = validateArrangeGroups(groups, [...items.keys()]);
  const nodeGroups = new Map(plan.flatMap((group, index) => group.nodeIds.map(id => [id, index] as const)));
  const groupEdges = plan.map(() => [] as GraphEdge[]);
  const crossEdges: { source: number; target: number }[] = [];
  const degree = new Map<string, number>();
  for (const edge of flow.getEdges.value) {
    const source = nodeGroups.get(edge.source);
    const target = nodeGroups.get(edge.target);
    if (source === undefined || target === undefined) throw new Error(`连线 ${edge.id} 指向旧分组或无效节点，无法重新分组`);
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    if (source === target) groupEdges[source]!.push(edge);
    else crossEdges.push({ source, target });
  }
  const layouts = plan.map((group, index) => arrangeGroup(group, items, groupEdges[index]!, degree));
  const ids = new Set(nodes.map(node => node.id));
  for (const group of layouts) {
    while (ids.has(group.id)) group.id = crypto.randomUUID();
    ids.add(group.id);
  }
  const groupGraph = new graphlib.Graph();
  const groupGap = 360 + Math.sqrt(crossEdges.length) * 40;
  groupGraph.setGraph({ rankdir: "LR", nodesep: groupGap, ranksep: groupGap, edgesep: 64 });
  groupGraph.setDefaultEdgeLabel(() => ({}));
  layouts.forEach(group => groupGraph.setNode(group.id, { width: group.width, height: group.height }));
  crossEdges.forEach(edge => {
    const source = layouts[edge.source]!.id;
    const target = layouts[edge.target]!.id;
    groupGraph.setEdge(source, target, { weight: (groupGraph.edge(source, target)?.weight ?? 0) + 1 });
  });
  layout(groupGraph);
  const positions = [...items.values()].map(item => item.position);
  const origin = { x: Math.min(...positions.map(position => position.x)), y: Math.min(...positions.map(position => position.y)) };
  const stages = [...new Set(plan.map(group => group.stage))].sort((left, right) => left - right);
  let x = origin.x;
  // ACT: 阶段固定分列，Dagre 提供跨组连接的纵向顺序；复杂回边仍可能交叉，不做紧密装箱或修改连线。
  for (const stage of stages) {
    const column = layouts.filter(group => group.group.stage === stage).sort((left, right) => groupGraph.node(left.id).y - groupGraph.node(right.id).y);
    let y = 0;
    for (const group of column) {
      y = Math.max(y, groupGraph.node(group.id).y - group.height / 2);
      group.position = { x, y: origin.y + y };
      if (!Number.isFinite(group.position.x) || !Number.isFinite(group.position.y)
        || !Number.isFinite(group.position.x + group.width) || !Number.isFinite(group.position.y + group.height)) {
        throw new Error(`分组「${group.group.name}」的排列位置无效`);
      }
      y += group.height + groupGap;
    }
    x += Math.max(...column.map(group => group.width)) + groupGap;
  }
  const bounds = {
    x: Math.min(...layouts.map(group => group.position.x)),
    y: Math.min(...layouts.map(group => group.position.y)),
    width: 0,
    height: 0,
  };
  bounds.width = Math.max(...layouts.map(group => group.position.x + group.width)) - bounds.x;
  bounds.height = Math.max(...layouts.map(group => group.position.y + group.height)) - bounds.y;
  const { width, height } = flow.dimensions.value;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error("画布尚未完成显示，请稍后重试");
  const viewport = getTransformForBounds(bounds, width, height, 0.02, 1, 0.2);
  if (!Number.isFinite(viewport.x) || !Number.isFinite(viewport.y) || !Number.isFinite(viewport.zoom) || viewport.zoom <= 0) {
    throw new Error("排列后的画布范围无效");
  }
  const groupNodes = layouts.map(group => ({
    id: group.id,
    type: "canvasGroup",
    position: group.position,
    dimensions: { width: group.width, height: group.height },
    style: { width: `${group.width}px`, height: `${group.height}px` },
    connectable: false,
    expandParent: false,
    data: { label: group.group.name },
  }));
  const nextNodes: Node[] = [...groupNodes, ...layouts.flatMap(group => group.members.map(({ node, position, selected }) => ({
    ...node,
    parentNode: group.id,
    position,
    computedPosition: { ...node.computedPosition, x: group.position.x + position.x, y: group.position.y + position.y },
    selected,
    extent: undefined,
    expandParent: false,
  })))];
  signal?.throwIfAborted();
  // setNodes 复用同 ID 的业务节点对象，完整计算后一次同步提交；边和节点内容保留原引用。
  flow.setNodes(nextNodes);
  const appliedNodes = [...flow.getNodes.value];
  const isCurrent = () => !signal?.aborted && flow.getNodes.value.length === appliedNodes.length && appliedNodes.every(node => flow.findNode(node.id) === node);
  const result = { arrangedNodeIds: [...items.keys()], viewport };
  await nextTick();
  if (!isCurrent()) return result;
  await flow.fitView({ padding: 0.2, minZoom: 0.02, maxZoom: 1, includeHiddenNodes: true, duration: 0 });
  if (isCurrent()) result.viewport = { ...flow.viewport.value };
  return result;
}
