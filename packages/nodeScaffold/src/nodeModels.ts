// ACT: 独立 UMD 各有模块作用域，共用宿主缓存；模型设置保存后失效，不按节点重复请求。
const modelCacheKey = Symbol.for("toonflow.nodeModels");
const modelCacheHost = globalThis as typeof globalThis & { [modelCacheKey]?: Map<string, Promise<unknown[]>> };
export const modelCache = modelCacheHost[modelCacheKey] ??= new Map<string, Promise<unknown[]>>();

export function invalidateNodeModels(type: "language" | "media") {
  modelCache.delete(type === "language" ? "/api/ai/models" : "/api/ai/media/models");
}
