import { createInterface } from "node:readline";
import { join } from "node:path";
import { createReadStream, readdir, stat } from "@toonflow/file";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { cacheFile, readCache, writeCache } from "@/utils/cache";

type SessionSummary = { file: string; name: string; modified: string; messageCount: number };
export async function listSessionSummaries(directory: string) {
  const entries = (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isFile() && /^[\w-]+\.jsonl$/.test(entry.name));
  const summaries: SessionSummary[] = [];
  for (let offset = 0; offset < entries.length; offset += 4) {
    const page = await Promise.all(entries.slice(offset, offset + 4).map(async entry => {
      const source = join(directory, entry.name);
      const info = await stat(source);
      const revision = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      const path = cacheFile("sessionIndex", source);
      const cached = await readCache<{ revision: string; summary: SessionSummary | null }>(path);
      if (cached?.revision === revision) return cached.summary;
      const stream = createReadStream(source, { encoding: "utf8" });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      let name: string | undefined;
      let firstMessage = "";
      let messageCount = 0;
      let modified = 0;
      let valid = false;
      let child = false;
      try {
        for await (const line of lines) {
          const item = parseSessionEntries(line)[0];
          if (!item) continue;
          if (!valid) {
            if (item.type !== "session") break;
            valid = true;
            child = !!item.parentSession;
            if (child) break;
            continue;
          }
          if (item.type === "session_info") name = item.name?.trim() || undefined;
          if (item.type !== "message") continue;
          messageCount++;
          const time = Date.parse(item.timestamp);
          if (Number.isFinite(time)) modified = Math.max(modified, time);
          if (!firstMessage && item.message.role === "user") {
            const content = item.message.content;
            firstMessage = (typeof content === "string" ? content : content.filter(part => part.type === "text").map(part => part.text).join(" ")).trim().slice(0, 60);
          }
        }
      } finally { lines.close(); stream.destroy(); }
      const summary = valid && !child ? { file: entry.name, name: name || firstMessage || "新对话", modified: new Date(modified || info.mtimeMs).toISOString(), messageCount } : null;
      const after = await stat(source);
      if (after.size === info.size && after.mtimeMs === info.mtimeMs && after.ctimeMs === info.ctimeMs) await writeCache(path, { revision, summary });
      return summary;
    }));
    summaries.push(...page.filter((item): item is SessionSummary => !!item));
  }
  return summaries.sort((left, right) => Date.parse(right.modified) - Date.parse(left.modified));
}
