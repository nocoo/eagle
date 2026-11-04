import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import {
  canonicalDeviceJSON,
  DeviceId,
  type DeviceObservation,
  DevicePolicy,
  deviceDigest,
  OperationRequest,
  OperationResult,
  PolicyResultFrame,
  PolicySetRequest,
  type PolicySetResult,
  verifyApproval,
} from "../../../../packages/contracts/src/devices.ts";
import { deviceJSON } from "./device-registry.ts";
import type { DeviceServiceEnv } from "./device-service.ts";

const authFrame = z.strictObject({
  type: z.literal("authenticate"),
  sessionToken: z.string().max(200),
  capabilities: z.array(z.string().max(80)).max(32),
  policy: DevicePolicy,
});
const callerFrame = z.strictObject({
  type: z.literal("request"),
  sessionToken: z.string().max(200),
  request: OperationRequest,
});
const heartbeat = z.strictObject({
  type: z.literal("heartbeat"),
  capabilities: z.array(z.string().max(80)).max(32),
  policy: DevicePolicy,
});
const resultFrame = z.strictObject({
  type: z.literal("result"),
  requestId: DeviceId,
  operationId: DeviceId,
  targetDeviceId: DeviceId,
  result: OperationResult,
});
type Agent = {
  socket: WebSocket;
  token: string;
  deviceId: string;
  expires: number;
  credentialVersion: number;
};
type Pending = {
  socket: WebSocket;
  agentSocket: WebSocket;
  request: OperationRequest;
  token: string;
  timer: ReturnType<typeof setTimeout>;
};
type PendingPolicy = {
  agent: Agent;
  request: PolicySetRequest;
  token: string;
  resolve: (value: PolicySetResult) => void;
  timer: ReturnType<typeof setTimeout>;
};
class DeviceAuthenticationError extends Error {}
export class DeviceExecution extends DurableObject<DeviceServiceEnv> {
  private agent?: Agent;
  private pending = new Map<string, Pending>();
  private policies = new Map<string, PendingPolicy>();
  private lease?: ReturnType<typeof setTimeout>;
  constructor(ctx: DurableObjectState, env: DeviceServiceEnv) {
    super(ctx, env);
  }
  observation(): DeviceObservation {
    const previous = this.ctx.storage.kv.get<DeviceObservation>("observation");
    return previous
      ? { ...previous, online: !!this.agent && this.agent.expires > Date.now() }
      : { online: null, lastSeenAt: null, capabilities: null, policy: null };
  }
  private observe(capabilities: string[], policy: DevicePolicy): void {
    const value: DeviceObservation = {
      online: true,
      lastSeenAt: Date.now(),
      capabilities,
      policy,
    };
    this.ctx.storage.kv.put("observation", value);
    if (this.agent) this.agent.expires = Date.now() + 30000;
    clearTimeout(this.lease);
    this.lease = setTimeout(() => {
      this.agent?.socket.close(1008, "lease_expired");
      this.agent = undefined;
      this.failPending("target_offline");
    }, 30000);
  }
  private send(socket: WebSocket, value: unknown): void {
    try {
      socket.send(JSON.stringify(value));
    } catch {
      /* Disconnection does not certify execution outcome. */
    }
  }
  private respond(
    socket: WebSocket,
    request: OperationRequest,
    result: OperationResult,
    unauthorized = false,
  ): void {
    this.send(socket, {
      type: "response",
      requestId: request.requestId,
      operationId: request.operationId,
      targetDeviceId: request.targetDeviceId,
      result,
    });
    try {
      socket.close(
        unauthorized ? 1008 : 1000,
        unauthorized ? "unauthorized_caller" : "response",
      );
    } catch {}
  }
  private failPending(error: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      this.respond(pending.socket, pending.request, {
        status: "unknown",
        error,
      });
    }
    this.pending.clear();
    for (const pending of this.policies.values()) {
      clearTimeout(pending.timer);
      pending.resolve({
        error: "policy_result_unknown_refresh_target",
        status: 504,
      });
    }
    this.policies.clear();
  }
  async setPolicy(
    token: string,
    input: PolicySetRequest,
  ): Promise<PolicySetResult> {
    const request = PolicySetRequest.parse(input);
    const registry = this.env.DEVICE_REGISTRY.getByName("registry");
    const source = await registry.check(token, request.deviceId);
    if (!source.ok) return { error: source.error, status: source.status };
    const agent = this.agent;
    if (!agent || agent.expires <= Date.now())
      return { error: "target_offline", status: 503 };
    if (!this.observation().capabilities?.includes("policy.manage"))
      return { error: "target_management_unsupported", status: 409 };
    const target = await registry.check(agent.token, request.deviceId);
    if (!target.ok) return { error: "revoked_agent", status: 403 };
    const final = await registry.check(token, request.deviceId);
    if (!final.ok) return { error: final.error, status: final.status };
    if (
      this.agent !== agent ||
      agent.expires <= Date.now() ||
      final.target.credentialVersion !== agent.credentialVersion
    )
      return { error: "target_offline", status: 503 };
    if (this.pending.size + this.policies.size >= 64)
      return { error: "policy_management_busy", status: 429 };
    const relayId = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.policies.delete(relayId);
        resolve({ error: "policy_result_unknown_refresh_target", status: 504 });
      }, 8000);
      this.policies.set(relayId, { agent, token, request, resolve, timer });
      this.send(agent.socket, {
        type: "policy.set",
        relayId,
        sourceDeviceId: final.source.deviceId,
        request,
      });
    });
  }
  async fetch(request: Request): Promise<Response> {
    const match = new URL(request.url).pathname.match(
      /\/execution\/([^/]+)\/(agent|request)$/,
    );
    if (
      !match ||
      !DeviceId.safeParse(match[1]).success ||
      request.method !== "GET"
    )
      return deviceJSON({ error: "not_found" }, 404);
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return deviceJSON({ error: "websocket_required" }, 426);
    const targetId = DeviceId.parse(match[1]);
    const role = match[2];
    const pair = new WebSocketPair();
    const client = pair[0];
    const socket = pair[1];
    socket.accept();
    let authenticated = false;
    let handled = false;
    let chain = Promise.resolve();
    let closedFlag = false;
    let receivedFrames = 0;
    let queuedFrames = 0;
    let queuedBytes = 0;
    const live = () => !closedFlag && socket.readyState === 1;
    const timeout = setTimeout(() => {
      closed();
      socket.close(1008, "authentication_timeout");
    }, 5000);
    const closed = () => {
      closedFlag = true;
      clearTimeout(timeout);
      if (this.agent?.socket === socket) {
        this.agent = undefined;
        clearTimeout(this.lease);
        this.failPending("target_disconnected_query_original_id");
      }
      for (const [id, pending] of this.pending)
        if (pending.socket === socket) {
          clearTimeout(pending.timer);
          this.pending.delete(id);
        }
    };
    socket.addEventListener("message", (event) => {
      if (!live()) return;
      const bytes =
        typeof event.data === "string"
          ? new TextEncoder().encode(event.data).length
          : 524289;
      if (
        bytes > 524288 ||
        queuedFrames >= 16 ||
        queuedBytes + bytes > 1048576 ||
        (role === "request" && receivedFrames >= 1)
      ) {
        closed();
        socket.close(1008, "frame_or_queue_limit");
        return;
      }
      receivedFrames++;
      queuedFrames++;
      queuedBytes += bytes;
      chain = chain
        .then(async () => {
          if (!live()) return;
          if (typeof event.data !== "string") throw new Error("frame_limit");
          const data: unknown = JSON.parse(event.data);
          if (role === "agent") {
            if (!authenticated) {
              const auth = authFrame.parse(data);
              const checked = await this.env.DEVICE_REGISTRY.getByName(
                "registry",
              ).check(auth.sessionToken, targetId);
              if (!live()) return;
              if (!checked.ok || checked.source.deviceId !== targetId)
                throw new DeviceAuthenticationError("unauthorized_agent");
              if (this.agent) {
                this.agent.socket.close(1008, "agent_replaced");
                this.failPending("agent_replaced");
              }
              this.agent = {
                socket,
                token: auth.sessionToken,
                deviceId: targetId,
                expires: Date.now() + 30000,
                credentialVersion: checked.source.credentialVersion,
              };
              authenticated = true;
              clearTimeout(timeout);
              this.observe(auth.capabilities, auth.policy);
              this.send(socket, { type: "ready" });
              return;
            }
            if (this.agent?.socket !== socket)
              throw new Error("agent_replaced");
            const checked = await this.env.DEVICE_REGISTRY.getByName(
              "registry",
            ).check(this.agent.token, targetId);
            if (!live() || this.agent?.socket !== socket) return;
            if (!checked.ok)
              throw new DeviceAuthenticationError("revoked_agent");
            const beat = heartbeat.safeParse(data);
            if (beat.success) {
              this.observe(beat.data.capabilities, beat.data.policy);
              return;
            }
            const policy = PolicyResultFrame.safeParse(data);
            if (policy.success) {
              const message = policy.data;
              const pending = this.policies.get(message.relayId);
              if (
                !pending ||
                pending.agent.socket !== socket ||
                pending.request.requestId !== message.requestId ||
                message.deviceId !== targetId
              )
                return;
              const fresh = await this.env.DEVICE_REGISTRY.getByName(
                "registry",
              ).check(pending.token, targetId);
              if (
                !live() ||
                this.agent !== pending.agent ||
                this.policies.get(message.relayId) !== pending
              )
                return;
              clearTimeout(pending.timer);
              this.policies.delete(message.relayId);
              pending.resolve(
                !fresh.ok
                  ? { error: fresh.error, status: fresh.status }
                  : fresh.target.credentialVersion !==
                      pending.agent.credentialVersion
                    ? { error: "revoked_agent", status: 403 }
                    : message.policy
                      ? { policy: message.policy }
                      : {
                          error:
                            message.error ??
                            "policy_result_unknown_refresh_target",
                          status:
                            message.error === "policy_request_conflict"
                              ? 409
                              : 503,
                        },
              );
              return;
            }
            const message = resultFrame.parse(data);
            const pending = this.pending.get(message.requestId);
            if (
              !pending ||
              pending.agentSocket !== socket ||
              pending.request.operationId !== message.operationId ||
              message.targetDeviceId !== targetId
            )
              return;
            const fresh = await this.env.DEVICE_REGISTRY.getByName(
              "registry",
            ).check(pending.token, targetId);
            if (
              !live() ||
              this.agent?.socket !== socket ||
              this.pending.get(message.requestId) !== pending
            )
              return;
            clearTimeout(pending.timer);
            this.pending.delete(message.requestId);
            this.respond(
              pending.socket,
              pending.request,
              fresh.ok
                ? message.result
                : {
                    status: "unknown",
                    error: "membership_changed_query_original_id",
                  },
            );
            return;
          }
          if (handled) throw new Error("one_request_per_socket");
          handled = true;
          clearTimeout(timeout);
          const caller = callerFrame.parse(data);
          const operation = caller.request;
          if (operation.targetDeviceId !== targetId) {
            this.respond(socket, operation, {
              status: "denied",
              error: "wrong_target",
            });
            return;
          }
          const checked = await this.env.DEVICE_REGISTRY.getByName(
            "registry",
          ).check(caller.sessionToken, targetId);
          if (!live()) return;
          if (!checked.ok) {
            this.respond(
              socket,
              operation,
              {
                status: "denied",
                error: checked.error,
              },
              checked.status === 401,
            );
            return;
          }
          if (!this.agent || this.agent.expires <= Date.now()) {
            this.respond(socket, operation, {
              status: "unknown",
              error: "target_offline",
            });
            return;
          }
          const selectedAgent = this.agent;
          const target = await this.env.DEVICE_REGISTRY.getByName(
            "registry",
          ).check(this.agent.token, targetId);
          if (!live()) return;
          if (this.agent !== selectedAgent) {
            this.respond(socket, operation, {
              status: "unknown",
              error: "agent_changed",
            });
            return;
          }
          if (!target.ok) {
            selectedAgent.socket.close(1008, "revoked_agent");
            this.agent = undefined;
            this.respond(socket, operation, {
              status: "denied",
              error: "revoked_agent",
            });
            return;
          }
          const policy = this.observation().policy;
          if (operation.action === "run") {
            if (
              operation.operation?.kind === "native" ||
              (await deviceDigest(canonicalDeviceJSON(operation.operation))) !==
                operation.digest
            ) {
              this.respond(socket, operation, {
                status: "denied",
                error: "invalid_operation",
              });
              return;
            }
            if (
              !policy ||
              policy.mode === "paused" ||
              (policy.mode === "always-ask" &&
                !(await verifyApproval(
                  operation.approval,
                  operation,
                  checked.source,
                  policy,
                )))
            ) {
              this.respond(socket, operation, {
                status: "denied",
                error: "policy_confirmation_required",
              });
              return;
            }
          }
          // All digest/signature awaits precede the final authority read.
          // Revocation before forwarding must prevent target side effects.
          if (!live()) return;
          const agent = this.agent;
          const final = await this.env.DEVICE_REGISTRY.getByName(
            "registry",
          ).check(caller.sessionToken, targetId);
          if (!live()) return;
          if (
            !final.ok ||
            !agent ||
            this.agent !== agent ||
            agent.expires <= Date.now() ||
            final.target.credentialVersion !== agent.credentialVersion
          ) {
            this.respond(
              socket,
              operation,
              {
                status: "denied",
                error: "membership_or_agent_changed",
              },
              !final.ok && final.status === 401,
            );
            return;
          }
          if (
            operation.action === "run" &&
            (!policy ||
              this.observation().policy?.version !== policy.version ||
              (policy.mode === "always-ask" &&
                (!operation.approval ||
                  operation.approval.expiresAt <= Date.now())))
          ) {
            this.respond(socket, operation, {
              status: "denied",
              error: "policy_or_approval_changed",
            });
            return;
          }
          if (this.pending.size + this.policies.size >= 64) {
            this.respond(socket, operation, {
              status: "busy",
              error: "relay_busy",
            });
            return;
          }
          const relayId = crypto.randomUUID();
          const timer = setTimeout(
            () => {
              const pending = this.pending.get(relayId);
              if (pending) {
                this.pending.delete(relayId);
                this.respond(socket, operation, {
                  status: "unknown",
                  error: "response_timeout_query_original_id",
                });
              }
            },
            operation.operation?.kind === "command"
              ? (operation.operation.timeoutMs ?? 30000) + 5000
              : 35000,
          );
          this.pending.set(relayId, {
            agentSocket: agent.socket,
            socket,
            request: operation,
            token: caller.sessionToken,
            timer,
          });
          this.send(agent.socket, {
            type: "operation",
            sourceDeviceId: final.source.deviceId,
            sourcePublicKey: final.source.publicKey,
            request: { ...operation, requestId: relayId },
          });
        })
        .catch((error) => {
          closed();
          try {
            socket.close(
              1008,
              error instanceof DeviceAuthenticationError
                ? error.message
                : "invalid_or_unauthorized_frame",
            );
          } catch {}
        })
        .finally(() => {
          queuedFrames--;
          queuedBytes -= bytes;
        });
      this.ctx.waitUntil(chain);
    });
    socket.addEventListener("close", closed);
    socket.addEventListener("error", closed);
    return new Response(null, { status: 101, webSocket: client });
  }
}
