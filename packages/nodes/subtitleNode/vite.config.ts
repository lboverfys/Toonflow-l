import { createNodeConfig } from "@toonflow/nodes-scaffold";

export default createNodeConfig({
  name: "subtitleNode",
  displayName: "字幕",
  author: "Toonflow",
  github: "https://github.com/HBAI-Ltd/Toonflow-app",
  configRules: [
    { type: "input", field: "pythonPath", title: "Python 路径（可选）", value: "" },
    {
      type: "select", field: "defaultModel", title: "默认 Whisper 模型", value: "small",
      options: ["tiny", "base", "small", "medium", "large", "turbo"].map(value => ({ label: value, value })),
    },
  ],
}, import.meta.url);
