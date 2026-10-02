import { z } from "zod";

export type Viewer = {
  name: string;
  email: string;
  avatar: string | null;
  local: boolean;
};

const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[\w.:/-]+$/);
const text = z.string().max(2000);
const timestamp = z.iso
  .datetime({ offset: false })
  .transform((value) => new Date(value).toISOString());
const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const WatchPortSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  host: z.enum(["127.0.0.1", "::1"]).default("127.0.0.1"),
  port: z.number().int().min(1).max(65535),
});
export const WatchPortsSchema = z
  .array(WatchPortSchema)
  .max(32)
  .refine(
    (ports) =>
      new Set(ports.map((p) => `${p.host}:${p.port}`)).size === ports.length,
    "Duplicate watched port",
  );
export const PortCheckSchema = WatchPortSchema.extend({
  status: z.enum(["open", "closed", "timeout", "error"]),
  latencyMs: z.number().nonnegative().nullable(),
  checkedAt: timestamp,
});
const ConnectionObservation = z.strictObject({
  state: z.enum(["connected", "disconnected", "unknown"]),
  source: z.enum([
    "macos-reachability",
    "macos-vpn",
    "network-manager",
    "unsupported",
  ]),
  observedAt: timestamp,
});
export const SlowIntervalSchema = z
  .number()
  .int()
  .min(60)
  .max(3600)
  .default(300);
export const MachineTelemetrySchema = z.strictObject({
  sampleIntervalSeconds: z.literal(30).optional(),
  slowIntervalSeconds: SlowIntervalSchema.removeDefault().optional(),
  diskObservedAt: timestamp.optional(),
  network: ConnectionObservation.optional(),
  vpn: ConnectionObservation.optional(),
  temperature: z
    .discriminatedUnion("status", [
      z.strictObject({
        status: z.literal("available"),
        celsius: z.number().min(-20).max(150),
        source: z.literal("linux-cpu-thermal"),
        observedAt: timestamp,
      }),
      z.strictObject({
        status: z.literal("unavailable"),
        celsius: z.null(),
        source: z.enum(["unsupported", "linux-cpu-thermal"]),
        observedAt: timestamp,
      }),
    ])
    .optional(),
  observedAt: timestamp,
  resources: z
    .strictObject({
      cpuModel: z.string().max(240),
      cpuCores: z.number().int().positive().max(4096),
      cpuUsagePercent: z.number().min(0).max(100).nullable(),
      cpuSampleMs: z.number().positive(),
      loadAverage: z
        .tuple([
          z.number().nonnegative(),
          z.number().nonnegative(),
          z.number().nonnegative(),
        ])
        .nullable(),
      memory: z
        .strictObject({ totalBytes: bytes.positive(), freeBytes: bytes })
        .refine(
          (m) => m.freeBytes <= m.totalBytes,
          "Free memory exceeds total",
        ),
      disk: z
        .strictObject({ totalBytes: bytes.positive(), availableBytes: bytes })
        .refine(
          (d) => d.availableBytes <= d.totalBytes,
          "Available disk exceeds total",
        )
        .nullable(),
      uptimeSeconds: z.number().int().nonnegative(),
    })
    .nullable(),
  ports: z
    .array(PortCheckSchema)
    .max(32)
    .refine(
      (ports) =>
        new Set(ports.map((p) => `${p.host}:${p.port}`)).size === ports.length,
      "Duplicate watched port",
    ),
});
export type MachineTelemetry = z.infer<typeof MachineTelemetrySchema>;
export type PortCheck = z.infer<typeof PortCheckSchema>;
export const EvidenceSchema = z.strictObject({
  kind: z.enum(["summary", "goal", "git", "test", "process", "deployment"]),
  status: z.enum(["success", "failure", "running", "waiting", "unknown"]),
  summary: text,
  source: z.string().min(1).max(240),
  observedAt: timestamp,
  taskId: id,
  revision: z.string().max(100).optional(),
});
export const PaneSchema = z.strictObject({
  id,
  title: z.string().max(240),
  agent: z.string().max(80),
  hint: z.enum(["working", "idle", "done", "blocked", "unknown"]),
  task: z.strictObject({
    id,
    title: z.string().max(500),
    requiresDeployment: z.boolean(),
  }),
  rect: z
    .strictObject({
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      width: z.number().positive().max(1),
      height: z.number().positive().max(1),
    })
    .refine(
      (r) => r.x + r.width <= 1.001 && r.y + r.height <= 1.001,
      "Pane lies outside tab",
    ),
  evidence: z.array(EvidenceSchema).max(30),
});
export const SpaceSchema = z.strictObject({
  availability: z.literal("unavailable").optional(),
  id,
  name: z.string().min(1).max(240),
  session: z.string().min(1).max(100),
  objective: z.string().max(1000),
  tabs: z
    .array(
      z.strictObject({
        id,
        name: z.string().max(240),
        panes: z.array(PaneSchema).max(100),
      }),
    )
    .max(50),
});
export const ReportSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    reportId: id,
    capturedAt: timestamp,
    machine: z.strictObject({
      id: z
        .string()
        .min(1)
        .max(80)
        .regex(/^[a-z0-9][a-z0-9_-]*$/),
      name: z.string().min(1).max(120),
      platform: z.string().max(80),
      collectorVersion: z.string().max(80),
      telemetry: MachineTelemetrySchema.optional(),
    }),
    spaces: z.array(SpaceSchema).max(200),
    warnings: z.array(z.string().max(500)).max(100),
  })
  .superRefine((report, ctx) => {
    const unique = (ids: string[]) => new Set(ids).size === ids.length;
    if (!unique(report.spaces.map((s) => s.id)))
      ctx.addIssue({ code: "custom", message: "Duplicate space ID" });
    let count = 0;
    for (const space of report.spaces) {
      const panes = space.tabs.flatMap((t) => t.panes);
      count += panes.length;
      if (
        !unique(space.tabs.map((t) => t.id)) ||
        !unique(panes.map((p) => p.id))
      )
        ctx.addIssue({ code: "custom", message: "Duplicate tab/pane ID" });
    }
    if (count > 1000)
      ctx.addIssue({ code: "custom", message: "Too many panes" });
  });
export const HeartbeatSchema = z.strictObject({
  schemaVersion: z.literal(1),
  machineId: id,
  sentAt: timestamp,
  warning: z.string().max(500).optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;
export type Pane = z.infer<typeof PaneSchema>;
export type Space = z.infer<typeof SpaceSchema>;
export type Report = z.infer<typeof ReportSchema>;
export type State = "verified" | "active" | "attention" | "unverified";
export const STATE_LABEL: Record<State, string> = {
  verified: "已验证完成",
  active: "进行中",
  attention: "需关注",
  unverified: "待核实",
};
export type MachineView = {
  summaries?: import("./summaries.ts").PaneSummary[];
  manager?: import("./summaries.ts").ManagerState | null;
  id: string;
  name: string;
  lastSeen: string;
  receivedAt: string;
  warning: string | null;
  report: Report;
  revision: number;
  changes: string[];
  changedAt: string | null;
};
export type Overview = {
  now: string;
  machines: MachineView[];
  pendingMachines: string[];
};
export type HistoryEntry = {
  seq: number;
  receivedAt: string;
  report: Report;
  changes: string[];
};
