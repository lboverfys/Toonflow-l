import { computed, inject, onScopeDispose, ref, watch, type Ref } from "vue";
import { useNode, useNodeId } from "@vue-flow/core";
import type { NodeDocumentContext } from "./nodeDocument";

const previewObserverKey = Symbol.for("toonflow.nodePreviewObserver.v2");
type PreviewState = { visible: Ref<boolean>; retained: Ref<boolean> };
type PreviewObserver = { observer: IntersectionObserver; targets: Map<Element, Set<Ref<boolean>>>; states: WeakMap<object, PreviewState> };

export function useNodePreviewReady(retain?: Ref<boolean>) {
  const nodeId = useNodeId();
  const documentContext = inject<NodeDocumentContext | undefined>("nodeDocument", undefined);
  const canvasActive = inject<Readonly<Ref<boolean>>>("canvasActive", ref(true));
  if (!nodeId || typeof IntersectionObserver === "undefined") return ref(true);
  const { node, nodeEl } = useNode();
  const host = globalThis as typeof globalThis & { [previewObserverKey]?: PreviewObserver };
  if (!host[previewObserverKey]) {
    const targets: PreviewObserver["targets"] = new Map();
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) targets.get(entry.target)?.forEach(value => { value.value = entry.isIntersecting; });
    }, { rootMargin: "320px" });
    host[previewObserverKey] = { observer, targets, states: new WeakMap() };
  }
  const { observer, targets, states } = host[previewObserverKey];
  let state = states.get(node);
  if (!state) { state = { visible: ref(false), retained: ref(false) }; states.set(node, state); }
  const current = state;
  if (retain) {
    watch(retain, value => { current.retained.value = value; }, { immediate: true, flush: "sync" });
    onScopeDispose(() => { current.retained.value = false; });
  }
  const visible = ref(false);
  watch(visible, value => { current.visible.value = value; }, { flush: "sync" });
  watch(nodeEl, (element, _previous, onCleanup) => {
    if (!element) return;
    const subscribers = targets.get(element) ?? new Set<Ref<boolean>>();
    subscribers.add(visible);
    targets.set(element, subscribers);
    observer.observe(element);
    onCleanup(() => {
      subscribers.delete(visible);
      if (targets.get(element) === subscribers && !subscribers.size) {
        targets.delete(element);
        observer.unobserve(element);
      }
    });
  }, { immediate: true, flush: "post" });
  // 只回收预览；节点运行时、生成任务和正在编辑的视图仍由所属组件保留。
  return computed(() => current.retained.value || !!documentContext?.targets.has(nodeId) || canvasActive.value && (current.visible.value || node.selected));
}
