import { z } from "zod";
import { turnUsageSchema } from "./stats";

export const TURN_USAGE_ROW_KIND = "harness-turn-usage";
export const TURN_USAGE_ROW_VERSION = 1;

export const turnUsageRowSchema = z.object({
  turn: turnUsageSchema,
});
export type TurnUsageRowData = z.infer<typeof turnUsageRowSchema>;
