// The secrets group (docs/bots/EXTENSIONS-AND-TOOLS.md §6.5): four tools, one card, and no
// path on which the model holds a value. The storage lives behind SecretsToolHost; nothing
// here knows the container's shape.
import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  section,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
  DEFAULT_SECRET_LIST_LIMIT,
  failed,
  MAX_SECRET_LIST_LIMIT,
  MAX_SECRET_PURPOSE_CHARS,
  MAX_SECRET_TTL_MINUTES,
  MIN_SECRET_TTL_MINUTES,
  SECRET_KEY_PATTERN,
  type SecretScope,
  type SecretsToolHost,
  type ToolOutcome,
} from "../types.ts";

export const SECRETS_TOOLS_EXTENSION = "bots-secrets";

const result = (outcome: ToolOutcome) => ({
  output: [{ type: "text" as const, text: outcome.output }],
  ...(outcome.isError === true ? { isError: true } : {}),
});

const text = (value: unknown): ToolOutcome => ({ output: JSON.stringify(value) });

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : "the secrets store refused the call";

const keyOf = (raw: string): string => {
  const key = raw.trim();
  if (!SECRET_KEY_PATTERN.test(key)) {
    throw new Error(
      "a secret key starts with a lowercase letter or digit and holds lowercase letters, digits, dot, dash or underscore, at most 64 characters",
    );
  }
  return key;
};

const purposeOf = (raw: string): string => {
  const purpose = raw.trim();
  if (purpose.length === 0)
    throw new Error("a secret request needs a purpose: what the value is for");
  if (purpose.length > MAX_SECRET_PURPOSE_CHARS) {
    throw new Error(`a secret purpose is at most ${MAX_SECRET_PURPOSE_CHARS} characters`);
  }
  return purpose;
};

/** A scope the call must name: a delete whose target was guessed is not replay-safe. */
const scopeOfRequired = (raw: string): SecretScope => {
  const scope = scopeOf(raw);
  if (scope === undefined) throw new Error("scope is required: bot or shared");
  return scope;
};

/** The scope the model named; absent means this Bot's own record first, then the shared one. */
const scopeOf = (raw: string | undefined): SecretScope | undefined => {
  if (raw === undefined) return undefined;
  const scope = raw.trim().toLowerCase();
  if (scope !== "bot" && scope !== "shared") {
    throw new Error(`scope must be "bot" or "shared"; it was "${raw}"`);
  }
  return scope;
};

const ttlOf = (raw: number | undefined): number | undefined => {
  if (raw === undefined) return undefined;
  if (!Number.isInteger(raw) || raw < MIN_SECRET_TTL_MINUTES || raw > MAX_SECRET_TTL_MINUTES) {
    throw new Error(
      `ttlMinutes is ${MIN_SECRET_TTL_MINUTES}-${MAX_SECRET_TTL_MINUTES}; leave it out when the value should not expire`,
    );
  }
  return raw;
};

const limitOf = (raw: number | undefined): number => {
  if (raw === undefined) return DEFAULT_SECRET_LIST_LIMIT;
  if (!Number.isInteger(raw) || raw < 1 || raw > MAX_SECRET_LIST_LIMIT) {
    throw new Error(`limit is 1-${MAX_SECRET_LIST_LIMIT}, default ${DEFAULT_SECRET_LIST_LIMIT}`);
  }
  return raw;
};

const scopeParameter = Type.Optional(
  Type.Union([Type.Literal("bot"), Type.Literal("shared")], {
    description:
      "bot: this bot's own record, then the shared one. shared: only the shared record. Omit it and your own record shadows a shared one with the same name",
  }),
);

const limitParameter = Type.Optional(
  Type.Integer({
    description: `How many records to return, 1-${MAX_SECRET_LIST_LIMIT}. Default ${DEFAULT_SECRET_LIST_LIMIT}`,
  }),
);

export const createSecretsTools = (host: SecretsToolHost): readonly ToolRegistration[] => [
  defineTool({
    name: "secret_request",
    description:
      "Ask the person for one secret — a password, a token, a key — on a card with a single password field. This is the only recommended way to ask a person for a secret: never ask them to paste it into the chat, where it would stay in the transcript and in every later prompt. The call returns at once; the value arrives as the next message, and you read it with secret_read when you need it.",
    parameters: Type.Object({
      key: Type.String({
        description:
          "The record's name: lowercase letters, digits, dot, dash or underscore, at most 64 characters. The person cannot rename it, so choose the name you will read it by",
      }),
      purpose: Type.String({
        description: `One line saying what the value is for; the person reads it on the card. At most ${MAX_SECRET_PURPOSE_CHARS} characters`,
      }),
      scope: Type.Optional(
        Type.Union([Type.Literal("bot"), Type.Literal("shared")], {
          description:
            "bot (default): only this bot may read it. shared: every bot on this machine may read it",
        }),
      ),
      ttlMinutes: Type.Optional(
        Type.Integer({
          description: `How long the value stays usable, ${MIN_SECRET_TTL_MINUTES}-${MAX_SECRET_TTL_MINUTES} minutes. Leave it out when the value should not expire`,
        }),
      ),
    }),
    replay: "safe",
    async execute(args) {
      try {
        const key = keyOf(args.key);
        purposeOf(args.purpose);
        scopeOf(args.scope);
        ttlOf(args.ttlMinutes);
        return result({
          output: `The card for "${key}" is on the person's screen now. Stop here: the value arrives as the next message, never as an argument of yours. Ask for a secret this way only, and never ask a person to paste a password into the chat.`,
        });
      } catch (error) {
        return result(failed(messageOf(error)));
      }
    },
  }),
  defineTool({
    name: "secret_list",
    description:
      "List the secrets you may read: each name with its scope, its owner and when it expires, never a value. Use it to find the exact name before reading or removing one.",
    parameters: Type.Object({
      scope: scopeParameter,
      limit: limitParameter,
    }),
    replay: "safe",
    async execute(args) {
      try {
        const scope = scopeOf(args.scope);
        const listed = await host.list({
          limit: limitOf(args.limit),
          ...(scope === undefined ? {} : { scope }),
        });
        return result(
          text({
            items: listed.items.map((item) => ({
              key: item.key,
              scope: item.scope,
              botId: item.botId,
              ...(item.purpose === undefined ? {} : { purpose: item.purpose }),
              createdAt: item.createdAt,
              updatedAt: item.updatedAt,
              ...(item.expiresAt === undefined ? {} : { expiresAt: item.expiresAt }),
            })),
            truncated: listed.truncated,
          }),
        );
      } catch (error) {
        return result(failed(messageOf(error)));
      }
    },
  }),
  defineTool({
    name: "secret_read",
    description:
      "Describe one secret you may use: its scope, its lifetime, its size and the environment variable it reaches a command by. The value itself never enters the conversation — that is what keeps it out of the transcript — so use it through that variable in bash: export GH_TOKEN=$EAGLE_SECRET_GITHUB_PAT, or pass it straight to a command. Never echo the variable and never write the value into a file you commit.",
    parameters: Type.Object({
      key: Type.String({ description: "The secret's exact name, as secret_list shows it" }),
      scope: scopeParameter,
    }),
    replay: "safe",
    async execute(args) {
      try {
        const key = keyOf(args.key);
        const scope = scopeOf(args.scope);
        const found = await host.read({ key, ...(scope === undefined ? {} : { scope }) });
        if (found === undefined) {
          return result(
            failed(
              `no secret named "${key}" in the bot scope or the shared scope; secret_list shows what exists`,
            ),
          );
        }
        const env = host.envNameFor(found.key);
        return result(
          text({
            key: found.key,
            scope: found.scope,
            bytes: Buffer.byteLength(found.value, "utf8"),
            environment: env ?? null,
            ...(env === null
              ? { problem: "this name collides with another record after normalisation" }
              : {}),
            use: "the value is not printed: it is in your bash environment under that name",
          }),
        );
      } catch (error) {
        return result(failed(messageOf(error)));
      }
    },
  }),
  defineTool({
    name: "secret_delete",
    description:
      "Remove one secret you may remove: your own records and the shared ones you created. A name that is already gone is success, not an error, so a retry is harmless.",
    parameters: Type.Object({
      key: Type.String({ description: "The secret's exact name" }),
      scope: Type.Union([Type.Literal("bot"), Type.Literal("shared")], {
        description:
          "Required: which record to remove. Your own record and a shared one with the same name are two records, and a retry must not fall through to the other",
      }),
    }),
    replay: "safe",
    async execute(args) {
      try {
        const key = keyOf(args.key);
        const scope = scopeOfRequired(args.scope);
        const gone = await host.remove({ key, scope });
        return result(text({ key: gone.key, scope: gone.scope, deleted: gone.deleted }));
      } catch (error) {
        return result(failed(messageOf(error)));
      }
    },
  }),
];

export const secretsExtension = (host: SecretsToolHost) =>
  defineExtension({
    name: SECRETS_TOOLS_EXTENSION,
    tools: createSecretsTools(host),
    sections: [
      section(SECRETS_TOOLS_EXTENSION, () =>
        [
          "A secret is a password, a token or a key the person gives you without putting it in the chat.",
          "Ask for one with secret_request: it puts a card with a single password field in front of the person and returns at once. This is the only recommended way to ask for a secret — never ask a person to paste a password into the conversation, where it would stay in the transcript and in every later prompt of that conversation.",
          "The value is never given to you as text: it sits in your bash environment under the variable secret_read names for the record, so use it there and never echo it or copy it into a file.",
          "Your own record comes first and a shared record follows it; secret_list shows every record with its own scope, and secret_delete removes one you may remove, with the scope named.",
          "A secret is not a memory record: never write a secret into memory, and remove it when the work is done.",
        ].join("\n"),
      ),
    ],
  });
