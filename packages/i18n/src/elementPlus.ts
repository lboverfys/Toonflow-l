import type { Locale } from "./core.ts";
import type en from "./elementPlus/en.json";

const loaders = {
  "zh-CN": () => import("./elementPlus/zhCn.json"),
  "zh-TW": () => import("./elementPlus/zhTw.json"),
  "en": () => import("./elementPlus/en.json"),
  "ja": () => import("./elementPlus/ja.json"),
  "ru": () => import("./elementPlus/ru.json"),
  "vi": () => import("./elementPlus/vi.json"),
  "th": () => import("./elementPlus/th.json"),
  "ko": () => import("./elementPlus/ko.json"),
  "hi": () => import("./elementPlus/hi.json"),
  "id": () => import("./elementPlus/id.json"),
  "ms": () => import("./elementPlus/ms.json"),
  "fil": () => import("./elementPlus/fil.json"),
  "bn": () => import("./elementPlus/bn.json"),
  "ur": () => import("./elementPlus/ur.json"),
  "ta": () => import("./elementPlus/ta.json"),
  "te": () => import("./elementPlus/te.json"),
  "mr": () => import("./elementPlus/mr.json"),
  "pa": () => import("./elementPlus/pa.json"),
  "ar": () => import("./elementPlus/ar.json"),
  "fa": () => import("./elementPlus/fa.json"),
  "tr": () => import("./elementPlus/tr.json"),
} satisfies Record<Locale, () => Promise<{ default: typeof en }>>;

export async function loadElementLocale(locale: Locale) {
  return (await loaders[locale]()).default;
}
