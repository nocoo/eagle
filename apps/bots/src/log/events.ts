// The declared event catalogue (docs/bots/OBSERVABILITY.md). Every emit site uses a
// constant, and an undeclared name is refused at runtime, so a typo cannot become a
// new event by accident.
export const LAYERS = ["transport", "protocol", "core", "runtime", "pi"] as const;
export type Layer = (typeof LAYERS)[number];

export const OUTCOMES = [
  "start",
  "ok",
  "fail",
  "drop",
  "degrade",
  "skip",
  "reject",
  "end",
  "classify",
] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** Declared names, one per emit site. `stage 4` asserts this equals the doc table. */
export const EVENTS = {
  "core.sync.start": true,
  "core.sync.ok": true,
  "core.sync.fail": true,
  "runtime.sync.start": true,
  "runtime.sync.ok": true,
  "runtime.sync.fail": true,
  "core.replica.start": true,
  "core.replica.ok": true,
  "core.replica.fail": true,
  "runtime.replica.start": true,
  "runtime.replica.ok": true,
  "runtime.replica.fail": true,
  "transport.conn.open.ok": true,
  "transport.conn.open.reject": true,
  "transport.conn.close.ok": true,
  "transport.conn.close.end": true,
  "transport.auth.fail": true,
  "transport.frame.recv.ok": true,
  "transport.frame.send.ok": true,
  "transport.frame.send.drop": true,
  "protocol.decode.fail": true,
  "protocol.encode.fail": true,
  "protocol.limit.fail": true,
  "protocol.version.fail": true,
  "protocol.command.start": true,
  "protocol.command.ok": true,
  "protocol.command.fail": true,
  "core.catalog.load.ok": true,
  "core.catalog.load.fail": true,
  "core.catalog.write.ok": true,
  "core.catalog.write.fail": true,
  "core.bot.resolve.fail": true,
  "core.bot.open.start": true,
  "core.bot.open.ok": true,
  "core.bot.open.fail": true,
  "core.bot.close.ok": true,
  "core.bot.close.fail": true,
  "core.bot.close.degrade": true,
  "core.subscribe.start": true,
  "core.subscribe.ok": true,
  "core.subscribe.fail": true,
  "core.submit.start": true,
  "core.submit.ok": true,
  "core.submit.fail": true,
  "core.history.start": true,
  "core.history.ok": true,
  "core.history.fail": true,
  "core.hub.publish.ok": true,
  "core.hub.coalesce.ok": true,
  "core.hub.snapshot.ok": true,
  "core.hub.degrade": true,
  "core.singleton.start": true,
  "core.singleton.ok": true,
  "core.singleton.fail": true,
  "core.origin.replay.degrade": true,
  "core.recovery.start": true,
  "core.recovery.bot.ok": true,
  "core.recovery.bot.fail": true,
  "core.recovery.ok": true,
  "core.delete.start": true,
  "core.delete.ok": true,
  "core.delete.fail": true,
  "core.reconcile.ok": true,
  "core.group.write.ok": true,
  "runtime.open.start": true,
  "runtime.device.start": true,
  "runtime.device.ok": true,
  "runtime.device.fail": true,
  "runtime.open.ok": true,
  "runtime.open.fail": true,
  "runtime.subscribe.start": true,
  "runtime.subscribe.ok": true,
  "runtime.subscribe.fail": true,
  "runtime.submit.start": true,
  "runtime.submit.ok": true,
  "runtime.submit.fail": true,
  "runtime.abort.start": true,
  "runtime.abort.ok": true,
  "runtime.abort.fail": true,
  "runtime.task.retry.ok": true,
  "runtime.task.retry.fail": true,
  "runtime.task.abort.ok": true,
  "runtime.recover.start": true,
  "runtime.recover.ok": true,
  "runtime.recover.fail": true,
  "runtime.tools.refresh.ok": true,
  "runtime.tools.refresh.fail": true,
  "runtime.close.start": true,
  "runtime.close.ok": true,
  "runtime.close.fail": true,
  "runtime.watch.end.ok": true,
  "runtime.failure.classify": true,
  "pi.report": true,
  "pi.session.closed": true,
} as const;

export type EventName = keyof typeof EVENTS;

// A branded name: only values produced here are assignable, so an emit site cannot
// pass a literal or an aliased string. The brand is compile-time only.
declare const declaredEvent: unique symbol;
export type DeclaredEvent = EventName & { readonly [declaredEvent]: true };
/** Brands a name from the catalogue. A typo is still a type error; a bare string at
 *  an emit call is not assignable. */
export const declareEvent = (name: EventName): DeclaredEvent => name as DeclaredEvent;
const declared = declareEvent;

export const Events = {
  protocolCommandStart: declared("protocol.command.start"),
  protocolCommandOk: declared("protocol.command.ok"),
  protocolCommandFail: declared("protocol.command.fail"),
  protocolDecodeFail: declared("protocol.decode.fail"),
  protocolLimitFail: declared("protocol.limit.fail"),
  protocolVersionFail: declared("protocol.version.fail"),
  protocolEncodeFail: declared("protocol.encode.fail"),
} as const;

export const isEventName = (value: string): value is EventName => Object.hasOwn(EVENTS, value);
