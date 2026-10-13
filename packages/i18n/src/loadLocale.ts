import { registerCatalog, type Locale } from "./core.ts";

const loaders = {
  "zh-TW": () => import("./locales/zhTw.json"),
  "en": () => import("./locales/en.json"),
  "ja": () => import("./locales/ja.json"),
  "ru": () => import("./locales/ru.json"),
  "vi": () => import("./locales/vi.json"),
  "th": () => import("./locales/th.json"),
  "ko": () => import("./locales/ko.json"),
  "hi": () => import("./locales/hi.json"),
  "id": () => import("./locales/id.json"),
  "ms": () => import("./locales/ms.json"),
  "fil": () => import("./locales/fil.json"),
  "bn": () => import("./locales/bn.json"),
  "ur": () => import("./locales/ur.json"),
  "ta": () => import("./locales/ta.json"),
  "te": () => import("./locales/te.json"),
  "mr": () => import("./locales/mr.json"),
  "pa": () => import("./locales/pa.json"),
  "ar": () => import("./locales/ar.json"),
  "fa": () => import("./locales/fa.json"),
  "tr": () => import("./locales/tr.json"),
} satisfies Record<Exclude<Locale, "zh-CN">, () => Promise<{ default: Record<string, string> }>>;
const loading = new Map<Locale, Promise<void>>();

export async function loadLocale(locale: Locale) {
  if (locale === "zh-CN") return;
  let pending = loading.get(locale);
  if (!pending) {
    pending = loaders[locale]().then(({ default: messages }) => registerCatalog(locale, messages)).catch(error => {
      loading.delete(locale);
      throw error;
    });
    loading.set(locale, pending);
  }
  await pending;
}
