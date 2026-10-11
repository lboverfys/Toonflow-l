import { computed, nextTick, ref, toValue, watch, type MaybeRefOrGetter } from "vue";
import type { TreeInstance } from "element-plus";
import { settingsStorage } from "@/stores/settings";

export function useExpandedKeys(key: MaybeRefOrGetter<string>) {
  const stored = computed(() => settingsStorage.getItem(toValue(key)));
  return computed<string[]>({
    get() {
      try {
        const value: unknown = JSON.parse(stored.value ?? "[]");
        return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
      } catch { return []; }
    },
    set(value) { settingsStorage.setItem(toValue(key), JSON.stringify(value)); },
  });
}

export function useTreeExpansion(key: MaybeRefOrGetter<string>, query: MaybeRefOrGetter<string> = "") {
  const tree = ref<TreeInstance>();
  const expandedKeys = useExpandedKeys(key);
  type TreeNode = NonNullable<ReturnType<TreeInstance["getNode"]>>;

  function expand(_data: unknown, node: TreeNode) {
    if (toValue(query).trim()) return;
    const path = String(node.key);
    if (!expandedKeys.value.includes(path)) expandedKeys.value = [...expandedKeys.value, path];
  }

  function collapse(_data: unknown, node: TreeNode) {
    if (toValue(query).trim()) return;
    expandedKeys.value = expandedKeys.value.filter(path => path !== String(node.key));
  }

  function relocate(path: string, target?: string) {
    expandedKeys.value = expandedKeys.value.flatMap(key => key === path || key.startsWith(`${path}/`)
      ? target === undefined ? [] : [target + key.slice(path.length)] : [key]);
  }

  watch([tree, expandedKeys, () => tree.value?.$props.data, () => tree.value?.$props.currentNodeKey], async () => {
    await nextTick();
    if (!tree.value || toValue(query).trim()) return;
    const expanded = new Set(expandedKeys.value);
    function restore(nodes: TreeNode[]) {
      for (const node of nodes) {
        if (expanded.has(String(node.key))) node.expand();
        else node.collapse();
        restore(node.childNodes);
      }
    }
    restore(tree.value.store.root.childNodes);
  }, { flush: "post" });

  return { tree, expandedKeys, expand, collapse, relocate };
}
