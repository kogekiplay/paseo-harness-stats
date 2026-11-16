import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const mobilePlacementSchema = z.enum(["footer", "track"]);
export const valuesSchema = z
  .object({
    enabled: z.boolean().default(true),
    mobilePlacement: mobilePlacementSchema.default("footer"),
  })
  .strict();
export type HarnessPreferences = z.infer<typeof valuesSchema>;

export const preferences = defineSettings({
  id: "harness-stats",
  scope: "host",
  version: 1,
  schema: valuesSchema,
});
