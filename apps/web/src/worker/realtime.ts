import { createHash } from "node:crypto";
import {
  AgentMessageSchema,
  type Subscription,
  ViewerMessageSchema,
} from "../../../../packages/contracts/src/realtime.ts";

type Attachment = {
  role: "agent" | "viewer";
  id: string;
  expires: number;
  seen: number;
  credentialId: string | null;
  styledFrames?: boolean;
  spaceId?: string;
  subscriptionId?: string;
  control?: boolean;
  seq?: number;
  pending?: number;
  panes?: string[];
  delivery?: number;
  deliveryBytes?: number;
  rendered?: number;
  renderedBytes?: number;
};
const paneKey = (paneId: string, terminalId: string) =>
  createHash("sha256")
    .update(JSON.stringify([paneId, terminalId]))
    .digest("base64url")
    .slice(0, 22);
export async function scheduleEarlier(ctx: DurableObjectState, when: number) {
  if (!Number.isFinite(when)) return;
  const previous = await ctx.storage.getAlarm();
  if (previous === null || when < previous) await ctx.storage.setAlarm(when);
}
// Attachments contain routing/leases only. Terminal text and inputs are never persisted.
export class LiveRelay {
  constructor(
    private ctx: DurableObjectState,
    private authorized: (id: string | null) => boolean,
  ) {}
  private sockets() {
    return this.ctx
      .getWebSockets("live")
      .filter((s) => s.readyState === WebSocket.OPEN);
  }
  private meta(s: WebSocket) {
    return s.deserializeAttachment() as Attachment;
  }
  private send(s: WebSocket, value: unknown) {
    const meta = this.meta(s);
    if (
      meta.role === "viewer" &&
      !meta.styledFrames &&
      (value as { type?: string }).type === "frame"
    ) {
      const { runs: _runs, ...plain } = value as Record<string, unknown>;
      value = plain;
    }
    let payload = JSON.stringify(value);
    if (
      meta.role === "viewer" &&
      (value as { type?: string }).type === "frame"
    ) {
      const id = (meta.delivery ?? 0) + 1;
      const bytes =
        (meta.deliveryBytes ?? 0) +
        new TextEncoder().encode(payload).length +
        100;
      if (
        bytes - (meta.renderedBytes ?? 0) > 2 * 1024 * 1024 ||
        id - (meta.rendered ?? 0) > 128
      ) {
        s.close(1013, "Slow viewer");
        this.subscriptions();
        return;
      }
      meta.delivery = id;
      meta.deliveryBytes = bytes;
      payload = JSON.stringify({
        ...(value as object),
        deliveryId: id,
        deliveryBytes: bytes,
      });
      s.serializeAttachment(meta);
    }
    try {
      s.send(payload);
    } catch {
      s.close(1011, "Connection failed");
    }
  }
  private agent() {
    return this.sockets().find((s) => this.meta(s).role === "agent");
  }
  private viewers(spaceId?: string) {
    return this.sockets().filter((s) => {
      const a = this.meta(s);
      return a.role === "viewer" && (!spaceId || a.spaceId === spaceId);
    });
  }
  private status() {
    for (const s of this.viewers())
      this.send(s, {
        type: "status",
        online: !!this.agent(),
        control: !!this.meta(s).control,
      });
  }
  private subscriptions() {
    const spaces = new Map<string, Subscription>();
    for (const s of this.viewers()) {
      const a = this.meta(s);
      if (a.spaceId && a.subscriptionId)
        spaces.set(a.spaceId, {
          spaceId: a.spaceId,
          subscriptionId: a.subscriptionId,
        });
    }
    const agent = this.agent();
    if (agent)
      this.send(agent, {
        type: "subscriptions",
        spaces: [...spaces.values()],
        ...(this.meta(agent).styledFrames ? { format: "styled-text-v1" } : {}),
      });
  }
  private prune() {
    for (const s of this.sockets()) {
      const a = this.meta(s);
      if (a.role === "agent" && !this.authorized(a.credentialId))
        s.close(4001, "Authorization revoked");
      else if (a.expires <= Date.now()) {
        s.close(4002, "Renew authorization");
      } else if (Date.now() - a.seen >= 90000)
        s.close(4000, "Heartbeat timeout");
    }
  }
  async schedule() {
    const next = Math.min(
      ...this.sockets().map((s) => {
        const a = this.meta(s);
        return Math.min(a.expires, a.seen + 90000);
      }),
    );
    await scheduleEarlier(this.ctx, next);
  }
  sweep() {
    this.prune();
    this.subscriptions();
    this.status();
  }
  connect(
    role: "agent" | "viewer",
    expires: number,
    credentialId: string | null,
    spaceId?: string,
    styledFrames = false,
  ) {
    this.prune();
    if (role === "agent" && !this.authorized(credentialId))
      return new Response(null, { status: 401 });
    if (role === "agent" && this.agent())
      return new Response(null, { status: 409 });
    const viewers = this.viewers();
    if (
      role === "viewer" &&
      (viewers.length >= 12 ||
        (!viewers.some((s) => this.meta(s).spaceId === spaceId) &&
          new Set(viewers.map((s) => this.meta(s).spaceId)).size >= 4))
    )
      return new Response(null, { status: 429 });
    const pair = new WebSocketPair();
    const server = pair[1];
    const existing = this.viewers(spaceId)[0];
    const attachment: Attachment = {
      role,
      id: crypto.randomUUID(),
      expires,
      seen: Date.now(),
      credentialId,
      styledFrames,
      ...(role === "viewer"
        ? {
            spaceId,
            subscriptionId: existing
              ? this.meta(existing).subscriptionId
              : crypto.randomUUID(),
            seq: 0,
            panes: [],
          }
        : {}),
    };
    this.ctx.acceptWebSocket(server, ["live"]);
    server.serializeAttachment(attachment);
    this.ctx.waitUntil(this.schedule());
    this.subscriptions();
    this.status();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  message(socket: WebSocket, message: string | ArrayBuffer) {
    this.prune();
    if (socket.readyState !== WebSocket.OPEN) {
      this.subscriptions();
      this.status();
      return;
    }
    const a = this.meta(socket);
    if (typeof message !== "string" || message.length > 262144) {
      socket.close(1008, "Invalid message");
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(message);
    } catch {
      socket.close(1008, "Invalid JSON");
      return;
    }
    const parsed = (
      a.role === "agent" ? AgentMessageSchema : ViewerMessageSchema
    ).safeParse(value);
    if (!parsed.success) {
      socket.close(1008, "Invalid message");
      return;
    }
    a.seen = Date.now();
    socket.serializeAttachment(a);
    const data = parsed.data;
    if (data.type === "rendered" && a.role === "viewer") {
      if (
        data.deliveryId > (a.delivery ?? 0) ||
        data.deliveryBytes > (a.deliveryBytes ?? 0)
      ) {
        socket.close(1008, "Invalid acknowledgement");
        return;
      }
      a.rendered = Math.max(a.rendered ?? 0, data.deliveryId);
      a.renderedBytes = Math.max(a.renderedBytes ?? 0, data.deliveryBytes);
      socket.serializeAttachment(a);
      return;
    }
    if (data.type === "ping") {
      this.send(socket, { type: "pong" });
      this.subscriptions();
      this.status();
      return;
    }
    if (a.role === "agent") {
      if (data.type === "ack") {
        const viewer = this.viewers().find(
          (s) => this.meta(s).id === data.clientId,
        );
        if (viewer) {
          const v = this.meta(viewer);
          if (v.pending === data.seq) {
            delete v.pending;
            viewer.serializeAttachment(v);
            this.send(viewer, {
              type: "ack",
              seq: data.seq,
              status: data.status,
            });
          }
        }
      } else if ("spaceId" in data) {
        for (const viewer of this.viewers(data.spaceId)) {
          const v = this.meta(viewer);
          if (v.subscriptionId !== data.subscriptionId) continue;
          if (data.type === "unavailable") {
            viewer.close(4004, "Space unavailable");
            continue;
          }
          if (data.type === "topology") {
            v.panes = data.tabs.flatMap((t) =>
              t.panes.map((p) => paneKey(p.id, p.terminalId)),
            );
            viewer.serializeAttachment(v);
          }
          if (
            data.type !== "frame" ||
            v.panes?.includes(paneKey(data.paneId, data.terminalId))
          )
            this.send(viewer, data);
        }
      }
      return;
    }
    if (data.type === "control" || data.type === "release") {
      a.control =
        data.type === "control" &&
        !!this.agent() &&
        !this.viewers(a.spaceId).some(
          (s) => s !== socket && this.meta(s).control,
        );
      socket.serializeAttachment(a);
      this.status();
      return;
    }
    if (data.type === "input") {
      const agent = this.agent();
      if (
        !agent ||
        !a.control ||
        a.pending ||
        data.seq <= (a.seq ?? 0) ||
        !a.panes?.includes(paneKey(data.paneId, data.terminalId))
      ) {
        this.send(socket, { type: "ack", seq: data.seq, status: "rejected" });
        return;
      }
      a.seq = data.seq;
      a.pending = data.seq;
      socket.serializeAttachment(a); // Record the sequence before forwarding; never replay uncertain input.
      this.send(agent, {
        ...data,
        spaceId: a.spaceId,
        subscriptionId: a.subscriptionId,
        clientId: a.id,
      });
    }
  }
  close(socket: WebSocket) {
    if (this.meta(socket)?.role === "agent")
      for (const s of this.viewers()) s.close(1012, "Bridge disconnected");
    this.subscriptions();
    this.status();
  }
  revoke() {
    for (const s of this.sockets()) s.close(4001, "Credentials changed");
  }
}
