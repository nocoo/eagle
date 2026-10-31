import { createInterface } from "node:readline";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { pageSchema, resourceCarrierSchema } from "../../../src/runtime/pi/syncProtocol.ts";
import { text, waitFor } from "../../support/pi.ts";
import { openReplica } from "../../support/replica.ts";

const lines = createInterface({ input: process.stdin });
const line = (await lines[Symbol.asyncIterator]().next()).value as string;
lines.close();
const input = JSON.parse(line) as {
  dir: string;
  mode: string;
  sharedBotId?: string;
  page?: unknown;
  bundle?: unknown;
  secondBundle?: unknown;
  installBeforeIntent?: boolean;
};
const replica = await openReplica(input.dir);
// Blocking only in this owned child makes the durable commit/reply boundary exact.
const barrier = (): never => {
  process.stdout.write("durable-replica-barrier\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error("unreachable owned child barrier");
};
if (input.mode === "intent") {
  const intent = replica.sync.store.intent.bind(replica.sync.store);
  replica.sync.store.intent = (value) => {
    intent(value);
    barrier();
  };
}
if (input.mode === "admission" || input.mode === "output") {
  replica.harness.subscribeCommits((publication) => {
    if (
      publication.changes.some((change) =>
        input.mode === "admission"
          ? change.type === "submission" &&
            change.value.requestId === "crash-local" &&
            change.value.status === "placed"
          : change.type === "entry" && change.value.kind === "pi.assistant",
      )
    )
      barrier();
  });
}
if (input.mode === "incoming") {
  const receive = replica.sync.store.receive.bind(replica.sync.store);
  replica.sync.store.receive = (page) => {
    receive(page);
    barrier();
  };
}
if (input.mode === "materialized") {
  const materialize = replica.history.materialize.bind(replica.history);
  replica.history.materialize = async (value, prefix) => {
    await materialize(value, prefix);
    return barrier();
  };
}
if (input.mode === "root-resource-intent" || input.mode === "root-resource-queued") {
  if (input.sharedBotId !== undefined)
    await replica.command("bind", { sharedBotId: input.sharedBotId });
  const first = (await replica.command("import", { bundle: input.bundle })) as { head: string };
  const second = (await replica.command("import", { bundle: input.secondBundle })) as {
    head: string;
  };
  if (input.installBeforeIntent)
    await replica.history.installResources(resourceCarrierSchema.parse(input.bundle));
  const submit = (requestId: string, head: string) =>
    replica.sync.root(
      {
        requestId,
        text: requestId,
        resourceHead: head,
        whenBusy: "followUp",
        trace: "tr_root_crash",
      },
      (entry) =>
        replica.root.submit(
          {
            type: "input",
            requestId,
            content: requestId,
            whenBusy: "followUp",
            ...(entry === undefined ? {} : { entry }),
          },
          ctx,
        ),
    );
  if (input.mode === "root-resource-intent") {
    const intent = replica.sync.store.intent.bind(replica.sync.store);
    replica.sync.store.intent = (value) => {
      intent(value);
      if (value.requestId === "root-resource-queued") barrier();
    };
  } else {
    let entered = false;
    const hold = Promise.withResolvers<void>();
    replica.faux.setResponses([
      async () => {
        entered = true;
        await hold.promise;
        return text("must remain blocked");
      },
    ]);
    await submit("root-resource-active", first.head);
    await waitFor(() => entered, "the real child provider barrier");
    replica.harness.subscribeCommits((publication) => {
      if (
        publication.changes.some(
          (change) =>
            change.type === "submission" &&
            change.value.requestId === "root-resource-queued" &&
            change.value.status === "queued",
        )
      )
        barrier();
    });
  }
  await submit("root-resource-queued", second.head);
} else if (input.mode === "resources" || input.mode === "resource-pin") {
  const saved = (await replica.command("import", { bundle: input.bundle })) as { head: string };
  if (input.mode === "resource-pin")
    replica.harness.subscribeCommits((publication) => {
      if (
        publication.changes.some(
          (change) =>
            change.type === "document" &&
            change.record.kind === "bots.replica.run" &&
            typeof change.value?.conversationId === "number" &&
            change.value.conversationId > 0,
        )
      )
        barrier();
    });
  else {
    const install = replica.history.installResources.bind(replica.history);
    replica.history.installResources = async (bundle) => {
      await install(bundle);
      return barrier();
    };
  }
  await replica.command("run", {
    head: saved.head,
    requestId: "crash-resource-run",
    text: "continue the selected package",
  });
} else if (input.page !== undefined) {
  await replica.command("bind", { sharedBotId: input.sharedBotId });
  await replica.command("apply", { page: pageSchema.parse(input.page) });
} else {
  replica.faux.setResponses([text("one committed original output")]);
  await (
    await replica.sync.root(
      {
        requestId: "crash-local",
        text: "one local input",
        whenBusy: "followUp",
        trace: "tr_sync_crash",
      },
      () =>
        replica.root.submit(
          { type: "input", requestId: "crash-local", content: "one local input" },
          ctx,
        ),
    )
  ).wait(ctx);
}
throw new Error("expected durable barrier was not reached");
