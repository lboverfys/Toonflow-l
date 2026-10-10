import { expect, test } from "bun:test";
import { z } from "zod";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { Context, Model, Tool } from "@earendil-works/pi-ai";
import { canvasOperations, canvasSchemas } from "@toonflow/tool-canvas/runtime";

const apis = {
  "anthropic-messages": anthropicMessagesApi(),
  "openai-completions": openAICompletionsApi(),
  "openai-responses": openAIResponsesApi(),
};
type protocol = keyof typeof apis;
const tools: Tool[] = canvasOperations.map(operation => ({
  name: operation.name, description: operation.description,
  parameters: z.toJSONSchema(operation.parameters, { io: "input", target: "draft-07" }),
}));
const toolArguments = { nodeId: "shotOne", name: "node:getConfig", args: {} };
const encoder = new TextEncoder();

function model(api: protocol): Model<protocol> {
  return {
    api, id: "deepseek-flash", name: "deepseek-flash", provider: "ds", reasoning: true,
    baseUrl: api === "anthropic-messages" ? "https://api.deepseek.com/anthropic" : "https://api.deepseek.com/v1",
    input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1048576, maxTokens: 393216,
  };
}

function unresolvedReferences(schema: Record<string, any>) {
  const missing: string[] = [];
  function visit(value: any) {
    if (!value || typeof value !== "object") return;
    if (typeof value.$ref === "string" && value.$ref.startsWith("#/")) {
      const target = value.$ref.slice(2).split("/").reduce((item: any, part: string) => item?.[part.replaceAll("~1", "/").replaceAll("~0", "~")], schema);
      if (target === undefined) missing.push(value.$ref);
    }
    Object.values(value).forEach(visit);
  }
  visit(schema);
  return missing;
}

function outboundTools(api: protocol, payload: any) {
  return payload.tools.map((tool: any) => ({
    name: tool.function?.name ?? tool.name,
    parameters: api === "anthropic-messages" ? tool.input_schema : tool.function?.parameters ?? tool.parameters,
  }));
}

function reply(api: protocol, call = false, incomplete = false) {
  const text = "模拟回复完成";
  const args = JSON.stringify(toolArguments);
  let events: any[];
  if (api === "anthropic-messages") {
    events = [
      { type: "message_start", message: { id: "message1", type: "message", role: "assistant", model: "deepseek-flash", content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: call ? { type: "tool_use", id: "call1", name: "nodeTools", input: {} } : { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: call ? { type: "input_json_delta", partial_json: args } : { type: "text_delta", text } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: call ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 8 } },
      { type: "message_stop" },
    ];
    if (incomplete) events = events.slice(0, 3);
  } else if (api === "openai-completions") {
    const chunk = (delta: any, reason: string | null) => ({ id: "chat1", object: "chat.completion.chunk", created: 0, model: "deepseek-flash", choices: [{ index: 0, delta, finish_reason: reason }] });
    events = [
      chunk(call ? { role: "assistant", tool_calls: [{ index: 0, id: "call1", type: "function", function: { name: "nodeTools", arguments: args } }] } : { role: "assistant", content: text }, null),
      chunk({}, call ? "tool_calls" : "stop"),
    ];
    if (incomplete) events = events.slice(0, 1);
  } else {
    const item = call ? { type: "function_call", id: "function1", call_id: "call1", name: "nodeTools", arguments: args, status: "completed" }
      : { type: "message", id: "message1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
    events = [
      { type: "response.created", response: { id: "response1", status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: call ? { ...item, arguments: "" } : { ...item, content: [] } },
      call ? { type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: args }
        : { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: text },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "response1", status: "completed", output: [item], usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 } } },
    ];
    if (incomplete) events = events.slice(0, 3);
  }
  const content = events.map((event, sequence) => api === "openai-completions" ? `data: ${JSON.stringify(event)}\n\n`
    : `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: sequence })}\n\n`).join("")
    + (api === "openai-completions" && !incomplete ? "data: [DONE]\n\n" : "");
  let offset = 0;
  const bytes = encoder.encode(content);
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.subarray(offset, offset + 37));
      offset = Math.min(offset + 37, bytes.length);
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

for (const api of Object.keys(apis) as protocol[]) {
  for (const reasoning of [undefined, "high"] as const) {
    test(`${api} ${reasoning ?? "默认"}：全部画布工具定义完整且流式回复可读`, async () => {
      const original = JSON.stringify(tools);
      let requests = 0;
      const stream = apis[api].streamSimple(model(api), { messages: [{ role: "user", content: "hi", timestamp: 0 }], tools }, {
        apiKey: "schema-mock-key", reasoning, maxTokens: 128, maxRetries: 0,
        fetch: async (input, init) => {
          requests++;
          const request = new Request(input, init);
          expect(new URL(request.url).pathname).toBe(api === "anthropic-messages" ? "/anthropic/v1/messages" : api === "openai-completions" ? "/v1/chat/completions" : "/v1/responses");
          const body = await request.json();
          const sent = outboundTools(api, body);
          expect(sent).toHaveLength(tools.length);
          for (const tool of sent) {
            expect(unresolvedReferences(tool.parameters)).toEqual([]);
            const expected = { ...tools.find(item => item.name === tool.name)!.parameters };
            // SDK 原有行为会为没有必填字段的 Anthropic 工具补 required: []。
            if (api === "anthropic-messages" && !Object.hasOwn(expected, "required")) expected.required = [];
            expect(tool.parameters).toEqual(expected);
          }
          if (reasoning === "high") {
            if (api === "anthropic-messages") expect(body.thinking.type).toBe("enabled");
            else expect(body.reasoning?.effort ?? body.reasoning_effort).toBe("high");
          }
          return reply(api);
        },
      });
      const events = [];
      for await (const event of stream) events.push(event.type);
      const result = await stream.result();
      expect(result.errorMessage).toBeUndefined();
      expect(result.stopReason).toBe("stop");
      expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "模拟回复完成" }));
      expect(events).toContain("text_delta");
      expect(requests).toBe(1);
      expect(JSON.stringify(tools)).toBe(original);
    });
  }

  test(`${api}：工具结果回传后继续回复，再进行下一轮对话`, async () => {
    const context: Context = { messages: [{ role: "user", content: "查询节点设置", timestamp: 0 }], tools };
    const payloads: any[] = [];
    const run = () => apis[api].streamSimple(model(api), context, {
      apiKey: "schema-mock-key", reasoning: "high", maxTokens: 128, maxRetries: 0,
      fetch: async (input, init) => {
        payloads.push(await new Request(input, init).json());
        return reply(api, payloads.length === 1);
      },
    }).result();
    const first = await run();
    expect(first.stopReason).toBe("toolUse");
    const call = first.content.find(item => item.type === "toolCall")!;
    expect(call.name).toBe("nodeTools");
    expect(canvasSchemas.nodeTools.parse(call.arguments)).toEqual(toolArguments);
    context.messages.push(first, { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "节点配置读取成功，时长16秒" }], isError: false, timestamp: 1 });
    const second = await run();
    expect(second.stopReason).toBe("stop");
    expect(JSON.stringify(payloads[1])).toContain("节点配置读取成功，时长16秒");
    context.messages.push(second, { role: "user", content: "继续解释", timestamp: 2 });
    expect((await run()).stopReason).toBe("stop");
    expect(JSON.stringify(payloads[2])).toContain("继续解释");
    expect(payloads).toHaveLength(3);
  });

  test(`${api}：流未正常结束时不报告成功`, async () => {
    const result = await apis[api].streamSimple(model(api), { messages: [{ role: "user", content: "hi", timestamp: 0 }], tools }, {
      apiKey: "schema-mock-key", maxRetries: 0, fetch: async () => reply(api, false, true),
    }).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBeTruthy();
  });
}

test("Anthropic 保留 $defs、转义引用和根约束", async () => {
  const parameters = { type: "object", properties: { value: { $ref: "#/$defs/name~1with~0escape" } }, required: ["value"], additionalProperties: false,
    $defs: { "name/with~escape": { type: "string", minLength: 1 } }, minProperties: 1, allOf: [{ properties: { value: { maxLength: 20 } } }] };
  let sent: any;
  const result = await apis["anthropic-messages"].streamSimple(model("anthropic-messages"), { messages: [{ role: "user", content: "hi", timestamp: 0 }], tools: [{ name: "schemaProbe", description: "验证", parameters }] }, {
    apiKey: "schema-mock-key", maxRetries: 0,
    fetch: async (input, init) => { sent = (await new Request(input, init).json()).tools[0].input_schema; return reply("anthropic-messages"); },
  }).result();
  expect(result.stopReason).toBe("stop");
  expect(sent).toEqual(parameters);
  expect(unresolvedReferences(sent)).toEqual([]);
});

test("Anthropic 原有严格模式仍保留约束", async () => {
  const parameters = { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false };
  let sent: any;
  const result = await apis["anthropic-messages"].streamSimple({ ...model("anthropic-messages"), compat: { supportsStrictTools: true } }, {
    messages: [{ role: "user", content: "hi", timestamp: 0 }], tools: [{ name: "strictProbe", description: "验证", parameters, constrainedSampling: { type: "json_schema", strict: "require" } }],
  }, { apiKey: "schema-mock-key", maxRetries: 0, fetch: async (input, init) => { sent = (await new Request(input, init).json()).tools[0]; return reply("anthropic-messages"); } }).result();
  expect(result.stopReason).toBe("stop");
  expect(sent.strict).toBe(true);
  expect(sent.input_schema).toEqual(parameters);
});
