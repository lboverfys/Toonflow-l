import { reactive, type Ref } from "vue";
import { throttle } from "lodash-es";
import type { AgentEvent } from "@toonflow/server/agent/types";
import type { AgentMessage, AgentMessagePart } from "./types";

export async function* readAgentEvents<T extends { type: string; message?: string } = AgentEvent>(response: Response, signal: AbortSignal) {
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.message || `请求失败（${response.status}）`);
  }
  if (!response.body) throw new Error("未收到响应流");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      pending += value ?? "";
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      if (done) lines.push(pending);
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as T;
        if (event.type === "error") throw new Error(event.message);
        if (event.type === "done") return;
        yield event;
        signal.throwIfAborted();
      }
      if (done) throw new Error("连接已中断，请重试");
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createReplyStream(reply: AgentMessage) {
  const parts = reply.parts!;
  const partsById = new Map(parts.map(part => [part.id, part]));
  const toolsById = new Map(parts.flatMap(part => part.type === "tool" ? [[part.tool.id, part] as const] : []));
  let thinkingPart: Extract<AgentMessagePart, { type: "thinking" }> | undefined;
  let thinkingStartedAt = 0;
  let thinkingDuration = 0;
  const pendingContent = new Map<Exclude<AgentMessagePart, { type: "tool" }>, string>();
  // ACT: 合并 50 ms 内的文本增量，避免 Markdown 每个 token 都重新解析全文；结束时立即补齐。
  const flushContent = throttle(() => {
    for (const [part, content] of pendingContent) part.content = content;
    pendingContent.clear();
    if (thinkingPart) thinkingPart.duration = thinkingDuration + (performance.now() - thinkingStartedAt) / 1000;
  }, 50);

  function finishThinking() {
    if (!thinkingPart) return;
    flushContent.flush();
    thinkingPart.duration = thinkingDuration + (performance.now() - thinkingStartedAt) / 1000;
    thinkingPart = undefined;
  }

  function receive(event: Extract<AgentEvent, { type: "text" | "thinking" | "tool" | "question" }>) {
    if (event.type === "question") {
      const part = toolsById.get(event.toolCallId);
      if (part?.type !== "tool") throw new Error("提问缺少对应的工具调用");
      part.tool.question = { callId: event.callId, title: event.title, question: event.question, options: event.options, fields: event.fields };
      return;
    }
    if (event.type === "tool") {
      const part = partsById.get(event.blockId);
      if (part?.type === "tool") {
        toolsById.delete(part.tool.id);
        Object.assign(part.tool, event.tool);
        toolsById.set(part.tool.id, part);
      }
      else {
        finishThinking();
        parts.push({ id: event.blockId, type: "tool", tool: event.tool });
        const added = parts.at(-1)! as Extract<AgentMessagePart, { type: "tool" }>;
        partsById.set(added.id, added);
        toolsById.set(added.tool.id, added);
      }
      return;
    }
    const existing = partsById.get(event.blockId);
    const part = existing?.type !== "tool" && existing ? existing : reactive<Exclude<AgentMessagePart, { type: "tool" }>>({ id: event.blockId, type: event.type, content: "", ...(event.type === "thinking" ? { collapsed: true } : {}) });
    if (!existing) { parts.push(part); partsById.set(part.id, part); }
    if (part.type === "thinking" && !event.done && thinkingPart !== part) {
      finishThinking();
      thinkingPart = part;
      thinkingStartedAt = performance.now();
      thinkingDuration = part.duration ?? 0;
    }
    if (part.type === "text") finishThinking();
    pendingContent.set(part, event.content ?? (pendingContent.get(part) ?? part.content) + (event.delta ?? ""));
    flushContent();
    if (event.done) {
      flushContent.flush();
      if (part.type === "thinking" && thinkingPart === part) finishThinking();
    }
  }

  function finish() {
    flushContent.flush();
    flushContent.cancel();
    finishThinking();
    reply.content = parts.filter(part => part.type === "text").map(part => part.content).join("\n\n");
    reply.streaming = false;
    for (const part of parts) {
      if (part.type === "tool" && part.tool.status === "running") part.tool.status = "interrupted";
    }
  }

  return { receive, finish };
}

// 父会话请求和转发的子会话事件共用消息归并，切换界面不改变正在接收的回复。
export function createConversationStream(messages: Ref<AgentMessage[]>) {
  let reply: AgentMessage | undefined;
  let stream: ReturnType<typeof createReplyStream> | undefined;

  function finish() {
    stream?.finish();
    if (reply && !reply.error && !reply.content && !reply.parts?.some(part => part.type === "tool" || part.content)) {
      const emptyReply = reply;
      messages.value = messages.value.filter(message => message !== emptyReply);
    }
    stream = undefined;
    reply = undefined;
  }

  function begin(message: AgentMessage) {
    finish();
    reply = message;
    stream = createReplyStream(message);
  }

  function ensureReply(userId?: string) {
    if (reply && userId && reply.replyTo && reply.replyTo !== userId) finish();
    if (!reply) {
      const user = messages.value.findLast(message => message.role === "user" && !message.pending && (!userId || message.entryId === userId));
      const last = messages.value.findLast(message => message.role === "assistant" && message.streaming && (!userId || message.replyTo === userId));
      const message = last ?? reactive<AgentMessage>({ id: crypto.randomUUID(), role: "assistant", content: "", parts: [], streaming: true, replyTo: userId ?? user?.entryId });
      if (!last) messages.value.splice(user ? messages.value.indexOf(user) + 1 : messages.value.length, 0, message);
      begin(message);
    }
    if (userId) reply!.replyTo = userId;
    return stream!;
  }

  function receive(event: AgentEvent) {
    if (event.type === "userMessage") {
      const existing = messages.value.find(message => message.entryId === event.id || message.id === event.clientId)
        ?? messages.value.find(message => message.role === "user" && !message.entryId && message.content === event.content);
      if (existing) { existing.entryId = event.id; existing.pending = false; existing.error = undefined; existing.mentions = event.mentions; }
      else messages.value.push({ id: event.id, entryId: event.id, role: "user", content: event.content ?? "", attachments: event.attachments, mentions: event.mentions });
      ensureReply(event.id);
    } else if (["text", "thinking", "tool", "question"].includes(event.type)) {
      ensureReply().receive(event as Extract<AgentEvent, { type: "text" | "thinking" | "tool" | "question" }>);
    } else if (event.type === "error") {
      ensureReply();
      reply!.error = event.message;
      finish();
    } else if (event.type === "done") finish();
  }

  return { begin, receive, finish };
}
