/// <reference path="./types.d.ts" />

import deepSeek from "./src/language/deepSeek";
import laoliVideo from "./src/media/laoliVideo";
import laoliImage from "./src/media/laoliImage";
import sub2apiImage from "./src/media/sub2apiImage";
import dola from "./src/media/dola";
import vidGate from "./src/media/vidGate";
import fankeVideo from "./src/media/fankeVideo";
import ailxpImage from "./src/media/ailxpImage";
import autoDl from "./src/media/autoDl";
import zealmanH3 from "./src/media/zealmanH3";

export type Provider = ProviderDefinition;
export type VideoTaskContext = ProviderVideoTask;
export type VideoTaskState = ProviderVideoTaskState;
export type ImageTaskContext = ProviderImageTask;
export type ProviderTools = ProviderContext["tool"];
export type AudioConvertOptions = Parameters<ProviderTools["audio"]["convert"]>[1];
export type { FfmpegFactory, FfmpegCommand } from "@toonflow/ffmpeg/types";

export const languageProviders = [deepSeek] as const;
export const mediaProviders: readonly Provider[] = [laoliImage, laoliVideo, sub2apiImage, dola, vidGate, fankeVideo, ailxpImage, autoDl, zealmanH3];
