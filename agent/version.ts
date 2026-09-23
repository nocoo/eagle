import pkg from "./package.json" with { type: "json" };

export const AGENT_VERSION = pkg.version;
