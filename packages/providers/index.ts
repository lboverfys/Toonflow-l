/// <reference path="./types.d.ts" />

import tfRouterLanguage from "./src/language/tfRouter";
import deepSeek from "./src/language/deepSeek";
import tfRouterMedia from "./src/media/tfRouter";
import apiMart from "./src/media/apiMart";
import metaso from "./src/media/metaso";
import compshare from "./src/media/compshare";
import laoliVideo from "./src/media/laoliVideo";
import laoliImage from "./src/media/laoliImage";

export type Provider = ProviderDefinition;
export type VideoTaskContext = ProviderVideoTask;
export type VideoTaskState = ProviderVideoTaskState;
export type ImageTaskContext = ProviderImageTask;
export type ProviderTools = ProviderContext["tool"];
export type AudioConvertOptions = Parameters<ProviderTools["audio"]["convert"]>[1];
export type { FfmpegFactory, FfmpegCommand } from "@toonflow/ffmpeg/types";

export const languageProviders = [tfRouterLanguage, deepSeek] as const;
export const mediaProviders = [tfRouterMedia, apiMart, metaso, compshare, laoliVideo, laoliImage] as const;
