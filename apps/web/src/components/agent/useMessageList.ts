import { computed, nextTick, ref, watch, type ComponentPublicInstance, type Ref } from "vue";
import { defaultRangeExtractor, measureElement, observeElementRect, useVirtualizer } from "@tanstack/vue-virtual";
import { isBrowserTool } from "@toonflow/tool-browser/client";
import type { AgentToolCall } from "@toonflow/server/agent/types";
import type { AgentMessage } from "./types";

export function useMessageList(messages: Ref<AgentMessage[]>, options: { active(): boolean; hasEarlier(): boolean; editingId(): string | undefined }) {
  const browserMessages = computed(() => {
    const groups = new Map<string, { id: string; tools: AgentToolCall[] }>();
    let turnId: string | undefined;
    let liveMessageId: string | undefined;
    for (const message of messages.value) {
      if (message.role === "user") {
        turnId = message.entryId ?? message.id;
        liveMessageId = undefined;
        continue;
      }
      if (message.replyTo && message.replyTo !== turnId) {
        turnId = message.replyTo;
        liveMessageId = undefined;
      }
      const tools = message.parts?.flatMap(part => part.type === "tool" && isBrowserTool(part.tool) ? [part.tool] : []);
      if (!tools?.length) continue;
      const replyId = turnId ?? message.id;
      let group = groups.get(replyId);
      if (!group) { group = { id: message.id, tools: [] }; groups.set(replyId, group); }
      group.tools.push(...tools);
      liveMessageId = group.id;
    }
    return { tools: new Map([...groups.values()].map(group => [group.id, group.tools])), liveMessageId };
  });
  // 同轮浏览器调用共用该轮首条浏览器消息底部的画面，原始工具记录仍完整保留。
  const displayedMessages = computed(() => messages.value.filter(message => browserMessages.value.tools.has(message.id) || message.role === "user" || message.error || message.report || message.attachments?.length ||
    !message.parts?.length || message.parts.some(part => part.type !== "tool" || !isBrowserTool(part.tool))));

  const messageList = ref<HTMLDivElement>();
  const atLatestMessage = ref(true);
  let messageListInitialized = false;
  let messageScrollOffset = 0;
  const messageKeys = computed(() => displayedMessages.value.map(item => item.id));
  // ACT: 只常驻当前轮的实时画面，历史浏览器消息仍按需挂载，避免长对话累积连接和 DOM。
  const retainedMessages = computed(() => displayedMessages.value.flatMap((item, index) => item.streaming || item.id === options.editingId() || item.id === browserMessages.value.liveMessageId ? [index] : []));
  const messageVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>(computed(() => {
    const keys = messageKeys.value;
    const retained = retainedMessages.value;
    return {
      count: keys.length,
      getScrollElement: () => messageList.value ?? null,
      getItemKey: (index: number) => keys[index]!,
      estimateSize: () => 240,
      overscan: 3,
      paddingStart: options.hasEarlier() ? 52 : 12,
      anchorTo: "end" as const,
      followOnAppend: true,
      scrollEndThreshold: 48,
      useAnimationFrameWithResizeObserver: true,
      useCachedMeasurements: !options.active(),
      // ACT: 实时行读取当前高度，避免延后执行的观察记录覆盖本轮同步测量；历史行仍使用缓存。
      measureElement: (element, entry, instance) => options.active() && element.dataset.liveMessage ? element.offsetHeight : measureElement(element, entry, instance),
      // ACT: v-show 隐藏时保留视口与行高，避免零尺寸清空正在输入的工具表单。
      observeElementRect: (instance, onChange) => observeElementRect(instance, rect => { if (rect.height) onChange(rect); }),
      rangeExtractor: range => [...new Set([...defaultRangeExtractor(range), ...retained])].sort((left, right) => left - right),
      onChange(instance) {
        if (!messageListInitialized || !options.active() || !messageList.value?.clientHeight) return;
        atLatestMessage.value = instance.isAtEnd();
        messageScrollOffset = instance.scrollOffset ?? 0;
      },
    };
  }));
  const visibleMessages = computed(() => messageVirtualizer.value.getVirtualItems().map(row => ({ row, item: displayedMessages.value[row.index]! })));
  let messageMeasurePending = false;

  function measureMessage(element: Element | ComponentPublicInstance | null) {
    const instance = messageVirtualizer.value;
    if (!(element instanceof HTMLDivElement) || !options.active() || !atLatestMessage.value || !element.dataset.liveMessage) {
      instance.measureElement(element instanceof HTMLDivElement ? element : null);
      return;
    }
    const index = instance.indexFromElement(element);
    const height = element.offsetHeight;
    const changed = instance.itemSizeCache.get(instance.options.getItemKey(index)) !== height;
    instance.measureElement(element);
    // 自动滚动时库会跳过同步测量；在本次 DOM 提交内校正，避免画面随换行先下移再被拉回。
    instance.resizeItem(index, height);
    if (!changed || messageMeasurePending) return;
    messageMeasurePending = true;
    void nextTick(() => {
      messageMeasurePending = false;
      if (options.active() && atLatestMessage.value) instance.scrollToEnd();
    });
  }

  watch([() => options.active(), messageList], async ([active, element]) => {
    if (!active || !element) return;
    await nextTick();
    if (!options.active()) return;
    if (!messageListInitialized || atLatestMessage.value) messageVirtualizer.value.scrollToEnd();
    else messageVirtualizer.value.scrollToOffset(messageScrollOffset);
    messageListInitialized = true;
  }, { immediate: true, flush: "post" });
  return { browserMessages, messageList, atLatestMessage, messageVirtualizer, visibleMessages, measureMessage };
}
