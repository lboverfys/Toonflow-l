export interface SubtitleSegment {
  start: number;
  end: number;
  text: string;
}

const timePattern = /^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/;

export function parseSrtTime(value: string): number {
  const match = timePattern.exec(value);
  if (!match) throw new Error(`无效的 SRT 时间：${value}`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const milliseconds = Number(match[4]);
  if (minutes > 59 || seconds > 59) throw new Error(`无效的 SRT 时间：${value}`);
  return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
}

export function formatSrtTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error("SRT 时间必须是有限的非负数");
  const milliseconds = Math.round(seconds * 1000);
  if (!Number.isSafeInteger(milliseconds)) throw new Error("SRT 时间超出安全范围");
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const wholeSeconds = totalSeconds % 60;
  const remainder = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")},${String(remainder).padStart(3, "0")}`;
}

export function parseSrt(source: string): SubtitleSegment[] {
  if (typeof source !== "string") throw new Error("SRT 内容必须是字符串");
  const normalized = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const blocks = normalized.split(/\n[ \t]*\n/).filter((block) => block.trim());
  if (!blocks.length) return [];
  const segments: SubtitleSegment[] = [];
  let previousStart = 0;
  blocks.forEach((block, index) => {
    const lines = block.split("\n");
    if (lines.length < 3 || !/^\d+$/.test(lines[0].trim())) throw new Error(`第 ${index + 1} 个 SRT 分段序号无效`);
    const timing = lines[1].trim().match(/^([^ ]+)\s+-->\s+([^ ]+)$/);
    if (!timing) throw new Error(`第 ${index + 1} 个 SRT 分段时间轴无效`);
    const start = parseSrtTime(timing[1]);
    const end = parseSrtTime(timing[2]);
    const text = lines.slice(2).join("\n");
    if (!text.trim()) throw new Error(`第 ${index + 1} 个 SRT 分段文本为空`);
    if (!(start < end)) throw new Error(`第 ${index + 1} 个 SRT 分段时间范围无效`);
    if (segments.length && start < previousStart) throw new Error("SRT 分段必须按开始时间递增");
    previousStart = start;
    segments.push({ start, end, text });
  });
  return segments;
}

export function serializeSrt(segments: SubtitleSegment[]): string {
  if (!Array.isArray(segments)) throw new Error("SRT 分段必须是数组");
  let previousStart = 0;
  const blocks = segments.map((segment, index) => {
    if (typeof segment.text !== "string" || !segment.text.trim()) throw new Error(`第 ${index + 1} 个 SRT 分段文本为空`);
    if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.start < 0 || segment.end < 0) throw new Error(`第 ${index + 1} 个 SRT 分段时间无效`);
    if (!(segment.start < segment.end)) throw new Error(`第 ${index + 1} 个 SRT 分段时间范围无效`);
    if (index && segment.start < previousStart) throw new Error("SRT 分段必须按开始时间递增");
    previousStart = segment.start;
    return `${index + 1}\r\n${formatSrtTime(segment.start)} --> ${formatSrtTime(segment.end)}\r\n${segment.text}`;
  });
  return blocks.length ? `${blocks.join("\r\n\r\n")}\r\n` : "";
}
