declare global {
  interface Window {
    __EAGLE_LOCAL__?: boolean;
  }
}

export const localFrontend = window.__EAGLE_LOCAL__ === true;
const storageKey = "eagle-environment";

function initialEnvironment(): "local" | "prod" {
  if (!localFrontend) return "prod";
  try {
    return sessionStorage.getItem(storageKey) === "prod" ? "prod" : "local";
  } catch {
    return "local";
  }
}

export const environment = initialEnvironment();
export const localProduction = localFrontend && environment === "prod";
export const authenticationMessage = localProduction
  ? "请在本机终端运行 cloudflared access login --quiet https://eagle.hexly.ai，然后重试。"
  : "请通过 Cloudflare Access 重新登录";
export const ingestOrigin =
  environment === "local"
    ? window.location.origin
    : "https://eagle-ingest.hexly.ai";

export function apiPath(path: string) {
  return localProduction ? `/__local/prod${path}` : path;
}

export function selectEnvironment(value: string) {
  if (!localFrontend || value === environment) return;
  if (value !== "local" && value !== "prod") return;
  sessionStorage.setItem(storageKey, value);
  window.location.assign("/");
}
