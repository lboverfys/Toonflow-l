import { nodeTools, z } from "@toonflow/nodes-scaffold/nodeTools";

export function registerGenerationTools(options: {
  configDescription: string;
  promptDescription: string;
  loadModels(): Promise<void>;
  getConfig(): unknown;
  setPrompt(prompt: string): void;
}) {
  nodeTools.register({
    name: "getConfig",
    description: options.configDescription,
    parameters: z.strictObject({}),
    async execute(_args, { signal }) {
      signal?.throwIfAborted();
      await options.loadModels();
      signal?.throwIfAborted();
      return options.getConfig();
    },
  });
  nodeTools.register({
    name: "setPrompt",
    description: options.promptDescription,
    parameters: z.strictObject({ prompt: z.string() }),
    execute({ prompt }) {
      options.setPrompt(prompt);
      return { prompt };
    },
  });
}
