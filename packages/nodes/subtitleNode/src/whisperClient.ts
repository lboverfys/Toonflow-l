import type { WhisperCheckResult, WhisperRequest, WhisperTask } from "@toonflow/server/whisper/types";

export class WhisperHttpError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
    this.name = "WhisperHttpError";
  }
}

async function request<T>(path: string, input: Record<string, unknown>, method: "GET" | "POST") {
  const query = method === "GET" ? `?${new URLSearchParams(Object.entries(input).map(([key, value]) => [key, String(value)]))}` : "";
  const response = await fetch(`/api/whisper/${path}${query}`, {
    method,
    headers: { "content-type": "application/json", "x-toonflow-workspace": "1" },
    ...(method === "POST" ? { body: JSON.stringify(input) } : {}),
  });
  const body = await response.json() as { code: number; data: T & { code?: string }; message: string };
  if (!response.ok || body.code !== 200) throw new WhisperHttpError(body.message || "Whisper 请求失败", response.status, body.data?.code);
  return body.data;
}

export const whisperClient = {
  check: (directory: string) => request<WhisperCheckResult>("check", { directory }, "GET"),
  start: (input: WhisperRequest) => request<WhisperTask>("start", input, "POST"),
  task: (directory: string, operationId: string) => request<WhisperTask>("task", { directory, operationId }, "GET"),
  cancel: (directory: string, operationId: string) => request<WhisperTask>("cancel", { directory, operationId }, "POST"),
};
