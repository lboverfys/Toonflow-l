const rules = [
  {
    type: "input",
    field: "apiKey" as const,
    title: "API Key",
    value: "",
    props: { type: "password", showPassword: true, autocomplete: "off" },
  },
];

export default {
  id: "ds",
  label: "ds",
  icon: "",
  version: "2.0.0",
  apiUrl: "https://api.deepseek.com/anthropic",
  protocol: "anthropic-messages",
  readme: "DeepSeek 文本模型，默认使用 Anthropic 协议。添加后可编辑地址、协议和模型；API Key 仅保存在本机配置中。",
  rules,
  models: [{ id: "deepseek-flash", label: "deepseek-flash", type: "text" }],
} satisfies ProviderDefinition<typeof rules>;
