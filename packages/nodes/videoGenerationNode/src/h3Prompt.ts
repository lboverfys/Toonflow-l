import { z, type NodeInputValue, type NodeMediaValue } from "@toonflow/nodes-scaffold/runtime";
import { referenceKey } from "@toonflow/node-shared/useNodeReferences";
import type { ZealmanVoice } from "./zealmanOptions";

export type H3Subject = { id: number; name: string; references: string[]; speaker?: number };
export type H3PromptState = {
  subjects: H3Subject[];
  audioBindings: Record<string, { subject: number; speaker: number; description: string }>;
  voices: string[];
  attachments: { id: string; name: string; dataType: "IMAGE" | "VIDEO" | "AUDIO"; value: NodeMediaValue; source?: string; sourceHandle?: string }[];
  model: string;
  editorMode: "tags" | "code";
};
export type H3Reference = { id: string; name: string; value: string; category: string; avatar?: string; previewUrl?: string; input?: NodeInputValue; voice?: ZealmanVoice; action?: boolean };
export const h3Sections = [
  ["subject_definitions", "主体定义"], ["summary", "摘要"], ["retention_analysis", "保留分析"],
  ["detailed_description", "详细描述"], ["overall_soundscape", "环境音"], ["non_diegetic_music", "非剧情配乐"],
] as const;
export const h3Languages = [{ value: "Chinese", label: "中文" }, { value: "English", label: "英文" }, { value: "Japanese", label: "日文" }, { value: "Korean", label: "韩文" }];
const h3ResultSchema = z.strictObject({
  subject_definitions: z.array(z.string()), summary: z.string().min(1), retention_analysis: z.array(z.string()),
  detailed_description: z.string().min(1), overall_soundscape: z.string(), non_diegetic_music: z.string(),
});

export function h3References(inputs: NodeInputValue[], state: H3PromptState, voices?: ZealmanVoice[], previews: { id: string; avatar?: string; previewUrl?: string }[] = []) {
  const counts: Record<string, number> = {};
  const previewById = new Map(previews.map(item => [item.id, item]));
  const references: H3Reference[] = inputs.flatMap((input, index) => {
    const kind = String(input.dataType);
    const tag = ({ IMAGE: "Picture", VIDEO: "Video", AUDIO: "Audio", STRING: "Text" } as Record<string, string>)[kind];
    if (!tag) return [];
    const number = counts[tag] = (counts[tag] ?? 0) + 1;
    const id = referenceKey(input);
    const preview = previewById.get(id);
    return [{ id, name: `${({ Picture: "图", Video: "视", Audio: "音", Text: "文本" } as Record<string, string>)[tag]}${number}`,
      value: tag === "Text" ? `参考 ${index + 1}` : `<${tag} ${number}>`, category: tag.toLowerCase(), input,
      avatar: preview?.avatar, previewUrl: preview?.previewUrl }];
  });
  const byVoice = new Map(voices?.map(voice => [voice.path, voice]));
  for (const path of voices ? state.voices : []) {
    const number = counts.Audio = (counts.Audio ?? 0) + 1;
    const voice = byVoice.get(path);
    references.push({ id: `voice:${path}`, name: `音${number} · ${voice?.label ?? path.split("/").at(-1)}`, value: `<Audio ${number}>`, category: "audio", voice });
  }
  return references;
}

function addDefinitions(prompt: string, definitions: string[]) {
  if (!definitions.length) return prompt;
  const heading = /^\s*subject_definitions\s*:\s*\n?/im.exec(prompt);
  if (!heading) return `subject_definitions:\n${definitions.join("\n")}\n\n${prompt}`;
  const at = heading.index + heading[0].length;
  return `${prompt.slice(0, at)}${definitions.join("\n")}\n${prompt.slice(at)}`;
}

export function h3GenerationPrompt(prompt: string, references: H3Reference[], state: H3PromptState, updateBindings = false) {
  const inputs = references.filter(item => item.input);
  let text = prompt.replace(/\{\{ref\s+(\d+)\}\}/g, (tag, index: string) => inputs[Number(index) - 1]?.value ?? tag);
  const definitions: string[] = [];
  const byId = new Map(references.map(item => [item.id, item]));
  for (const subject of state.subjects) {
    const sources = subject.references.flatMap(id => byId.has(id) ? [byId.get(id)!.value] : []);
    if (!sources.length) continue;
    const generated = new RegExp(`(<Subject ${subject.id}> is the )[^\\n]*? in <(?:Picture|Video) \\d+>(?: and <(?:Picture|Video) \\d+>)*`, "g");
    if (updateBindings) text = text.replace(generated, () => `<Subject ${subject.id}> is the ${subject.name} in ${sources.join(" and ")}`);
    if (new RegExp(`<Subject\\s+${subject.id}>\\s+(?:is|是)`, "i").test(text)) continue;
    definitions.push(`<Subject ${subject.id}> is the ${subject.name} in ${sources.join(" and ")}.`);
  }
  for (const [id, binding] of Object.entries(state.audioBindings)) {
    const audio = byId.get(id);
    if (!audio || audio.category !== "audio" || !state.subjects.some(subject => subject.id === binding.subject)) continue;
    const line = `${audio.value} is the voice-timbre reference for <Subject ${binding.subject}> (S${binding.speaker}).${binding.description.trim() ? ` ${binding.description.trim()}` : ""}`;
    const existing = new RegExp(`${audio.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is the voice-timbre reference for[^\\n]*`, "i");
    if (existing.test(text)) { if (updateBindings) text = text.replace(existing, () => line); }
    else definitions.push(line);
  }
  return addDefinitions(text, definitions);
}

export function h3SectionText(prompt: string, key: string) {
  const section = new RegExp(`(?:^|\\n)[ \\t]*${key}[ \\t]*:[ \\t]*([\\s\\S]*?)(?=\\n[ \\t]*(?:${h3Sections.map(item => item[0]).join("|")})[ \\t]*:|$)`, "i").exec(prompt);
  return section?.[1]?.trim() ?? "";
}

export function h3PromptSubjects(prompt: string, references: H3Reference[]) {
  const byTag = new Map(references.map(item => [item.value, item.id]));
  return [...(h3SectionText(prompt, "subject_definitions") || prompt).matchAll(/^\s*<Subject (\d+)> is (?:the )?([^\n]+?)(?: in | from )(<(?:Picture|Video) \d+>[^\n]*)/gm)].map(match => ({
    id: Number(match[1]), name: match[2].trim(),
    references: [...match[3].matchAll(/<(?:Picture|Video) \d+>/g)].flatMap(token => byTag.has(token[0]) ? [byTag.get(token[0])!] : []),
  }));
}

export function h3PromptIssues(prompt: string, references: H3Reference[], duration: number) {
  const issues: string[] = [];
  if (/<Missing (Picture|Video|Audio|Subject)\s+\d+>/.test(prompt)) issues.push("提示词中有已移除的素材或主体，请删除失效标签或重新插入引用");
  const available = new Set(references.map(item => item.value));
  for (const match of prompt.matchAll(/<(Picture|Video|Audio)\s+(\d+)>/g)) {
    if (!available.has(`<${match[1]} ${Number(match[2])}>`)) issues.push(`${match[0]} 没有对应素材`);
  }
  const definitions = h3SectionText(prompt, "subject_definitions") || prompt;
  const defined = new Set([...definitions.matchAll(/<Subject\s+(\d+)>\s+(?:is|是)/g)].map(match => Number(match[1])));
  for (const match of prompt.matchAll(/<Subject\s+(\d+)>/g)) if (!defined.has(Number(match[1]))) issues.push(`${match[0]} 尚未定义`);
  const detail = h3SectionText(prompt, "detailed_description");
  if (detail && (prompt.match(/<d>/g)?.length ?? 0) !== (detail.match(/<d>/g)?.length ?? 0)) issues.push("完整对白须放在详细描述 detailed_description 段内");
  const shots = [...detail.matchAll(/\[Shot\s+(\d+)\]/g)];
  if (shots.some((match, index) => Number(match[1]) !== index + 1)) issues.push("镜头编号须从 Shot 1 开始连续递增");
  let previous = 0;
  for (const match of detail.matchAll(/At\s+(\d{2}):(\d{2})\.(\d{3})/g)) {
    const time = Number(match[1]) * 60 + Number(match[2]) + Number(match[3]) / 1000;
    if (time <= previous || time >= duration) issues.push("镜头切点须递增且小于视频时长");
    previous = time;
  }
  const words = detail.replace(/<d>[\s\S]*?<\/d>/g, "").match(/[a-z]+(?:['-][a-z]+)*/gi)?.length ?? 0;
  if (detail && words && (words < 350 || words > 500)) issues.push(`分镜正文约 ${words} 个英文词，建议 350～500 词（对白密集时可适当调整）`);
  return [...new Set(issues)];
}

export function h3Skeleton(prompt: string, references: H3Reference[], state: H3PromptState, duration: number) {
  const definitions = h3SectionText(h3GenerationPrompt("", references, state), "subject_definitions");
  const count = duration < 5 ? 1 : duration <= 6 ? 2 : duration <= 10 ? 3 : Math.min(5, Math.floor(duration / 3));
  const shots = Array.from({ length: Math.max(1, count) }, (_, index) => `[Shot ${index + 1}]${index ? ` At ${new Date(Math.floor(duration * index / count * 1000)).toISOString().slice(14, 23)},` : ""} …`);
  const hasSections = h3Sections.some(([key]) => h3SectionText(prompt, key));
  return h3Sections.map(([key]) => `${key}:\n${h3SectionText(prompt, key) || ({
    subject_definitions: definitions || references.filter(item => item.category !== "text").map(item => `${item.value} is the … reference.`).join("\n"),
    summary: `[reference generation] Create a ${duration}-second video. ${hasSections ? "" : prompt.trim()}`,
    retention_analysis: state.subjects.map(subject => `<Subject ${subject.id}> (appears in [Shot 1]): fully_preserved - …`).join("\n"),
    detailed_description: `The target video is in a … style.\n${shots.join("\n")}`,
    overall_soundscape: "…", non_diegetic_music: "N/A",
  } as Record<string, string>)[key]}`).join("\n\n");
}

export function parseH3Optimization(result: string, original: string, references: H3Reference[], duration: number, maxDuration: number) {
  const parsed = h3ResultSchema.safeParse(JSON.parse(result.trim()));
  if (!parsed.success) throw new Error("模型返回的六段 JSON 字段不完整，原提示词已保留，请重试");
  const data = parsed.data;
  const prompt = h3Sections.map(([key]) => `${key}:\n${Array.isArray(data[key]) ? data[key].join("\n") : data[key]}`).join("\n\n");
  const dialogueLines = (text: string) => [...text.matchAll(/<d>([\s\S]*?)<\/d>/g)].map(match => match[1].trim().replace(/[.!?。！？~～\s]+$/, ""));
  const originalLines = dialogueLines(original);
  const nextLines = dialogueLines(prompt);
  if (originalLines.length && (originalLines.length !== nextLines.length || originalLines.some((line, index) => line !== nextLines[index]))) throw new Error("优化结果改动了原有对白，已保留原提示词，请重试");
  const originalDetail = h3SectionText(original, "detailed_description") || original;
  const originalShots = [...originalDetail.matchAll(/\[Shot\s+(\d+)\]/g)].map(match => match[1]);
  const nextShots = [...data.detailed_description.matchAll(/\[Shot\s+(\d+)\]/g)].map(match => match[1]);
  if (!nextShots.length) throw new Error("优化结果缺少分镜，原提示词已保留，请重试");
  if (originalShots.length && originalShots.join(",") !== nextShots.join(",")) throw new Error("优化结果改变了原有镜头序列，已保留原提示词，请重试");
  for (const pattern of [/<Subject\s+\d+>\s*\(S\d+(?:,\s*S\d+)*\)/g, /<scenetrans>|<cutoff>/g]) {
    const before: string[] = originalDetail.match(pattern) ?? [];
    const after: string[] = data.detailed_description.match(pattern) ?? [];
    // ACT: 已有结构按顺序保留；自然语言中的新增对白仍交给原文 Skill 处理。
    let offset = 0;
    if (before.some(value => { const index = after.indexOf(value, offset); offset = index + 1; return index < 0; })) throw new Error("优化结果改动了主体、说话人或对白衔接标签，原提示词已保留，请重试");
  }
  const taskPattern = /\[(?:reference generation|video editing|video continuation|audio reuse|audio reference)\]/g;
  const originalTasks = (h3SectionText(original, "summary") || original).match(taskPattern) ?? [];
  if (originalTasks.length && originalTasks.join(" ") !== (data.summary.match(taskPattern) ?? []).join(" ")) throw new Error("优化结果改变了任务类型，原提示词已保留，请重试");
  if (!(data.summary.match(taskPattern)?.length)) throw new Error("优化结果缺少 H3 任务类型，原提示词已保留，请重试");
  for (const line of original.split("\n").filter(line => /^<Audio \d+> is the voice-timbre reference for /.test(line))) {
    if (!data.subject_definitions.includes(line)) throw new Error("优化结果改写了音色参考句，原提示词已保留，请重试");
  }
  const seconds = Number(/\b(\d+(?:\.\d+)?)\s*[- ]?second\b/i.exec(data.summary)?.[1]) || duration;
  const cuts = [...data.detailed_description.matchAll(/At\s+(\d{2}):(\d{2})\.(\d{3})/g)].map(match => Number(match[1]) * 60 + Number(match[2]) + Number(match[3]) / 1000);
  const nextDuration = Math.ceil(Math.max(duration, seconds, nextShots.length >= 4 ? nextShots.length === 4 ? 12 : 13 : 0, cuts.length ? Math.max(...cuts) + 2.5 : 0));
  if (nextDuration > maxDuration) throw new Error(`优化结果需要约 ${nextDuration} 秒，超过当前模型的 ${maxDuration} 秒上限；原提示词已保留，请减少镜头或对白`);
  const issues = h3PromptIssues(prompt, references, nextDuration).filter(issue => !issue.startsWith("分镜正文"));
  if (issues.length) throw new Error(`优化结果格式不完整，原提示词已保留：${issues.join("；")}`);
  const summary = data.summary.replace(/\b\d+(?:\.\d+)?\s*[- ]?second\b/i, `${nextDuration}-second`);
  return { prompt: prompt.replace(`summary:\n${data.summary}`, () => `summary:\n${summary}`), duration: nextDuration };
}
