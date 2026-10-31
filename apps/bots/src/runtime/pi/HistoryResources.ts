import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  type ConversationId,
  type Cursor,
  defineDoc,
  defineExtension,
  type Harness,
  InboxDoc,
  type InputEntry,
  LiveDoc,
  type Registry,
  section,
} from "@earendil-works/pi-durable";
import { z } from "zod";
import { ClassifiedFailure } from "../../core/domain.ts";
import { FailureClassifier } from "./classify.ts";
import type { HistoryBundle } from "./HistoryReplica.ts";

export const RESOURCE_EXTENSION = "bots-resources";
export const RESOURCE_USER_KIND = "bots.user.resources";
const selectionSchema = z.strictObject({
  resourceHead: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  resourceVersion: z.union([z.literal(""), z.string().regex(/^[a-f0-9]{64}$/)]),
});
export type ResourceSelection = z.infer<typeof selectionSchema>;
export const inputResources = (entry?: InputEntry): ResourceSelection | undefined => {
  if (entry?.kind !== RESOURCE_USER_KIND) return undefined;
  const parsed = selectionSchema.safeParse(entry.data);
  return parsed.success ? parsed.data : reject("invalid input resource selection");
};
/** Live input IDs survive tool/compaction children; the placed entry is immutable. */
export const runResources = async (harness: Harness, id: ConversationId) => {
  const live = await harness.snapshot(LiveDoc, id, ctx);
  const first = live?.run?.inputs[0];
  if (first === undefined) return undefined;
  const submission = await harness.submission(first, ctx);
  const record = await submission?.status(ctx);
  if (record?.entry === undefined) return reject("missing resource run input");
  const entryId = record.entry;
  const entry = await harness.commit((tx) => tx.entry(entryId), ctx);
  if (entry === undefined) return reject("missing resource input entry");
  return { id: first, selection: inputResources(entry) };
};
export const ResourcePin = defineDoc({
  kind: "bots.replica.resources",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "current",
  initial: () => ({ version: "" }),
  checkpointWhen: () => true,
});
const manifestSchema = z.array(
  z.strictObject({
    name: z.string(),
    kind: z.enum(["instructions", "skill", "attachment"]),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
);
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const reject = (message: string): never => {
  throw new ClassifiedFailure(
    new FailureClassifier().classify("replica:resources", "invalid_command", "runtime")
      .classification.failure,
    "not_admitted",
    message,
  );
};
const absent = (cause: unknown) =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";
const exists = async (path: string) => {
  try {
    return await lstat(path);
  } catch (cause) {
    if (absent(cause)) return undefined;
    throw cause;
  }
};
const directory = async (path: string) => {
  if ((await exists(path)) === undefined) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (cause) {
      if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "EEXIST") throw cause;
    }
  }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) reject("unsafe resource directory");
};

/** Complete immutable packages, with only a version reference in each SDK branch. */
export class HistoryResources {
  readonly #root: string;
  readonly #loaded = new Map<string, string>();

  constructor(root: string, registry: Registry, harness?: Harness) {
    this.#root = root;
    registry.install(
      defineExtension({
        name: RESOURCE_EXTENSION,
        sections: [
          section(RESOURCE_EXTENSION, async ({ conversationId, read }, context) => {
            const pin = await read.snapshot(ResourcePin, conversationId, context);
            const selected =
              harness === undefined ? undefined : await runResources(harness, conversationId);
            const version = selected?.selection?.resourceVersion ?? pin?.version ?? "";
            if (version === "") return undefined;
            // Admission/start/retry validate first: renderer errors are not an execution gate.
            return this.#loaded.get(version) ?? reject("resource version was not prepared");
          }),
        ],
      }),
    );
  }

  #paths(resources: readonly { name: string; kind: string }[]): void {
    const names = new Set<string>();
    const skills = new Set<string>();
    for (const { name, kind } of resources) {
      if (
        !name ||
        name.includes("\\") ||
        name.includes("\0") ||
        posix.isAbsolute(name) ||
        name.split("/").some((part) => part === "" || part === "." || part === "..")
      )
        reject("unsafe resource path");
      if (names.has(name)) reject("conflicting resource path");
      names.add(name);
      if (kind === "skill") {
        const parts = name.split("/");
        if (parts[0] !== "skills" || parts.length < 3) reject("invalid skill package path");
        skills.add(parts.slice(0, 2).join("/"));
      }
    }
    for (const name of names) {
      let parent = posix.dirname(name);
      while (parent !== ".") {
        if (names.has(parent)) reject("resource file/directory conflict");
        parent = posix.dirname(parent);
      }
    }
    for (const skill of skills)
      if (!resources.some((file) => file.kind === "skill" && file.name === `${skill}/SKILL.md`))
        reject("incomplete skill package");
  }

  #check(resources: HistoryBundle["resources"]): string {
    this.#paths(resources);
    for (const resource of resources) {
      const bytes = Buffer.from(resource.base64, "base64");
      if (bytes.toString("base64") !== resource.base64 || digest(bytes) !== resource.sha256)
        reject("invalid installed resource bytes");
      if (
        resource.kind === "instructions" ||
        (resource.kind === "skill" && resource.name.endsWith("/SKILL.md"))
      ) {
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          return reject("selected resource text is not UTF-8");
        }
        if (!text.trim()) reject("empty selected resource text");
      }
    }
    return digest(JSON.stringify(resources));
  }

  async install(resources: HistoryBundle["resources"]): Promise<string> {
    if (resources.length === 0) return "";
    const version = this.#check(resources);
    await directory(this.#root);
    const final = join(this.#root, version);
    const record = join(this.#root, `${version}.json`);
    if (await exists(record)) {
      await this.#load(version);
      return version;
    }
    if (await exists(final)) {
      await this.#verifyFiles(final, resources);
    } else {
      const staging = join(this.#root, `.install-${randomUUID()}`);
      await mkdir(staging, { mode: 0o700 });
      try {
        for (const file of resources) {
          const target = join(staging, file.name);
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          await writeFile(target, Buffer.from(file.base64, "base64"), { flag: "wx", mode: 0o400 });
        }
        try {
          await rename(staging, final);
        } catch (cause) {
          if (
            !(cause instanceof Error) ||
            !("code" in cause) ||
            (cause.code !== "EEXIST" && cause.code !== "ENOTEMPTY")
          )
            throw cause;
          await this.#verifyFiles(final, resources);
        }
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    }
    const metadata = resources.map(({ base64: _bytes, ...file }) => file);
    const temporary = join(this.#root, `.manifest-${randomUUID()}`);
    try {
      await writeFile(temporary, JSON.stringify(metadata), { flag: "wx", mode: 0o400 });
      await rename(temporary, record);
    } finally {
      await rm(temporary, { force: true });
    }
    await this.#load(version);
    return version;
  }

  async #verifyFiles(
    root: string,
    expected: readonly { name: string; sha256: string }[],
  ): Promise<Buffer[]> {
    const names: string[] = [];
    const walk = async (path: string, prefix: string) => {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        reject("unsafe installed resource directory");
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const name = prefix + entry.name;
        if (entry.isSymbolicLink()) reject("unsafe installed resource symlink");
        if (entry.isDirectory()) await walk(join(path, entry.name), `${name}/`);
        else if (entry.isFile()) names.push(name);
        else reject("unsupported installed resource file");
      }
    };
    await walk(root, "");
    const expectedNames = new Set(expected.map((file) => file.name));
    if (names.length !== expected.length || names.some((name) => !expectedNames.has(name)))
      reject("incomplete installed resource version");
    const contents: Buffer[] = [];
    for (const file of expected) {
      const handle = await open(join(root, file.name), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const bytes = await handle.readFile();
        if (digest(bytes) !== file.sha256) reject("installed resource digest mismatch");
        contents.push(bytes);
      } finally {
        await handle.close();
      }
    }
    return contents;
  }

  async #load(version: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(version)) reject("invalid resource version pin");
    const rootStat = await lstat(this.#root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) reject("unsafe resource root");
    const record = await open(
      join(this.#root, `${version}.json`),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    let value: unknown;
    try {
      const encoded = await record.readFile("utf8");
      try {
        value = JSON.parse(encoded);
      } catch (cause) {
        if (cause instanceof SyntaxError) reject("invalid resource manifest");
        throw cause;
      }
    } finally {
      await record.close();
    }
    const parsed = manifestSchema.safeParse(value);
    const files = parsed.success ? parsed.data : reject("invalid installed resource manifest");
    this.#paths(files);
    const bytes = await this.#verifyFiles(join(this.#root, version), files);
    const resources = files.map((file, index) => ({
      ...file,
      base64: (bytes[index] ?? reject("incomplete resource read")).toString("base64"),
    }));
    if (this.#check(resources) !== version) reject("installed resource version mismatch");
    const localDirectory = join(this.#root, version);
    const lines = [`Resource version: ${version}`, `Resource directory: ${localDirectory}`];
    for (const file of resources) {
      if (file.kind === "instructions")
        lines.push(
          `Instructions: ${file.name}\n${Buffer.from(file.base64, "base64").toString("utf8")}`,
        );
      else if (file.kind === "skill" && /^skills\/[^/]+\/SKILL\.md$/.test(file.name))
        lines.push(
          `Skill directory: ${join(localDirectory, posix.dirname(file.name))}\n${Buffer.from(file.base64, "base64").toString("utf8")}`,
        );
      else if (file.kind === "attachment")
        lines.push(`Attachment: ${join(localDirectory, file.name)}`);
    }
    this.#loaded.set(version, lines.join("\n\n"));
  }

  async validatePins(harness: Harness): Promise<void> {
    let cursor: Cursor | undefined;
    const versions = new Set<string>();
    do {
      const page = await harness.commit((tx) => tx.scanConversations({}, 128, cursor), ctx);
      for (const conversation of page.items) {
        const pin = await harness.snapshot(ResourcePin, conversation.id, ctx);
        if (pin !== undefined && pin.version !== "") versions.add(pin.version);
        const active = await runResources(harness, conversation.id);
        if (active?.selection?.resourceVersion) versions.add(active.selection.resourceVersion);
        const inbox = await harness.snapshot(InboxDoc, conversation.id, ctx);
        for (const item of inbox?.items ?? []) {
          if (item.mode === "write") continue;
          const selection = inputResources(item.entry);
          if (selection?.resourceVersion) versions.add(selection.resourceVersion);
        }
      }
      cursor = page.next;
    } while (cursor !== undefined);
    for (const version of versions) await this.#load(version);
  }
}
