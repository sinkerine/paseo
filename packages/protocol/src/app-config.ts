import { z } from "zod";

export const AppConfigRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("get"), path: z.string().optional() }).strict(),
  z.object({ operation: z.literal("set"), path: z.string().min(1), value: z.unknown() }).strict(),
  z.object({ operation: z.literal("unset"), path: z.string().min(1) }).strict(),
  z.object({ operation: z.literal("shortcuts") }).strict(),
]);
export type AppConfigRequest = z.infer<typeof AppConfigRequestSchema>;

export const AppConfigResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: z.record(z.string(), z.unknown()) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type AppConfigResponse = z.infer<typeof AppConfigResponseSchema>;

export const AppConfigEndpointSchema = z.object({
  version: z.literal(1),
  port: z.number().int().min(1).max(65535),
  token: z.string().min(1),
});
