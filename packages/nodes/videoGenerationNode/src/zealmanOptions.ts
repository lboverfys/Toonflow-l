export type ZealmanChoice = { key: string; label: string; file?: string; adaln?: string; keyStyle?: string; loraKeyStyle?: string; sizeGB?: number; author?: string; note?: string };
export type ZealmanVoice = { path: string; label: string; gender: string; url: string };
export type ZealmanAsset = { path: string; name: string; mimeType: string; size: number };
export function zealmanAssetUrl(source: "input" | "output", path: string) {
  return `/api/ai/media/reference?${new URLSearchParams({ providerId: "zealmanH3", modelId: "u06", source, path })}`;
}
export type ZealmanOptions = {
  models: ZealmanChoice[]; clips: ZealmanChoice[]; loras: ZealmanChoice[];
  voices: ZealmanVoice[];
  maxDuration: number; queueLimit: number; resolutions: number[]; ratios: string[];
  rtxSupported: boolean; rtxReason: string; originalSteps: number; acceleratedSteps: number;
  defaults: { modelKey: string; clipKey: string; loraKey: string; loraStrength: number; extraLoraKey: string; extraLoraStrength: number; seed: number; duration: number; forceVramCleanupBeforeVae: boolean };
};

let optionsRequest: Promise<ZealmanOptions> | undefined;
let expiresAt = 0;

export function loadZealmanOptions(refresh = false) {
  if (refresh || Date.now() >= expiresAt) optionsRequest = undefined;
  if (!optionsRequest) {
    expiresAt = Date.now() + 60000;
    const request = fetch("/api/ai/media/options?providerId=zealmanH3&modelId=u06", { signal: AbortSignal.timeout(45000), cache: "no-store" })
      .then(async response => {
        const value = await response.json();
        if (!response.ok || value.code !== 200) throw new Error(value.message || "读取 U06 选项失败");
        return value.data as ZealmanOptions;
      }).catch(error => { if (optionsRequest === request) optionsRequest = undefined; throw error; });
    optionsRequest = request;
  }
  return optionsRequest;
}

export function zealmanSize(ratio: string, megapixels: number) {
  const [width, height] = ratio.split(":").map(Number);
  const unit = Math.sqrt(megapixels * 1024 * 1024 / (width * height));
  return `${Math.max(32, Math.round(width * unit / 32) * 32)}×${Math.max(32, Math.round(height * unit / 32) * 32)}`;
}

export function loraMismatch(lora: ZealmanChoice, model?: ZealmanChoice) {
  if (lora.key === "none" || !model) return "";
  if (lora.adaln && lora.adaln !== "none" && model.adaln && lora.adaln !== model.adaln) return "完整／剪枝类型与主模型不匹配";
  if (model.loraKeyStyle === "diffusers" && lora.keyStyle === "comfy") return "LoRA 格式与主模型不兼容";
  return "";
}

export function zealmanSelectionError(settings: Record<string, unknown>, options: ZealmanOptions) {
  const model = options.models.find(item => item.key === settings.modelKey);
  if (!model || !options.clips.some(item => item.key === settings.clipKey)) return "所选主模型或编码器已不在面板清单中，请重新选择";
  for (const key of [settings.accelerated ? settings.loraKey : "none", settings.extraLoraKey]) {
    const lora = options.loras.find(item => item.key === key);
    if (!lora) return "所选 LoRA 已不在面板清单中，请重新选择";
    const mismatch = loraMismatch(lora, model);
    if (mismatch) return mismatch;
  }
  if (settings.upscale && !options.rtxSupported) return `当前机器不支持 RTX 超清，请关闭超清。${options.rtxReason}`;
  return "";
}

export function validateZealmanSettings(settings: Record<string, unknown>, options: ZealmanOptions) {
  const message = zealmanSelectionError(settings, options);
  if (message) throw new Error(message);
  if ([settings.accelerated, settings.upscale, settings.forceVramCleanupBeforeVae].some(value => typeof value !== "boolean")) throw new Error("U06 开关参数必须为布尔值");
  if (!Number.isInteger(settings.steps) || Number(settings.steps) < 1 || Number(settings.steps) > 99) throw new Error("采样步数须为 1～99 的整数");
  if ([settings.loraStrength, settings.extraLoraStrength].some(value => typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 2)) throw new Error("LoRA 强度须在 0～2 之间");
}
