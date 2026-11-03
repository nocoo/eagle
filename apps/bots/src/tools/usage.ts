// The usage contract a tool reports through (docs/bots/PROTOCOL.md, "Usage statistics").
// It lives beside the tools because the tool layer may not import core or server code; the
// daemon's store has the same shape, so one object satisfies both.
export type UsageSource = string;

export type UsageEntry = {
  readonly botId: string;
  readonly source: UsageSource;
  readonly tokens?: number;
  readonly calls?: number;
  readonly costUsd?: number;
  readonly counter?: string;
  readonly at?: number;
};

export interface UsageMeter {
  record(entry: UsageEntry): void;
}
