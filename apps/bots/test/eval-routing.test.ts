import assert from "node:assert/strict";
import test from "node:test";
import { createEvalRouter } from "../scripts/eval-routing.ts";
import { REFLECTION_PROMPT } from "../src/runtime/pi/reflection.ts";

const input = (text: string) => ({ role: "user", content: [{ type: "input_text", text }] });
const tools = (names: readonly string[]) => names.map((name) => ({ type: "function", name }));

test("eval routing keeps quoted reminders in the root budget and follows child identity", () => {
  const route = createEvalRouter();
  assert.equal(
    route({
      prompt_cache_key: "root",
      input: [input("hello")],
      tools: tools(["note_set", "read"]),
    }),
    "root",
  );
  assert.equal(
    route({
      prompt_cache_key: "root",
      input: [input(REFLECTION_PROMPT)],
      tools: tools(["note_set"]),
    }),
    "root",
  );
  assert.equal(
    route({
      prompt_cache_key: "root",
      input: [input(`quoted: ${REFLECTION_PROMPT}`)],
      tools: tools(["note_set", "read"]),
    }),
    "root",
  );
  assert.equal(
    route({
      prompt_cache_key: "child",
      input: [input(REFLECTION_PROMPT)],
      tools: tools(["note_set"]),
    }),
    "reflection",
  );
  assert.equal(
    route({
      prompt_cache_key: "child",
      input: [{ type: "function_call_output", call_id: "call_1", output: "ok" }],
      tools: tools(["note_set"]),
    }),
    "reflection",
  );
  assert.throws(() => route({ input: [input("hello")], tools: [] }), /session identity/);
});
