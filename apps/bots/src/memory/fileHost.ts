// Memory v1 (docs/bots/EXTENSIONS-AND-TOOLS.md §6.1): two markdown files a person reads,
// edits and scripts, and the only module that knows that format. The tools see the port in
// tools/types.ts, so a later store replaces this file without changing a signature.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  MAX_MEMORY_CONTENT,
  MAX_MEMORY_EXCERPT,
  MAX_MEMORY_KEY,
  type MemoryScope,
  type MemoryToolHost,
} from "../tools/types.ts";

const EXCERPT_LEAD = 60;
const HEADING = "## ";

export const globalMemoryFile = (dir: string): string => join(dir, "global.md");
export const botMemoryFile = (dir: string, botId: string): string => join(dir, `${botId}.md`);

const memoryFile = (dir: string, botId: string, scope: MemoryScope): string =>
  scope === "global" ? globalMemoryFile(dir) : botMemoryFile(dir, botId);

/** A refusal the tool layer turns into a model-visible message; never a thrown bug. */
export class MemoryStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryStoreError";
  }
}

export type ParsedMemory = {
  /** Everything before the first heading: a title, a note for readers, kept verbatim. */
  readonly preamble: string;
  readonly records: Map<string, string>;
};

const trimBody = (lines: readonly string[]): string => lines.join("\n").replace(/\s+$/u, "");

/** A record is one `## key` section and its body; a repeated key is last-one-wins. */
export const parseMemory = (text: string): ParsedMemory => {
  const records = new Map<string, string>();
  const preamble: string[] = [];
  let key: string | undefined;
  let body: string[] = [];
  const flush = (): void => {
    if (key !== undefined && key.length > 0) records.set(key, trimBody(body));
    key = undefined;
    body = [];
  };
  for (const line of text.split("\n")) {
    if (line.startsWith(HEADING)) {
      flush();
      key = line.slice(HEADING.length).trim();
      continue;
    }
    if (key === undefined) preamble.push(line);
    else body.push(line);
  }
  flush();
  return { preamble: preamble.join("\n").trim(), records };
};

export const renderMemory = (preamble: string, records: ReadonlyMap<string, string>): string => {
  const head = preamble.trim();
  const sections = [...records.keys()]
    .sort()
    .map((key) => `${HEADING}${key}\n${records.get(key) ?? ""}`);
  const body = sections.join("\n\n");
  if (head.length === 0) return body.length === 0 ? "" : `${body}\n`;
  return body.length === 0 ? `${head}\n` : `${head}\n\n${body}\n`;
};

const missing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

const load = async (file: string): Promise<ParsedMemory> => {
  try {
    return parseMemory(await readFile(file, "utf8"));
  } catch (error) {
    if (missing(error)) return { preamble: "", records: new Map() };
    throw error;
  }
};

let temporary = 0;
const store = async (file: string, parsed: ParsedMemory): Promise<void> => {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  temporary += 1;
  const scratch = `${file}.tmp-${process.pid}-${temporary}`;
  await writeFile(scratch, renderMemory(parsed.preamble, parsed.records), {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(scratch, file);
};

/** One mutation at a time per file, so two tools in one run cannot lose each other's keys. */
const queues = new Map<string, Promise<unknown>>();
const serial = async <T>(file: string, run: () => Promise<T>): Promise<T> => {
  const previous = queues.get(file) ?? Promise.resolve();
  const next = previous.then(run, run);
  queues.set(
    file,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
};

const checkKey = (raw: string): string => {
  const key = raw.trim();
  if (key.length === 0) throw new MemoryStoreError("a memory key cannot be empty");
  if (key.length > MAX_MEMORY_KEY) {
    throw new MemoryStoreError(`a memory key is at most ${MAX_MEMORY_KEY} characters`);
  }
  if (/[\r\n]/u.test(key)) throw new MemoryStoreError("a memory key cannot contain a newline");
  if (key.startsWith("#")) throw new MemoryStoreError("a memory key cannot start with #");
  return key;
};

const checkContent = (content: string): string => {
  const body = content.replace(/\s+$/u, "");
  if (body.trim().length === 0) {
    throw new MemoryStoreError(
      "a memory with empty content is deleted, not written: use memory_delete",
    );
  }
  if (Buffer.byteLength(body, "utf8") > MAX_MEMORY_CONTENT) {
    throw new MemoryStoreError(`a memory record is at most ${MAX_MEMORY_CONTENT} bytes`);
  }
  return body;
};

const words = (query: string): readonly string[] =>
  query
    .toLowerCase()
    .split(/\s+/u)
    .filter((word) => word.length > 0);

const occurrences = (text: string, token: string): number => {
  let count = 0;
  let index = text.indexOf(token);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(token, index + token.length);
  }
  return count;
};

const excerptOf = (body: string, tokens: readonly string[]): string => {
  const lower = body.toLowerCase();
  const found = tokens
    .map((token) => lower.indexOf(token))
    .filter((index) => index !== -1)
    .sort((left, right) => left - right)[0];
  const start = found === undefined ? 0 : Math.max(0, found - EXCERPT_LEAD);
  const window = body
    .slice(start, start + MAX_MEMORY_EXCERPT)
    .replace(/\s+/gu, " ")
    .trim();
  return `${start > 0 ? "…" : ""}${window}${start + MAX_MEMORY_EXCERPT < body.length ? "…" : ""}`;
};

/**
 * The file store: `global.md` beside one `<botId>.md` per bot. Every read re-reads the file,
 * because a person's script is a writer too, and every mutation is a read-modify-write under
 * a per-file queue.
 */
export const fileMemoryHost = (options: {
  readonly dir: string;
  readonly botId: string;
}): MemoryToolHost => {
  const fileFor = (scope: MemoryScope): string => memoryFile(options.dir, options.botId, scope);

  const list: MemoryToolHost["list"] = async (input) => {
    const parsed = await load(fileFor(input.scope));
    const keys = [...parsed.records.keys()].sort();
    const cursor = input.cursor;
    const after = cursor === undefined ? keys : keys.filter((key) => key > cursor);
    const page = after.slice(0, input.limit);
    const nextCursor = after.length > page.length ? page[page.length - 1] : undefined;
    return {
      items: page.map((key) => ({
        key,
        bytes: Buffer.byteLength(parsed.records.get(key) ?? "", "utf8"),
      })),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  };

  const search: MemoryToolHost["search"] = async (input) => {
    const tokens = words(input.query);
    if (tokens.length === 0) throw new MemoryStoreError("a memory search needs a word to look for");
    const parsed = await load(fileFor(input.scope));
    const matches: { key: string; score: number; excerpt: string }[] = [];
    for (const [key, body] of parsed.records) {
      const lowerKey = key.toLowerCase();
      const lowerBody = body.toLowerCase();
      let score = 0;
      let matched = true;
      for (const token of tokens) {
        const inKey = occurrences(lowerKey, token);
        const inBody = occurrences(lowerBody, token);
        if (inKey + inBody === 0) {
          matched = false;
          break;
        }
        score += inKey * 3 + inBody;
      }
      if (!matched) continue;
      matches.push({ key, score, excerpt: excerptOf(body, tokens) });
    }
    matches.sort((left, right) => right.score - left.score || (left.key < right.key ? -1 : 1));
    const items = matches.slice(0, input.limit).map(({ key, excerpt }) => ({ key, excerpt }));
    return { items, truncated: matches.length > items.length };
  };

  const read: MemoryToolHost["read"] = async (input) => {
    const parsed = await load(fileFor(input.scope));
    const content = parsed.records.get(input.key.trim());
    return content === undefined ? undefined : { key: input.key.trim(), content };
  };

  const write: MemoryToolHost["write"] = async (input) => {
    const key = checkKey(input.key);
    const body = checkContent(input.content);
    const file = fileFor(input.scope);
    return serial(file, async () => {
      const parsed = await load(file);
      const created = !parsed.records.has(key);
      parsed.records.set(key, body);
      await store(file, parsed);
      return { key, bytes: Buffer.byteLength(body, "utf8"), created };
    });
  };

  const remove: MemoryToolHost["remove"] = async (input) => {
    const key = input.key.trim();
    const file = fileFor(input.scope);
    return serial(file, async () => {
      const parsed = await load(file);
      if (!parsed.records.delete(key)) return { deleted: false };
      await store(file, parsed);
      return { deleted: true };
    });
  };

  return { botId: options.botId, list, search, read, write, remove };
};
