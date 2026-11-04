import { readFileSync } from "node:fs";
import { open, opendir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  canonicalDeviceJSON,
  type Device,
  DevicePolicy,
  deviceDigest,
  OperationRequest,
  OperationResult,
  PolicySetRequest,
  verifyApproval,
} from "../contracts/src/devices.ts";
import { runProcess } from "./device-command.ts";
import {
  OperationAdmissionError,
  OperationJournal,
  type OperationOutcome,
  type OperationRecord,
  type OperationScope,
} from "./device-journal.ts";
import { deviceOutcome } from "./device-output.ts";

function result(record: OperationRecord): OperationResult {
  return {
    status: record.state === "succeeded" ? "completed" : record.state,
    output: record.stdout,
    ...(record.stderr ? { error: record.stderr } : {}),
    exitCode: record.exitCode,
  };
}
function outcome(value: OperationResult): OperationOutcome {
  return {
    state:
      value.status === "completed"
        ? "succeeded"
        : value.status === "failed"
          ? "failed"
          : value.status === "cancelled"
            ? "cancelled"
            : "unknown",
    stdout: value.output ?? "",
    stderr: value.error ?? "",
    exitCode: value.exitCode ?? null,
  };
}
export class DeviceRuntime {
  readonly device: Device;
  readonly journal: OperationJournal;
  policy: DevicePolicy;
  private active = new Map<
    string,
    { controller: AbortController; promise: Promise<OperationResult> }
  >();
  private native = new Set<string>();
  private closed = false;
  private unhealthy = false;
  private secrets: () => string[];
  constructor(
    device: Device,
    path: string,
    secrets: () => string[] = () => [],
    bootSessionId?: string,
  ) {
    this.secrets = secrets;
    this.device = device;
    this.journal = new OperationJournal(path, 10_000, bootSessionId);
    this.native = new Set(this.journal.blockedNative());
    try {
      const saved = this.journal.policy();
      if (saved) this.policy = saved;
      else {
        let initial: DevicePolicy;
        try {
          initial = DevicePolicy.parse(
            JSON.parse(
              readFileSync(join(dirname(path), "policy.json"), "utf8"),
            ),
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          // A device nobody has decided about asks before it acts.
          initial = { mode: "always-ask", version: 1 };
        }
        this.policy = this.journal.policy(initial) as DevicePolicy;
      }
    } catch (error) {
      this.journal.close();
      throw new Error("Invalid persisted device policy", { cause: error });
    }
  }
  setPolicy(mode: DevicePolicy["mode"]): DevicePolicy {
    return this.persistPolicy(mode);
  }
  applyPolicy(input: PolicySetRequest, source: string): DevicePolicy {
    const request = PolicySetRequest.parse(input);
    if (request.deviceId !== this.device.deviceId)
      throw new OperationAdmissionError("wrong_target");
    const result = this.persistPolicy(request.mode, source, request);
    return result;
  }
  private persistPolicy(
    mode: DevicePolicy["mode"],
    source?: string,
    request?: PolicySetRequest,
  ): DevicePolicy {
    if (this.closed || this.unhealthy)
      throw new Error("policy_storage_unavailable");
    try {
      const result = this.journal.setPolicy(mode, source, request);
      this.policy = this.journal.policy() as DevicePolicy;
      return result;
    } catch (error) {
      if (error instanceof OperationAdmissionError) throw error;
      this.unhealthy = true;
      throw new Error("policy_result_unknown_refresh_target");
    }
  }
  private scope(source: Device, request: OperationRequest): OperationScope {
    return {
      kind: "device",
      sourceDeviceId: source.deviceId,
      targetDeviceId: request.targetDeviceId,
      ...(request.sourceBotId ? { sourceBotId: request.sourceBotId } : {}),
    };
  }
  private visible(id: string, source: Device): OperationRecord | null {
    const record = this.journal.get(id);
    const scope = this.journal.getScope(id);
    if (
      record &&
      (scope?.sourceDeviceId !== source.deviceId ||
        scope.targetDeviceId !== this.device.deviceId)
    )
      throw new OperationAdmissionError("operation_scope_mismatch");
    return record;
  }
  private async admit(
    input: OperationRequest,
    source: Device,
    native: boolean,
    sourceSignal?: AbortSignal,
  ): Promise<{ accepted: boolean; result: OperationResult }> {
    const parsed = OperationRequest.safeParse(input);
    if (this.unhealthy)
      return {
        accepted: false,
        result: { status: "unknown", error: "operation_storage_unavailable" },
      };
    if (!parsed.success || this.closed)
      return {
        accepted: false,
        result: { status: "denied", error: "invalid_request" },
      };
    const request = parsed.data;
    if (sourceSignal?.aborted)
      return {
        accepted: false,
        result: { status: "denied", error: "remote_connection_retired" },
      };
    if (
      request.action !== "run" ||
      request.targetDeviceId !== this.device.deviceId ||
      !request.operation ||
      (request.operation.kind === "native") !== native
    )
      return {
        accepted: false,
        result: { status: "denied", error: "invalid_operation_target" },
      };
    const digest = await deviceDigest(canonicalDeviceJSON(request.operation));
    if (digest !== request.digest)
      return {
        accepted: false,
        result: { status: "denied", error: "digest_mismatch" },
      };
    const fingerprint = await deviceDigest(
      canonicalDeviceJSON({
        sourceDeviceId: source.deviceId,
        targetDeviceId: request.targetDeviceId,
        digest,
        sourceBotId: request.sourceBotId,
      }),
    );
    if (sourceSignal?.aborted)
      return {
        accepted: false,
        result: { status: "denied", error: "remote_connection_retired" },
      };
    const existing = this.visible(request.operationId, source);
    if (existing) {
      this.journal.begin(
        request.operationId,
        fingerprint,
        this.scope(source, request),
      );
      return { accepted: false, result: result(existing) };
    }
    const policy = this.policy;
    if (
      policy.mode === "paused" ||
      (policy.mode === "always-ask" &&
        !(await verifyApproval(request.approval, request, source, policy))) ||
      this.policy.version !== policy.version ||
      this.closed
    )
      return {
        accepted: false,
        result: { status: "denied", error: "policy_confirmation_required" },
      };
    if (sourceSignal?.aborted)
      return {
        accepted: false,
        result: { status: "denied", error: "remote_connection_retired" },
      };
    // Recheck synchronously after signature verification yields: another request
    // may have admitted this ID while awaiting WebCrypto.
    const duplicate = this.visible(request.operationId, source);
    if (duplicate) {
      this.journal.begin(
        request.operationId,
        fingerprint,
        this.scope(source, request),
      );
      return { accepted: false, result: result(duplicate) };
    }
    if (this.active.size || this.native.size)
      return { accepted: false, result: { status: "busy" } };
    const admission = this.journal.begin(
      request.operationId,
      fingerprint,
      this.scope(source, request),
      native,
    );
    if (!admission.created)
      return { accepted: false, result: result(admission.operation) };
    this.native.add(request.operationId);
    return { accepted: true, result: { status: "running" } };
  }
  async beginNative(
    request: OperationRequest,
    source: Device,
  ): Promise<{ accepted: boolean; result: OperationResult }> {
    try {
      if (source.deviceId !== this.device.deviceId)
        return { accepted: false, result: { status: "denied" } };
      return await this.admit(request, source, true);
    } catch (error) {
      if (
        error instanceof OperationAdmissionError ||
        error instanceof z.ZodError
      )
        return {
          accepted: false,
          result: { status: "denied", error: "operation_conflict" },
        };
      this.unhealthy = true;
      return {
        accepted: false,
        result: { status: "unknown", error: "operation_storage_unavailable" },
      };
    }
  }
  completeNative(operationId: string, value: OperationResult): OperationResult {
    if (!this.native.has(operationId))
      return { status: "denied", error: "native_not_running" };
    const parsed = OperationResult.parse(value);
    if (
      !["completed", "failed", "cancelled", "unknown"].includes(parsed.status)
    )
      return { status: "denied", error: "invalid_completion" };
    const settled = parsed.status !== "unknown";
    try {
      const stored = this.journal.finish(
        operationId,
        deviceOutcome(outcome(parsed), this.secrets()),
        settled,
      );
      if (settled) this.native.delete(operationId);
      return result(stored);
    } catch {
      this.unhealthy = true;
      return { status: "unknown", error: "operation_storage_unavailable" };
    }
  }
  abandonNative(operationId: string): OperationResult {
    if (!this.native.has(operationId)) return { status: "unknown" };
    const stored = this.journal.finish(operationId, {
      state: "unknown",
      stdout: "",
      stderr: "native_owner_disconnected_or_lease_expired",
      exitCode: null,
    });
    return result(stored);
  }
  async handle(
    input: OperationRequest,
    source: Device,
    sourceSignal?: AbortSignal,
  ): Promise<OperationResult> {
    try {
      if (sourceSignal?.aborted)
        return { status: "denied", error: "remote_connection_retired" };
      const request = OperationRequest.parse(input);
      if (this.unhealthy)
        return { status: "unknown", error: "operation_storage_unavailable" };
      if (request.targetDeviceId !== this.device.deviceId)
        return { status: "denied", error: "wrong_target" };
      if (request.action !== "run") {
        const record = this.visible(request.operationId, source);
        if (!record) return { status: "unknown" };
        if (request.action === "cancel")
          this.active.get(request.operationId)?.controller.abort();
        return result(record);
      }
      if (request.operation?.kind === "native")
        return { status: "denied", error: "native_requires_local_begin" };
      const admitted = await this.admit(request, source, false, sourceSignal);
      if (!admitted.accepted) return admitted.result;
      const controller = new AbortController();
      const promise = Promise.resolve().then(async () => {
        let value: OperationOutcome;
        try {
          value = await this.execute(request, controller.signal);
        } catch {
          value = {
            state: "failed",
            stdout: "",
            stderr: "execution_failed",
            exitCode: null,
          };
        }
        try {
          const stored = this.journal.finish(
            request.operationId,
            deviceOutcome(value, this.secrets()),
          );
          this.active.delete(request.operationId);
          return result(stored);
        } catch {
          this.unhealthy = true;
          return {
            status: "unknown",
            error: "operation_storage_unavailable",
          } as OperationResult;
        }
      });
      this.active.set(request.operationId, { controller, promise });
      this.native.delete(request.operationId);
      return await promise;
    } catch (error) {
      if (
        error instanceof OperationAdmissionError ||
        error instanceof z.ZodError
      )
        return { status: "denied", error: "operation_conflict" };
      this.unhealthy = true;
      return { status: "unknown", error: "operation_storage_unavailable" };
    }
  }
  private async execute(
    request: OperationRequest,
    signal: AbortSignal,
  ): Promise<OperationOutcome> {
    const operation = request.operation;
    if (!operation) throw new Error("missing_operation");
    const empty = { stdout: "", stderr: "", exitCode: null };
    if (operation.kind === "command")
      return runProcess(
        {
          program: "/bin/sh",
          args: ["-c", operation.command],
          cwd: operation.cwd ?? process.env.HOME ?? process.cwd(),
          timeoutMs: operation.timeoutMs ?? 30000,
        },
        signal,
        this.secrets(),
        {
          PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
          HOME: process.env.HOME,
          LANG: "en_US.UTF-8",
          TMPDIR: process.env.TMPDIR,
        },
      );
    if (operation.kind === "native") throw new Error("invalid_native");
    const path = resolve(operation.path);
    if (signal.aborted) return { ...empty, state: "cancelled" };
    let output = "";
    if (operation.kind === "file.read") {
      const file = await open(path, "r");
      try {
        const buffer = Buffer.alloc(65536);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        output = buffer.subarray(0, bytesRead).toString("utf8");
      } finally {
        await file.close();
      }
    } else if (operation.kind === "file.write") {
      await writeFile(path, operation.content, { signal });
      output = "written";
    } else {
      const directory = await opendir(path);
      const names: string[] = [];
      for await (const entry of directory) {
        names.push(entry.name);
        if (names.length >= 1000) break;
      }
      output = JSON.stringify(names);
    }
    for (const secret of this.secrets())
      if (secret) output = output.replaceAll(secret, "[REDACTED]");
    return { ...empty, state: "succeeded", stdout: output, exitCode: 0 };
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const value of this.active.values()) value.controller.abort();
    await Promise.all([...this.active.values()].map((x) => x.promise));
    this.journal.close();
  }
}
