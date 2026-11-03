// The address a decision provider is asked at (docs/bots/PROTOCOL.md, "Providers"): one rule,
// shared by the store that publishes it and the transport that calls it.
/** An absolute http(s) URL without its trailing slash, or nothing. */
const normalizeBaseUrl = (value: string): string | undefined => {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
};

/** Why an address was refused; one wording for the form, the store and the probe. */
export const ADDRESS_REFUSED = "地址需要 http 或 https 的 API 根，不能带凭据、查询或片段";

/**
 * The API root of a System One endpoint. A person may paste the address they use for the model
 * gateway (`…/v1`) or the full endpoint; both collapse to the root, and the result is idempotent
 * because the path is appended again rather than kept. Credentials, a query and a fragment are
 * refused: this address is echoed back by the settings page, and `/v1/systemone` cannot be
 * appended to one that already carries them.
 */
export const decisionRoot = (value: string): string | undefined => {
  const typed = value.trim();
  if (typed.includes("?") || typed.includes("#")) return undefined;
  const normalized = normalizeBaseUrl(typed);
  if (normalized === undefined) return undefined;
  const url = new URL(normalized);
  if (url.username.length > 0 || url.password.length > 0) return undefined;
  return normalized.replace(/\/v1\/systemone$/, "").replace(/\/v1$/, "");
};
