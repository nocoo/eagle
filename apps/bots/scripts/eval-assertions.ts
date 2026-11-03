export const assertOutputExcludes = (
  output: string,
  forbidden: string | undefined,
  command: string,
  stream: "stdout" | "stderr",
): void => {
  if (forbidden !== undefined && output.includes(forbidden)) {
    throw new Error(`${command} printed forbidden text on ${stream}`);
  }
};
