import { REFLECTION_PROMPT } from "../src/runtime/pi/reflection.ts";

type Request = {
  readonly prompt_cache_key?: unknown;
  readonly input?: readonly unknown[];
  readonly tools?: readonly unknown[];
};

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const createEvalRouter = () => {
  const sessions = new Map<string, "root" | "reflection">();
  return (request: Request): "root" | "reflection" => {
    const id = request.prompt_cache_key;
    if (typeof id !== "string" || id.length === 0)
      throw new Error("model request has no session identity");
    const existing = sessions.get(id);
    if (existing !== undefined) return existing;
    const last = request.input?.at(-1);
    const content =
      object(last) && last.role === "user" && Array.isArray(last.content) ? last.content : [];
    const onlyText =
      content.length === 1 &&
      object(content[0]) &&
      content[0].type === "input_text" &&
      content[0].text === REFLECTION_PROMPT;
    const tools = request.tools ?? [];
    const onlyNote = tools.length === 1 && object(tools[0]) && tools[0].name === "note_set";
    const kind = onlyText && onlyNote ? "reflection" : "root";
    sessions.set(id, kind);
    return kind;
  };
};
