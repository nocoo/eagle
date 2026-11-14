import { z } from "zod";
import {
  SlowIntervalSchema,
  WatchPortsSchema,
} from "../contracts/src/schema.ts";

// Unknown keys are ignored: an older secure config may still carry retired
// settings, and a collector that refuses to start costs more than a silent typo.
const ConfigSchema = z.object({
  url: z.string().url(),
  token: z.string().min(32),
  machineId: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  machineName: z.string().min(1),
  intervalSeconds: z.literal(30).default(30),
  slowIntervalSeconds: SlowIntervalSchema,
  codexDir: z.string().optional(),
  spoolDir: z.string().optional(),
  watchPorts: WatchPortsSchema.default([]),
});

export type AgentCliConfig = z.infer<typeof ConfigSchema>;
export const parseConfig = (value: unknown): AgentCliConfig =>
  ConfigSchema.parse(value);
