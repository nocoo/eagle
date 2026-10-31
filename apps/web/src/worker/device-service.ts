import pkg from "../../../../package.json" with { type: "json" };
import { DEVICE_PREFIX } from "../../../../packages/contracts/src/devices.ts";
import { DeviceExecution } from "./device-execution.ts";
import { DeviceRegistry, deviceJSON } from "./device-registry.ts";

export { DeviceExecution, DeviceRegistry };

export type DeviceServiceEnv = {
  DEVICE_REGISTRY: DurableObjectNamespace<DeviceRegistry>;
  DEVICE_EXECUTION: DurableObjectNamespace<DeviceExecution>;
  BUILD_REVISION: string;
};

/** Fixed service-binding metadata RPC; public fetch never exposes this verifier. */
export class SyncCacheRegistry extends WorkerEntrypoint<DeviceServiceEnv> {
  checkRelayAuthority(input: unknown) {
    return this.env.DEVICE_REGISTRY.getByName("registry").checkRelayAuthority(
      input,
    );
  }
  checkCacheAuthority(input: unknown) {
    return this.env.DEVICE_REGISTRY.getByName("registry").checkCacheAuthority(
      input,
    );
  }
}

export default {
  fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/api/live") {
      if (request.method !== "GET") {
        const response = deviceJSON({ error: "method_not_allowed" }, 405);
        response.headers.set("Allow", "GET");
        return response;
      }
      return deviceJSON({
        status: "ok",
        service: "eagle-devices",
        version: pkg.version,
        revision: env.BUILD_REVISION,
      });
    }
    if (path === DEVICE_PREFIX || path.startsWith(`${DEVICE_PREFIX}/`)) {
      if (!env.DEVICE_REGISTRY)
        return deviceJSON({ error: "device_service_unavailable" }, 503);
      const execution = path.match(
        /^\/api\/devices\/v1\/execution\/([0-9a-fA-F-]{36})\/(agent|request)$/,
      );
      if (execution) {
        if (!env.DEVICE_EXECUTION)
          return deviceJSON({ error: "device_service_unavailable" }, 503);
        return env.DEVICE_EXECUTION.getByName(execution[1].toLowerCase()).fetch(
          request,
        );
      }
      return env.DEVICE_REGISTRY.getByName("registry").fetch(request);
    }
    return deviceJSON({ error: "not_found" }, 404);
  },
} satisfies ExportedHandler<DeviceServiceEnv>;

import { WorkerEntrypoint } from "cloudflare:workers";
