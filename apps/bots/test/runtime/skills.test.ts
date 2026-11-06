// The ticked skills in the real adapter: the prompt index is read again for every ask, and
// skill_read reads the one manifest the person selected (docs/bots/RUNTIME.md, "Skills").
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import type { RuntimeEvent, RuntimeHandle } from "../../src/core/RuntimePort.ts";
import { MAX_SKILL_FILE_BYTES, type SelectedSkill } from "../../src/skills/selection.ts";
import {
  assistant,
  type Bench,
  createBench,
  requestId,
  text,
  toolCall,
  trace,
  waitFor,
} from "../support/pi.ts";

/** Runs one turn and returns the text the transcript ended with. */
const settle = async (
  handle: RuntimeHandle,
  bench: Bench,
  responses: readonly FauxResponseStep[],
  id: string = requestId,
): Promise<string> => {
  bench.faux.setResponses([...responses]);
  const events: RuntimeEvent[] = [];
  await handle.subscribe(trace, (event) => events.push(event));
  await handle.submit({ requestId: id, text: "读一下这个技能", whenBusy: "followUp", trace });
  await waitFor(
    () => events.some((event) => event.type === "submission" && event.record.status === "done"),
    "the run to settle",
  );
  return events
    .filter((event) => event.type === "append")
    .flatMap((event) => event.message.blocks)
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n");
};

const skill = (path: string): SelectedSkill => ({
  name: "alpha",
  version: "1.2.0",
  description: "Runs the alpha acceptance.",
  path,
});

test("the prompt carries the selection on the next ask, without reopening the conversation", async () => {
  let selection: readonly SelectedSkill[] = [];
  const bench = await createBench({ skills: () => selection });
  try {
    const handle = await bench.runtime.open(bench.spec());
    try {
      let before = "";
      await settle(
        handle,
        bench,
        [
          (context: { messages: unknown }) => {
            before = JSON.stringify(context.messages);
            return assistant("你好");
          },
        ],
        "r_skills_before",
      );
      assert.equal(before.includes("alpha"), false, "nothing is selected yet");

      selection = [skill("/skills/alpha")];
      let after = "";
      await settle(
        handle,
        bench,
        [
          (context: { messages: unknown }) => {
            after = JSON.stringify(context.messages);
            return assistant("你好");
          },
        ],
        "r_skills_after",
      );
      assert.match(after, /alpha · 1\.2\.0 — Runs the alpha acceptance\./);
      assert.match(after, /skill_read/, "the model is told how to read the skill");
    } finally {
      await handle.close(trace, 5_000);
    }
  } finally {
    await bench.cleanup();
  }
});

test("skill_read answers with the manifest, and the model can follow it", async () => {
  const bench = await createBench({ skills: () => [skill(join(bench.dir, "skills"))] });
  try {
    const directory = join(bench.dir, "skills");
    await mkdir(directory, { recursive: true });
    const distinctive = "先说结论，再给依据。这是技能里的原话。";
    await writeFile(join(directory, "SKILL.md"), `# alpha\n\n${distinctive}\n`);
    const handle = await bench.runtime.open(bench.spec());
    try {
      let sawResult = false;
      const answer = await settle(handle, bench, [
        assistant([toolCall("skill_read", { name: "alpha" })], { stopReason: "toolUse" }),
        (context: { messages: unknown }) => {
          sawResult = JSON.stringify(context.messages).includes(distinctive);
          return text(sawResult ? "技能说：先说结论。" : "没读到技能");
        },
      ]);
      assert.equal(sawResult, true, "the manifest's own text reached the model");
      assert.match(answer, /先说结论/);
    } finally {
      await handle.close(trace, 5_000);
    }
  } finally {
    await bench.cleanup();
  }
});

test("a long manifest reaches the model whole: the tool's own limits are the harness's", async () => {
  const bench = await createBench({ skills: () => [skill(join(bench.dir, "skills"))] });
  try {
    const directory = join(bench.dir, "skills");
    await mkdir(directory, { recursive: true });
    // 20 000 Chinese characters are 60 000 bytes: more than the harness's own 50 KiB
    // default, which used to cut the manifest away without saying so.
    const ending = "这是技能的最后一句";
    await writeFile(join(directory, "SKILL.md"), `${"字".repeat(20_000)}\n${ending}\n`);
    const handle = await bench.runtime.open(bench.spec());
    try {
      let seen = "";
      await settle(handle, bench, [
        assistant([toolCall("skill_read", { name: "alpha" })], { stopReason: "toolUse" }),
        (context: { messages: unknown }) => {
          seen = JSON.stringify(context.messages);
          return text(seen.includes(ending) ? "读完了" : "没读完");
        },
      ]);
      assert.equal(seen.includes(ending), true, "the whole manifest reached the model");
      assert.equal((seen.match(/字/g) ?? []).length >= 20_000, true, "no character was cut away");
    } finally {
      await handle.close(trace, 5_000);
    }
  } finally {
    await bench.cleanup();
  }
});

test("a manifest over the budget reaches the model with its truncation note", async () => {
  const bench = await createBench({ skills: () => [skill(join(bench.dir, "skills"))] });
  try {
    const directory = join(bench.dir, "skills");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), "字".repeat(40_000));
    const handle = await bench.runtime.open(bench.spec());
    try {
      let seen = "";
      await settle(handle, bench, [
        assistant([toolCall("skill_read", { name: "alpha" })], { stopReason: "toolUse" }),
        (context: { messages: unknown }) => {
          seen = JSON.stringify(context.messages);
          return text("读完了");
        },
      ]);
      assert.match(seen, /\[truncated at \d+ bytes\]/, "the note says where the text stops");
      assert.equal(
        seen.includes("字".repeat(MAX_SKILL_FILE_BYTES)),
        false,
        "the manifest is cut, not the note",
      );
    } finally {
      await handle.close(trace, 5_000);
    }
  } finally {
    await bench.cleanup();
  }
});
