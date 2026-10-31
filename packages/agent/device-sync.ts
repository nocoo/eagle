import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";
import { TailscaleAddress } from "../contracts/src/device-sync.ts";

const exec = promisify(execFile);
const status = z.object({
  BackendState: z.string(),
  Self: z.unknown().optional(),
});
async function probe(binary: string): Promise<string> {
  try {
    return (
      await exec(binary, ["status", "--json"], {
        timeout: 3000,
        maxBuffer: 1048576,
      })
    ).stdout;
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout;
    if (typeof stdout === "string") {
      try {
        const parsed = status.parse(JSON.parse(stdout));
        if (["NeedsLogin", "Stopped", "NoState"].includes(parsed.BackendState))
          return stdout;
      } catch {
        /* An unsuccessful, malformed CLI response is a discovery failure. */
      }
    }
    throw error;
  }
}

/** Only this device's Tailscale Self addresses; never its peers or LAN interfaces. */
export async function syncSelf(): Promise<{
  version: 1;
  addresses: string[];
  digest: string;
}> {
  const result = (addresses: string[]) => {
    addresses = [
      ...new Set(addresses.map((address) => address.toLowerCase())),
    ].sort();
    return {
      version: 1 as const,
      addresses,
      digest: createHash("sha256")
        .update(JSON.stringify(addresses))
        .digest("hex"),
    };
  };
  let output: string;
  try {
    output = await probe("tailscale");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error("tailscale_discovery_failed", { cause: error });
    try {
      output = await probe(
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
      );
    } catch (fallback) {
      if ((fallback as NodeJS.ErrnoException).code === "ENOENT")
        return result([]);
      throw new Error("tailscale_discovery_failed", { cause: fallback });
    }
  }
  const parsed = status.parse(JSON.parse(output));
  if (parsed.BackendState !== "Running") return result([]);
  const self = z
    .object({ TailscaleIPs: z.array(TailscaleAddress).max(8) })
    .parse(parsed.Self);
  return result(self.TailscaleIPs);
}

export async function syncCandidates(
  port: number | null,
): Promise<{ address: string; port: number }[]> {
  if (port === null) return [];
  return (await syncSelf()).addresses.map((address) => ({ address, port }));
}
