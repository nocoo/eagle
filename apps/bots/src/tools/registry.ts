import {
  createRegistry,
  defineExtension,
  type RegistryReader,
  section,
  wrapTool,
} from "@earendil-works/pi-durable";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { CodingTools, createBashTool } from "@earendil-works/pi-durable/tools";
import { resolveToolGroups, type ToolGroup } from "../core/domain.ts";
import type { Log } from "../log/log.ts";
import { AGENTS_TOOLS_EXTENSION, agentsExtension } from "./agents/tools.ts";
import { SocketDevicePort } from "./devices/port.ts";
import {
  DEVICE_EXTENSION,
  deviceExtension,
  guardNativeTool,
  observeDeviceTool,
} from "./devices/tools.ts";
import {
  createHerdrTools,
  HERDR_TOOLS_EXTENSION,
  type HerdrToolOptions,
  herdrSection,
} from "./herdr/tools.ts";
import { createListTool } from "./list.ts";
import { MACHINE_EXTENSION, type MachinePrompt, machineExtension } from "./machine/tools.ts";
import { createNoteSetTool } from "./note.ts";
import { PEERS_TOOLS_EXTENSION, peersExtension } from "./peers/tools.ts";
import { PERSONA_EXTENSION, personaExtension } from "./persona/tools.ts";
import { PULLS_TOOLS_EXTENSION, pullsExtension } from "./pulls/tools.ts";
import { SEARCH_TOOLS_EXTENSION, searchExtension } from "./search/tools.ts";
import {
  type createTriggerTools,
  TRIGGER_TOOLS_EXTENSION,
  triggerExtension,
} from "./trigger/tools.ts";
import type { BotWorkspace, NoteToolHost } from "./types.ts";

export const BOTS_TOOLS_EXTENSION = "bots-tools";
const toolSearch = createToolSearchExtension();
const GROUP_EXTENSIONS: Record<ToolGroup, readonly string[]> = {
  persona: [PERSONA_EXTENSION],
  machine: [MACHINE_EXTENSION],
  core: [BOTS_TOOLS_EXTENSION],
  coding: [CodingTools.name, PULLS_TOOLS_EXTENSION],
  herdr: [HERDR_TOOLS_EXTENSION, toolSearch.name],
  agents: [AGENTS_TOOLS_EXTENSION],
  search: [SEARCH_TOOLS_EXTENSION, toolSearch.name],
  trigger: [TRIGGER_TOOLS_EXTENSION, toolSearch.name],
  peers: [PEERS_TOOLS_EXTENSION, toolSearch.name],
};

export const selectToolExtensions = (registry: RegistryReader, groups: readonly string[]) => {
  const installed = new Set(
    registry
      .snapshot()
      .installed()
      .map((extension) => extension.name),
  );
  const names = new Set<string>();
  if (installed.has(DEVICE_EXTENSION)) names.add(DEVICE_EXTENSION);
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

const bash = createBashTool({
  prepare(execution) {
    execution.inheritEnv = false;
    execution.env = {};
    for (const name of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "SHELL"]) {
      const value = process.env[name];
      if (value !== undefined) execution.env[name] = value;
    }
    execution.env.TERM = "dumb";
    execution.env.PWD = execution.cwd;
  },
});

export type ToolRegistryOptions = {
  /** The person's standing instruction, read on every request so an edit lands immediately. */
  readonly persona?: () => string | undefined;
  /** The machine's own instructions file, read on every request for the same reason. */
  readonly machine?: () => MachinePrompt | undefined;
  readonly devices?: { readonly socketPath: string; readonly botId: string; readonly log?: Log };
  /** Herdr tools need the CLI client and this bot's state directory. */
  readonly herdr?: Omit<HerdrToolOptions, "workspace">;
  /** Web search needs a provider client; absent when no key is configured. */
  readonly search?: Omit<Parameters<typeof searchExtension>[0], "botId"> & {
    readonly botId: string;
  };
  /** Trigger tools act on this bot's own definitions; absent in a build without storage. */
  readonly trigger?: Parameters<typeof createTriggerTools>[0];
  /** Peer tools message other local bots; absent in a build without a daemon around them. */
  readonly peers?: Parameters<typeof peersExtension>[0];
  /** Pull-request reports belong to the coding group; absent without a store to keep them. */
  readonly pulls?: Parameters<typeof pullsExtension>[0];
  /** The bot's own sidebar note; absent only in a build with no catalog around it. */
  readonly note?: NoteToolHost;
};

export const createToolRegistry = (workspace: BotWorkspace, options: ToolRegistryOptions = {}) => {
  const herdr = options.herdr;
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
  // The two core prompts are installed first so their sections lead the system prompt:
  // who this bot is comes before what it can do (docs/bots/PRODUCT.md, "Core prompts").
  if (options.persona !== undefined) registry.install(personaExtension(options.persona));
  if (options.machine !== undefined) registry.install(machineExtension(options.machine));
  registry.install(
    defineExtension({
      name: BOTS_TOOLS_EXTENSION,
      tools: [list, note],
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
            "Keep the one line a person sees next to this bot in their sidebar with note_set: it is a status, so update it when the work changes, not every turn.",
            devices === undefined
              ? "Tool calls run without asking the user first."
              : "Local tools follow the shared device policy.",
          ].join("\n"),
        ),
      ],
    }),
  );
  registry.install(CodingTools);
  if (devices !== undefined) registry.install(deviceExtension(devices));
  registry.install(agentsExtension());
  if (options.search !== undefined) registry.install(searchExtension(options.search));
  if (options.trigger !== undefined) registry.install(triggerExtension(options.trigger));
  if (options.peers !== undefined) registry.install(peersExtension(options.peers));
  if (options.pulls !== undefined) registry.install(pullsExtension(options.pulls));
  if (options.peers !== undefined) registry.install(peersExtension(options.peers));
  if (options.pulls !== undefined) registry.install(pullsExtension(options.pulls));
  // Deferred tools need their loader; without one the model would never see them.
  if (
    herdr !== undefined ||
    options.search !== undefined ||
    options.trigger !== undefined ||
    options.peers !== undefined
  ) {
    registry.install(toolSearch);
  }
  if (herdr !== undefined) {
    registry.install(
      defineExtension({
        name: HERDR_TOOLS_EXTENSION,
        tools: createHerdrTools({ ...herdr, workspace }).filter(
          (tool) =>
            devices === undefined || ["herdr_list", "herdr_read", "herdr_wait"].includes(tool.name),
        ),
        sections: [
          section("bots-herdr", () =>
            devices === undefined
              ? herdrSection(herdr.botId)
              : "Herdr inspection is available. Herdr write/control tools are unavailable until they use shared device admission. Use device-governed coding tools for local commands.",
          ),
        ],
      }),
    );
  }
  return registry;
};
