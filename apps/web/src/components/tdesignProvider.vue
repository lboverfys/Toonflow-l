<template>
  <config-provider :globalConfig="tdesignLocale"><slot /></config-provider>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { locale } from "@toonflow/i18n/vue";
import { chatLocale } from "@/lib/i18n";
import { ConfigProvider, type GlobalConfigProvider } from "tdesign-vue-next";
import tdesignZhCn from "tdesign-vue-next/es/locale/zh_CN";
import tdesignZhTw from "tdesign-vue-next/es/locale/zh_TW";
import tdesignEn from "tdesign-vue-next/es/locale/en_US";
import tdesignJa from "tdesign-vue-next/es/locale/ja_JP";
import tdesignRu from "tdesign-vue-next/es/locale/ru_RU";
import tdesignKo from "tdesign-vue-next/es/locale/ko_KR";
import tdesignAr from "tdesign-vue-next/es/locale/ar_KW";

// ACT: TDesign 缺少的语言使用英语基底，聊天控件由应用字典补齐。
const tdesignLocales = {
  "zh-CN": tdesignZhCn, "zh-TW": tdesignZhTw, en: tdesignEn, ja: tdesignJa, ru: tdesignRu, vi: tdesignEn, th: tdesignEn, ko: tdesignKo, hi: tdesignEn,
  id: tdesignEn, ms: tdesignEn, fil: tdesignEn, bn: tdesignEn, ur: tdesignEn, ta: tdesignEn, te: tdesignEn, mr: tdesignEn, pa: tdesignEn, ar: tdesignAr, fa: tdesignEn, tr: tdesignEn,
};
// ACT: TDesign 自带语言包声明为 readonly，而 ConfigProvider 的只读使用接口声明为可写。
const tdesignLocale = computed(() => ({ ...tdesignLocales[locale.value], chat: chatLocale.value }) as unknown as GlobalConfigProvider);

</script>
