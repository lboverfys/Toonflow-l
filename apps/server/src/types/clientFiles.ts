import { z } from "zod";

export const clientDirectorySchema = z.strictObject({ id: z.uuid(), name: z.string().min(1).max(4096) });
export const clientFileRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("list"), path: z.string().max(4096), cursor: z.uuid().optional() }),
  z.strictObject({ action: z.literal("read"), path: z.string().min(1).max(4096), offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(), revision: z.string().max(256).optional() }),
]);
export const clientFileResultSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("list"), path: z.string().max(4096), entries: z.array(z.strictObject({ name: z.string().max(255), type: z.enum(["file", "directory"]) })).max(200), cursor: z.uuid().optional() }),
  z.strictObject({ action: z.literal("read"), path: z.string().max(4096), text: z.string().max(32768), offset: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative().nullable(), size: z.number().int().nonnegative(), revision: z.string().max(256), encoding: z.enum(["utf-8", "utf-16le", "utf-16be"]) }),
]);
