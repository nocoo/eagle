interface Env {
  /** Optional legacy machine tokens, JSON object keyed by machine ID. */
  AGENT_TOKENS?: string;
  /** Local-only viewer email for the avatar preview. */
  LOCAL_USER_EMAIL?: string;
  /** Injected by scripts/deploy.ts; absent when a release ships no macOS app. */
  MACOS_VERSION?: string;
  MACOS_RELEASE_URL?: string;
}
