// Memory v1 (docs/bots/EXTENSIONS-AND-TOOLS.md §6.1): two markdown files a person reads,
// edits and scripts, and the only module that knows that format. The tools see the port in
// tools/types.ts, so a later store replaces this file without changing a signature.
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  MAX_MEMORY_CONTENT,
  MAX_MEMORY_EXCERPT,
  MAX_MEMORY_KEY,
  MAX_MEMORY_LINES,
  type MemoryScope,
  type MemoryToolHost,
} from "../tools/types.ts";

const EXCERPT_LEAD = 60;

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
  /** Everything before the first heading, kept byte for byte: a title, a note for readers. */
  readonly preamble: string;
  readonly records: Map<string, string>;
};

/** A record starts at `## key`; a body line that would look like one is escaped on the way out. */
const SEPARATOR = /^##(?: |$)/u;
const ESCAPABLE = /^(\\*)##(?: |$)/u;

const isHeading = (line: string): boolean => SEPARATOR.test(line);
const escapeBodyLine = (line: string): string => (ESCAPABLE.test(line) ? `\\${line}` : line);
const unescapeBodyLine = (line: string): string =>
  line.startsWith("\\") && ESCAPABLE.test(line.slice(1)) ? line.slice(1) : line;

/** macOS and Windows editors both reach these files; the daemon stores and compares LF. */
const normalizeNewlines = (text: string): string => text.replace(/\r\n?/gu, "\n");

/** A record is one `## key` section and its body; a repeated key is last-one-wins. */
export const parseMemory = (text: string): ParsedMemory => {
  const records = new Map<string, string>();
  const source = normalizeNewlines(text);
  let preambleEnd = -1;
  let offset = 0;
  let key: string | undefined;
  let body: string[] = [];
  const flush = (): void => {
    if (key !== undefined && key.length > 0) {
      records.set(key, body.map(unescapeBodyLine).join("\n").replace(/\s+$/u, ""));
    }
    key = undefined;
    body = [];
  };
  for (const line of source.split("\n")) {
    if (isHeading(line)) {
      flush();
      if (preambleEnd === -1) preambleEnd = offset;
      key = line.slice(2).trim();
    } else if (key !== undefined) {
      body.push(line);
    }
    offset += line.length + 1;
  }
  flush();
  // The preamble is the whole slice before the first heading, boundary newline included.
  return { preamble: preambleEnd === -1 ? source : source.slice(0, preambleEnd), records };
};

export const renderMemory = (preamble: string, records: ReadonlyMap<string, string>): string => {
  const sections = [...records.keys()].sort().map((key) => {
    const body = (records.get(key) ?? "").split("\n").map(escapeBodyLine).join("\n");
    return `## ${key}\n${body}`;
  });
  const body = sections.join("\n\n");
  if (body.length === 0) return preamble;
  const head = preamble.length === 0 || preamble.endsWith("\n") ? preamble : `${preamble}\n`;
  return head.length === 0 ? `${body}\n` : `${head}${body}\n`;
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

let scratchFiles = 0;
const store = async (file: string, parsed: ParsedMemory): Promise<void> => {
  // The directory is created private; an existing one keeps the mode its owner chose.
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  scratchFiles += 1;
  const scratch = `${file}.tmp-${process.pid}-${scratchFiles}`;
  // Exclusive creation comes first: only a file this call created is ever removed, and a
  // cleanup failure never replaces the error that caused it.
  const handle = await open(scratch, "wx", 0o600);
  try {
    await handle.writeFile(renderMemory(parsed.preamble, parsed.records), "utf8");
    await handle.close();
    await rename(scratch, file);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(scratch, { force: true }).catch(() => undefined);
    throw error;
  }
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
  return key;
};

const checkContent = (content: string): string => {
  const body = normalizeNewlines(content).replace(/\s+$/u, "");
  if (body.trim().length === 0) {
    throw new MemoryStoreError("a blank body is deleted, not written: use memory_delete");
  }
  if (Buffer.byteLength(body, "utf8") > MAX_MEMORY_CONTENT) {
    throw new MemoryStoreError(`a memory record is at most ${MAX_MEMORY_CONTENT} bytes`);
  }
  if (body.split("\n").length > MAX_MEMORY_LINES) {
    throw new MemoryStoreError(
      `a memory record is at most ${MAX_MEMORY_LINES} lines, so a read can return all of it`,
    );
  }
  return body;
};

const words = (query: string): readonly string[] =>
  fold(query)
    .text.split(/\s+/u)
    .filter((word) => word.length > 0);

/**
 * Lowercased text plus, for every folded code unit, where its character starts in the
 * original. Case folding can change length (`İ` folds to two units), so matching and
 * positioning must share this one mapping.
 */
const fold = (text: string): { text: string; starts: number[] } => {
  const starts: number[] = [];
  let folded = "";
  let index = 0;
  for (const character of text) {
    const lower = character.toLowerCase();
    for (let unit = 0; unit < lower.length; unit += 1) starts.push(index);
    folded += lower;
    index += character.length;
  }
  return { text: folded, starts };
};

const occurrences = (text: string, token: string): number => {
  let count = 0;
  let index = text.indexOf(token);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(token, index + token.length);
  }
  return count;
};

/** The earliest original position of any token, read through the same folding. */
const firstMatch = (
  folded: { text: string; starts: readonly number[] },
  tokens: readonly string[],
): number => {
  let first = -1;
  for (const token of tokens) {
    const index = folded.text.indexOf(token);
    if (index === -1) continue;
    const original = folded.starts[index] ?? 0;
    if (first === -1 || original < first) first = original;
  }
  return first;
};

const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;

/** Whole characters only: a window never starts or ends inside an emoji or other pair. */
const windowAt = (body: string, start: number, budget: number): { text: string; end: number } => {
  let text = "";
  let index = start;
  while (index < body.length) {
    const width = (body.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
    if (text.length + width > budget) break;
    text += body.slice(index, index + width);
    index += width;
  }
  return { text, end: index };
};

/** A window of at most `MAX_MEMORY_EXCERPT` characters, ellipses included. */
const excerptOf = (
  body: string,
  folded: { text: string; starts: readonly number[] },
  tokens: readonly string[],
): string => {
  const found = firstMatch(folded, tokens);
  const raw = found === -1 ? 0 : Math.max(0, found - EXCERPT_LEAD);
  // A lead-in can land between the halves of a surrogate pair; start at the character.
  const start = raw > 0 && isLowSurrogate(body.charCodeAt(raw)) ? raw - 1 : raw;
  const left = start > 0;
  const budget = MAX_MEMORY_EXCERPT - (left ? 1 : 0);
  const wide = windowAt(body, start, budget);
  const right = wide.end < body.length;
  // Reserve the closing ellipsis by measuring again one character shorter.
  const { text, end } = right ? windowAt(body, start, budget - 1) : wide;
  const window = text.replace(/\s+/gu, " ").trim();
  return `${left ? "…" : ""}${window}${end < body.length ? "…" : ""}`;
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
      const foldedKey = fold(key).text;
      const foldedBody = fold(body);
      let score = 0;
      let matched = true;
      for (const token of tokens) {
        const inKey = occurrences(foldedKey, token);
        const inBody = occurrences(foldedBody.text, token);
        if (inKey + inBody === 0) {
          matched = false;
          break;
        }
        score += inKey * 3 + inBody;
      }
      if (!matched) continue;
      matches.push({ key, score, excerpt: excerptOf(body, foldedBody, tokens) });
    }
    matches.sort((left, right) => right.score - left.score || (left.key < right.key ? -1 : 1));
    const items = matches.slice(0, input.limit).map(({ key, excerpt }) => ({ key, excerpt }));
    return { items, truncated: matches.length > items.length };
  };

  const read: MemoryToolHost["read"] = async (input) => {
    const key = input.key.trim();
    const parsed = await load(fileFor(input.scope));
    const content = parsed.records.get(key);
    return content === undefined ? undefined : { key, content };
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
