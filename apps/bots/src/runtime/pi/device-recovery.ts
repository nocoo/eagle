import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type ConversationId,
  type EntryId,
  type Harness,
  LiveDoc,
  type TaskId,
} from "@earendil-works/pi-durable";
import { z } from "zod";
import { deviceReceipt } from "../../tools/devices/output.ts";
import {
  type DeviceOperation,
  type DeviceRequest,
  operationDigest,
} from "../../tools/devices/port.ts";
import type { RemoteCapability } from "../../tools/registry.ts";

const inputSchema = z.object({
  kind: z.literal("model"),
  assistant: z.number(),
  callId: z.string(),
});
const checkpointSchema = z.object({
  phase: z.literal("execute"),
  arguments: z.record(z.string(), z.json()),
});
const operationSchema = z.record(z.string(), z.json());
const memoSchema = z.strictObject({
  requestId: z.uuid(),
  operationId: z.uuid(),
  targetDeviceId: z.uuid(),
  sourceBotId: z.string(),
  relayOrigin: z.url().optional(),
  action: z.literal("run"),
  operation: operationSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});
const querySchema = z.object({
  deviceId: z.uuid(),
  operationId: z.uuid(),
  action: z.enum(["get", "cancel"]),
});

// SDK 1.4.0's interrupted settlement consumes LiveDoc progress before discarding task memos.
export async function retainInterruptedDeviceReceipts(
  harness: Harness,
  rootId: ConversationId,
  botId: string,
  capability: RemoteCapability,
): Promise<void> {
  if (capability === "configured") return;
  const inspection = await harness.inspect(BACKGROUND_CONTEXT);
  if (inspection.scheduling !== "paused") throw new Error("device_recovery_scheduler_running");
  const candidates = inspection.tasks
    .map(({ record }) => record)
    .filter((record) => record.conversationId === rootId && record.kind === "pi.tool");
  if (candidates.length === 0) return;
  await harness.commit(async (tx) => {
    const receipts: { taskId: TaskId; callId: string; text: string; details: JsonValue }[] = [];
    for (const candidate of candidates) {
      const task = await tx.task(candidate.id);
      if (!task || task.state.status === "completing" || task.state.status === "terminal") continue;
      const input = inputSchema.safeParse(task.input);
      const checkpoint = checkpointSchema.safeParse(task.state.checkpoint);
      if (!input.success || !checkpoint.success) continue;
      const entry = await tx.entry(input.data.assistant as EntryId);
      if (entry?.conversationId !== rootId) continue;
      const call = entry.model
        ?.flatMap((message) => (message.role === "assistant" ? message.content : []))
        .find((part) => part.type === "toolCall" && part.id === input.data.callId);
      if (call?.type !== "toolCall") continue;
      let request: DeviceRequest;
      if (call.name === "remote_execute") {
        const raw = task.memos?.["device.operation.v1"];
        if (raw === undefined) continue;
        const memo = memoSchema.parse(raw);
        const argument = z
          .object({ deviceId: z.uuid(), operation: operationSchema })
          .parse(checkpoint.data.arguments);
        const operation = memo.operation as DeviceOperation;
        if (
          memo.sourceBotId !== botId ||
          typeof operation.kind !== "string" ||
          !["command", "file.read", "file.list", "file.write"].includes(operation.kind) ||
          memo.targetDeviceId !== argument.deviceId ||
          operationDigest(operation) !== memo.digest ||
          operationDigest(argument.operation as DeviceOperation) !== memo.digest
        ) {
          throw new Error("device_recovery_binding_invalid");
        }
        const { relayOrigin, ...binding } = memo;
        request = { ...binding, operation, ...(relayOrigin === undefined ? {} : { relayOrigin }) };
      } else if (call.name === "remote_operation") {
        const argument = querySchema.parse(checkpoint.data.arguments);
        request = {
          requestId: argument.operationId,
          operationId: argument.operationId,
          targetDeviceId: argument.deviceId,
          sourceBotId: botId,
          action: argument.action,
        };
      } else {
        continue;
      }
      const result = deviceReceipt(request, {
        status: "unknown",
        error:
          capability === "unconfigured" ? "remote_not_configured" : "device_service_unavailable",
      });
      const text = result.output?.find((part) => part.type === "text")?.text;
      if (!text || result.structuredOutput === undefined)
        throw new Error("device_recovery_receipt_invalid");
      receipts.push({
        taskId: task.id,
        callId: input.data.callId,
        text,
        details: result.structuredOutput,
      });
    }
    if (receipts.length === 0) return;
    const live = await tx.doc(LiveDoc, rootId);
    for (const receipt of receipts) {
      const slot = live.tools?.find(
        (item) => item.taskId === receipt.taskId && item.callId === receipt.callId,
      );
      if (!slot) throw new Error("device_recovery_slot_missing");
      slot.output = receipt.text;
      slot.details = receipt.details;
      delete slot.droppedBytes;
      delete slot.droppedLines;
    }
  }, BACKGROUND_CONTEXT);
}
