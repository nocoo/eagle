import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { type BotWorkspace, ToolError } from "./types.ts";

export const openWorkspace = async (root: string): Promise<BotWorkspace> => {
  await mkdir(root, { recursive: true, mode: 0o700 });
  return { root: await realpath(root) };
};

const isInside = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(`${root}${sep}`);

/** Rejects a symlink at or below the workspace root, including a dangling one. */
const assertNoLinks = async (root: string, path: string): Promise<void> => {
  const rest = relative(root, path);
  if (rest.length === 0) return;
  let current = root;
  for (const part of rest.split(sep)) {
    current = join(current, part);
    const info = await lstat(current).catch(() => undefined);
    if (info === undefined) return; // the rest does not exist yet
    if (info.isSymbolicLink()) {
      throw new ToolError(`the path leaves the workspace through a link: ${path}`);
    }
  }
};

/**
 * Resolves a path inside the bot's own directory, not a native coding-tool path.
 */
export const resolveInside = async (root: string, path: string): Promise<string> => {
  if (path.length === 0) throw new ToolError("a path is required");
  if (path.length > 4_096) throw new ToolError("the path is too long");
  if (path.includes("\0")) throw new ToolError("the path contains a null byte");
  const candidate = isAbsolute(path) ? resolve(path) : resolve(root, path);
  if (!isInside(root, candidate)) {
    throw new ToolError(`the path is outside the workspace: ${path}`);
  }
  await assertNoLinks(root, candidate);
  return candidate;
};
