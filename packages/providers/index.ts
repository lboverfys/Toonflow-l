/// <reference path="./types.d.ts" />

import deepSeek from "./src/language/deepSeek";
import laoliVideo from "./src/media/laoliVideo";
import laoliImage from "./src/media/laoliImage";
import sub2apiImage from "./src/media/sub2apiImage";
import dola from "./src/media/dola";

export type Provider = ProviderDefinition;
export type VideoTaskContext = ProviderVideoTask;
export type VideoTaskState = ProviderVideoTaskState;
export type ImageTaskContext = ProviderImageTask;
export type ProviderTools = ProviderContext["tool"];
export type AudioConvertOptions = Parameters<ProviderTools["audio"]["convert"]>[1];
export type { FfmpegFactory, FfmpegCommand } from "@toonflow/ffmpeg/types";

export const languageProviders = [deepSeek] as const;
export const mediaProviders: readonly Provider[] = [laoliImage, laoliVideo, sub2apiImage, dola];
