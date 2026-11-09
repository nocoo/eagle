import {
  createRegistry,
  defineExtension,
  type RegistryReader,
  section,
  wrapTool,
} from "@earendil-works/pi-durable";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { CodingTools, createBashTool } from "@earendil-works/pi-durable/tools";
import {
  DEFAULT_HC,
  noteLine,
  resolveToolGroups,
  type ToolGroup,
  type ToolGroupCatalog,
} from "../core/domain.ts";
import type { Log } from "../log/log.ts";

import { AGENTS_TOOLS_EXTENSION, agentsExtension } from "./agents/tools.ts";
import { createAskTool } from "./ask.ts";
import type { DecisionClient } from "./decision/client.ts";
import {
  type createDecisionTools,
  DECISION_TOOLS_EXTENSION,
  decisionExtension,
} from "./decision/tools.ts";
import { SocketDevicePort } from "./devices/port.ts";
import {
  DEVICE_EXTENSION,
  deviceExtension,
  guardNativeTool,
  observeDeviceTool,
} from "./devices/tools.ts";
import { createHcClient } from "./hc/client.ts";
import {
  createHcTools,
  HC_TERMINAL_WRITE_TOOLS,
  HC_TOOLS_EXTENSION,
  type HcToolOptions,
  hcSection,
} from "./hc/tools.ts";
import { createListTool } from "./list.ts";
import { MACHINE_EXTENSION, type MachinePrompt, machineExtension } from "./machine/tools.ts";
import { MEMORY_TOOLS_EXTENSION, memoryExtension } from "./memory/tools.ts";
import { createNoteSetTool } from "./note.ts";
import { PEERS_TOOLS_EXTENSION, peersExtension } from "./peers/tools.ts";
import { PERSONA_EXTENSION, personaExtension } from "./persona/tools.ts";
import { PULLS_TOOLS_EXTENSION, pullsExtension } from "./pulls/tools.ts";
import type { SearchClient } from "./search/client.ts";
import { SEARCH_TOOLS_EXTENSION, searchExtension } from "./search/tools.ts";
import { SECRETS_TOOLS_EXTENSION, secretsExtension } from "./secrets/tools.ts";
import { SKILLS_EXTENSION, type SkillToolsOptions, skillsExtension } from "./skills/tools.ts";
import {
  type createTriggerTools,
  TRIGGER_TOOLS_EXTENSION,
  triggerExtension,
} from "./trigger/tools.ts";
import type {
  BotWorkspace,
  MemoryToolHost,
  NoteToolHost,
  PeerToolHost,
  PullToolHost,
  SecretsToolHost,
  TriggerToolHost,
} from "./types.ts";

export const BOTS_TOOLS_EXTENSION = "bots-tools";
/**
 * The tools that act on the person's side of the App: the question card and the bot's sidebar
 * line. They are their own mandatory group so a child agent can drop them wholesale
 * (docs/bots/RUNTIME.md, "Subagents"), and they are installed after `core` so their section
 * follows the one that explains the workspace.
 */
export const CORE_UI_EXTENSION = "bots-core-ui";
/**
 * Selected by being installed, not by a tool group: the App's ticks are the switch, and a
 * group switch would be a second, contradictory one (docs/bots/EXTENSIONS-AND-TOOLS.md).
 */
const GROUP_FREE_EXTENSIONS: readonly string[] = [SKILLS_EXTENSION];
const toolSearch = createToolSearchExtension();
const GROUP_EXTENSIONS: Record<ToolGroup, readonly string[]> = {
  persona: [PERSONA_EXTENSION],
  machine: [MACHINE_EXTENSION],
  core: [BOTS_TOOLS_EXTENSION],
  "core-ui": [CORE_UI_EXTENSION],
  coding: [CodingTools.name, PULLS_TOOLS_EXTENSION],
  memory: [MEMORY_TOOLS_EXTENSION],
  secrets: [SECRETS_TOOLS_EXTENSION],
  hc: [HC_TOOLS_EXTENSION, toolSearch.name],
  agents: [AGENTS_TOOLS_EXTENSION],
  search: [SEARCH_TOOLS_EXTENSION, toolSearch.name],
  decision: [DECISION_TOOLS_EXTENSION, toolSearch.name],
  trigger: [TRIGGER_TOOLS_EXTENSION, toolSearch.name],
  peers: [PEERS_TOOLS_EXTENSION, toolSearch.name],
};

/**
 * A child agent selects the two prompt-only groups plus `core` and `coding`, and never
 * `core-ui` (docs/bots/RUNTIME.md, "Subagents"): it reads the bot's persona and this
 * machine's own rules, works in the same workspace, and has no tool that acts on the
 * person's screen, no delegation, no optional group and no shared-device tool.
 */
const CHILD_GROUPS: readonly ToolGroup[] = ["persona", "machine", "core", "coding"];
const CHILD_EXTENSIONS: readonly string[] = CHILD_GROUPS.flatMap(
  (group) => GROUP_EXTENSIONS[group],
);

export type RemoteCapability = "configured" | "unconfigured" | "unavailable";

export const selectToolExtensions = (
  registry: RegistryReader,
  groups: readonly string[],
  remoteConfigured = false,
) => {
  const installed = new Set(
    registry
      .snapshot()
      .installed()
      .map((extension) => extension.name),
  );
  const names = new Set<string>();
  if (remoteConfigured && installed.has(DEVICE_EXTENSION)) names.add(DEVICE_EXTENSION);
  for (const name of GROUP_FREE_EXTENSIONS) if (installed.has(name)) names.add(name);
  for (const group of resolveToolGroups(groups)) {
    const [owner, ...rest] = GROUP_EXTENSIONS[group];
    // A group whose own tools are not installed contributes nothing, not even its loader:
    // selecting an unavailable group must not offer a tool_search that can load nothing.
    if (owner === undefined || !installed.has(owner)) continue;
    names.add(owner);
    for (const name of rest) if (installed.has(name)) names.add(name);
  }
  return registry
    .snapshot()
    .installed()
    .filter((extension) => names.has(extension.name));
};

// Describing the tool surface never runs a tool. These hosts exist so the extensions can be
// built without a bot, a store or a provider key, and every call refuses rather than pretending.
const refuse = (): never => {
  throw new Error("the tool catalogue never executes a tool");
};

const catalogNote: NoteToolHost = {
  botId: "catalog",
  set: refuse,
  current: refuse,
};

const catalogTrigger: TriggerToolHost = {
  botId: "catalog",
  create: refuse,
  list: refuse,
  update: refuse,
  enable: refuse,
  remove: refuse,
  endpoint: refuse,
};

const catalogPeers: PeerToolHost = {
  botId: "catalog",
  maxMessage: 0,
  list: refuse,
  send: refuse,
  read: refuse,
  receipts: refuse,
};

const catalogPulls: PullToolHost = {
  botId: "catalog",
  register: refuse,
  list: refuse,
};

const catalogSearch: SearchClient = {
  search: refuse,
  fetchPage: refuse,
};

const catalogDecision: DecisionClient = { ask: refuse };

const catalogMemory: MemoryToolHost = {
  botId: "catalog",
  list: refuse,
  search: refuse,
  read: refuse,
  write: refuse,
  remove: refuse,
};

const catalogSecrets: SecretsToolHost = {
  botId: "catalog",
  list: refuse,
  read: refuse,
  remove: refuse,
  environment: refuse,
  envNameFor: refuse,
};

/**
 * What each group would give a bot right now, in the daemon's own words. The loader that
 * defers a group's tools (`tool_search`) belongs to no group: it is how a person's choice is
 * delivered, not one of the tools that choice is about.
 */
export const describeToolCatalog = (registry: RegistryReader): readonly ToolGroupCatalog[] => {
  const described = new Map(
    registry
      .snapshot()
      .installed()
      .map((extension) => [
        extension.name,
        (extension.tools ?? []).map((tool) => ({
          name: tool.name,
          description: tool.description,
        })),
      ]),
  );
  return (Object.keys(GROUP_EXTENSIONS) as ToolGroup[]).map((group) => ({
    group,
    tools: GROUP_EXTENSIONS[group]
      .filter((name) => name !== toolSearch.name)
      .flatMap((name) => described.get(name) ?? []),
  }));
};

/**
 * The registry the catalogue describes: every group built, none of it bound to a bot. The
 * skills reader is optional because a skill tick is not a group: the documentation counts
 * the surface with it, and `describeToolCatalog` never lists it.
 */
export const createCatalogRegistry = (
  options: { readonly skills?: SkillToolsOptions["read"] } = {},
): RegistryReader =>
  createToolRegistry(
    { root: "/" },
    {
      persona: () => "",
      machine: () => undefined,
      devices: { socketPath: "/nonexistent-catalogue.sock", botId: "catalog" },
      hc: {
        client: createHcClient(),
        botId: "catalog",
        roles: () => ({ provider: "magpie", roles: DEFAULT_HC }),
      },
      search: { client: catalogSearch, botId: "catalog" },
      decision: { client: catalogDecision, botId: "catalog" },
      trigger: catalogTrigger,
      peers: catalogPeers,
      memory: catalogMemory,
      pulls: catalogPulls,
      note: catalogNote,
      secrets: catalogSecrets,
      ...(options.skills === undefined ? {} : { skills: options.skills }),
    },
  );

/** The environment every bot command starts from: an allowlist, and nothing else. */
const baseEnvironment = (execution: {
  inheritEnv: boolean;
  env: Record<string, string>;
  cwd: string;
}): void => {
  execution.inheritEnv = false;
  execution.env = {};
  for (const name of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "SHELL"]) {
    const value = process.env[name];
    if (value !== undefined) execution.env[name] = value;
  }
  execution.env.TERM = "dumb";
  execution.env.PWD = execution.cwd;
};

export type ToolRegistryOptions = {
  /** The person's standing instruction, read on every request so an edit lands immediately. */
  readonly persona?: () => string | undefined;
  /** The machine's own instructions file, read on every request for the same reason. */
  readonly machine?: () => MachinePrompt | undefined;
  readonly devices?: {
    readonly socketPath: string;
    readonly botId: string;
    readonly log?: Log;
    readonly remoteCapability?: () => RemoteCapability;
    readonly setRemoteCapability?: (value: RemoteCapability) => void;
  };
  /** Herdr tools need the hc client and this bot's own role models. */
  readonly hc?: Omit<HcToolOptions, "workspace">;
  /** Web search needs a provider client; absent when no key is configured. */
  readonly search?: Omit<Parameters<typeof searchExtension>[0], "botId"> & {
    readonly botId: string;
  };
  /** Typed judgments need a decision client; absent only where no provider store exists. */
  readonly decision?: Omit<Parameters<typeof createDecisionTools>[0], "botId"> & {
    readonly botId: string;
  };
  /** Trigger tools act on this bot's own definitions; absent in a build without storage. */
  readonly trigger?: Parameters<typeof createTriggerTools>[0];
  /** Peer tools message other local bots; absent in a build without a daemon around them. */
  readonly peers?: Parameters<typeof peersExtension>[0];
  /** Memory tools act on this bot's two scopes; absent in a build without a memory directory. */
  readonly memory?: MemoryToolHost;
  /** Secret tools read this bot's own records and the shared ones; absent without a store. */
  readonly secrets?: SecretsToolHost;
  /** Pull-request reports belong to the coding group; absent without a store to keep them. */
  readonly pulls?: Parameters<typeof pullsExtension>[0];
  /** The bot's own sidebar note; absent only in a build with no catalog around it. */
  readonly note?: NoteToolHost;
  /** The skills the person ticked; read per ask, so a tick lands on the next turn. */
  readonly skills?: SkillToolsOptions["read"];
  /** The clock the note's age is read against; the daemon's own when absent. */
  readonly now?: () => number;
};

export const createToolRegistry = (workspace: BotWorkspace, options: ToolRegistryOptions = {}) => {
  const hc = options.hc;
  const registry = createRegistry();
  const devices =
    options.devices === undefined
      ? undefined
      : {
          botId: options.devices.botId,
          port: new SocketDevicePort(options.devices.socketPath),
          ...(options.devices.log === undefined ? {} : { log: options.devices.log }),
        };
  const list = createListTool();
  const note = createNoteSetTool(options.note);
  const ask = createAskTool();
  /**
   * The secrets this bot may use reach a command as environment variables and nothing else:
   * a tool result is persisted into the transcript, so a value must never be one.
   */
  const bash = createBashTool({
    // The environment a command receives is per conversation: a child agent is configured
    // without this group, so it must not inherit the parent's secrets through bash.
    async prepare(execution, api, context) {
      baseEnvironment(execution);
      const agent = await api.agent(context);
      const allowsSecrets =
        agent.extensions?.some((extension) => extension.name === SECRETS_TOOLS_EXTENSION) === true;
      if (!allowsSecrets) return;
      const secrets = (await options.secrets?.environment()) ?? {};
      for (const [name, value] of Object.entries(secrets)) execution.env[name] = value;
    },
  });
  // The two core prompts are installed first so their sections lead the system prompt:
  // who this bot is comes before what it can do (docs/bots/PRODUCT.md, "Core prompts").
  if (options.persona !== undefined) registry.install(personaExtension(options.persona));
  if (options.machine !== undefined) registry.install(machineExtension(options.machine));
  if (options.skills !== undefined) registry.install(skillsExtension({ read: options.skills }));
  registry.install(
    defineExtension({
      name: BOTS_TOOLS_EXTENSION,
      tools: [list],
      wraps: [
        wrapTool(bash, () =>
          devices === undefined ? bash : observeDeviceTool(guardNativeTool(bash, devices), devices),
        ),
        ...(devices === undefined
          ? []
          : [list, ...(CodingTools.tools ?? []).filter((tool) => tool.name !== "bash")].map(
              (tool) =>
                wrapTool(tool, (original) =>
                  observeDeviceTool(guardNativeTool(original, devices), devices),
                ),
            )),
      ],
      sections: [
        section("bots-tools", ({ agent }) =>
          [
            `Your default working directory is ${agent.cwd ?? workspace.root}.`,
            "Use list to discover files, read to inspect them, edit for targeted changes, write for whole files, and bash for commands.",
            ...(devices === undefined || options.devices?.remoteCapability?.() !== "unavailable"
              ? []
              : ["The local device protection service is awaiting recovery."]),
          ].join("\n"),
        ),
      ],
    }),
  );
  registry.install(
    defineExtension({
      name: CORE_UI_EXTENSION,
      tools: [note, ask],
      sections: [
        section("bots-core-ui", ({ agent }) => {
          // A conversation that filtered the tool away must not be told to use it.
          if (!agent.tools.some((tool) => tool.name === "note_set")) return undefined;
          return [
            "Keep the one line a person sees next to this bot in their sidebar with note_set: it is a status, so rewrite it when the nature of the work changes, not every turn; a plain follow-up leaves it alone. Aim for about ten Chinese characters, or an equally short line in another language: it has to be readable next to the bot's name, not cut off.",
            ...(options.note === undefined
              ? []
              : [noteLine(options.note.current(), (options.now ?? Date.now)())]),
          ].join("\n");
        }),
      ],
    }),
  );
  registry.install(CodingTools);
  const remote = devices === undefined ? undefined : deviceExtension(devices);
  if (remote !== undefined) registry.install(remote);
  registry.install(agentsExtension(CHILD_EXTENSIONS));
  if (options.search !== undefined) registry.install(searchExtension(options.search));
  if (options.decision !== undefined) registry.install(decisionExtension(options.decision));
  if (options.trigger !== undefined) registry.install(triggerExtension(options.trigger));
  if (options.peers !== undefined) registry.install(peersExtension(options.peers));
  if (options.pulls !== undefined) registry.install(pullsExtension(options.pulls));
  if (options.memory !== undefined) registry.install(memoryExtension(options.memory));
  if (options.secrets !== undefined) registry.install(secretsExtension(options.secrets));
  // Deferred tools need their loader; without one the model would never see them.
  if (
    hc !== undefined ||
    options.search !== undefined ||
    options.decision !== undefined ||
    options.trigger !== undefined ||
    options.peers !== undefined
  ) {
    registry.install(toolSearch);
  }
  if (hc !== undefined) {
    // `hc` is the Bot's hand on a terminal, which is what `bash` is for a shell: a write or a
    // close is one device operation that follows this Mac's policy, while listing, waiting and
    // reading stay observation that only logs its crossing.
    const terminalTools = createHcTools({ ...hc, workspace }).map((tool) => {
      if (devices === undefined) return tool;
      const guarded = HC_TERMINAL_WRITE_TOOLS.has(tool.name)
        ? guardNativeTool(tool, devices)
        : tool;
      return observeDeviceTool(guarded, devices);
    });
    registry.install(
      defineExtension({
        name: HC_TOOLS_EXTENSION,
        tools: terminalTools,
        sections: [section("bots-hc", () => hcSection(hc.botId))],
      }),
    );
  }
  return registry;
};
