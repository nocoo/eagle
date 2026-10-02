import assert from "node:assert/strict";
import { test } from "node:test";
import {
  networkState,
  readTemperature,
  vpnState,
} from "../agent/environment.ts";

test("network status uses OS reachability without claiming public Internet health", () => {
  assert.equal(networkState("darwin", "Reachable"), "connected");
  assert.equal(networkState("darwin", "Not Reachable"), "disconnected");
  assert.equal(
    networkState("darwin", "Reachable,Connection Required"),
    "unknown",
  );
  assert.equal(networkState("linux", "connected (local only)"), "connected");
  assert.equal(networkState("linux", "disconnected"), "disconnected");
  assert.equal(networkState("linux", "connecting"), "unknown");
  assert.equal(networkState("darwin", null), "unknown");
});

test("VPN requires an active OS-managed connection; tunnel presence is never positive evidence", () => {
  const disconnected =
    'Available network connection services in the current set:\n* (Disconnected) id (VPN:Example) "private name"';
  assert.equal(vpnState("darwin", disconnected, ["utun3"]), "unknown");
  assert.equal(vpnState("darwin", disconnected, ["en0"]), "disconnected");
  assert.equal(
    vpnState("darwin", disconnected.replace("Disconnected", "Connected"), [
      "utun3",
    ]),
    "connected",
  );
  assert.equal(
    vpnState(
      "darwin",
      "Available network connection services in the current set:",
      [],
    ),
    "unknown",
  );
  assert.equal(
    vpnState("linux", "802-3-ethernet:activated", ["tun0"]),
    "unknown",
  );
  assert.equal(vpnState("linux", "vpn:activated", []), "connected");
  assert.equal(vpnState("linux", "wireguard:activated", []), "unknown");
  assert.equal(
    vpnState("linux", "802-3-ethernet:activated", ["eth0"]),
    "disconnected",
  );
  assert.equal(
    vpnState("linux", "802-3-ethernet:activated", ["tailscale0"]),
    "unknown",
  );
  assert.equal(
    vpnState("linux", "802-3-ethernet:activated", ["ztabcd1234"]),
    "unknown",
  );
  assert.equal(vpnState("linux", null, ["eth0"]), "unknown");
});

test("temperature stays unavailable on macOS and reads only bounded Linux CPU sensors", async () => {
  let reads = 0;
  const read = async (path: string) => {
    reads++;
    if (path.endsWith("type"))
      return path.includes("thermal_zone0") ? "x86_pkg_temp\n" : "acpitz\n";
    return "42500\n";
  };
  assert.deepEqual(
    await readTemperature("darwin", read, async () => ["thermal_zone0"]),
    { status: "unavailable", celsius: null, source: "unsupported" },
  );
  assert.equal(reads, 0);
  assert.deepEqual(
    await readTemperature("linux", read, async () => [
      "thermal_zone0",
      "thermal_zone1",
    ]),
    { status: "available", celsius: 42.5, source: "linux-cpu-thermal" },
  );
  assert.equal(reads, 3);
  assert.equal(
    (
      await readTemperature(
        "linux",
        async () => {
          throw Error("permission");
        },
        async () => ["thermal_zone0"],
      )
    ).status,
    "unavailable",
  );
});

test("malformed OS output and blank thermal data remain unknown instead of fabricating readings", async () => {
  assert.equal(
    vpnState("darwin", '* (Disconnected) id "Profile (Connected)"', []),
    "disconnected",
  );
  assert.equal(vpnState("linux", "unexpected output", ["eth0"]), "unknown");
  const result = await readTemperature(
    "linux",
    async (path) => (path.endsWith("type") ? "x86_pkg_temp" : " \n"),
    async () => ["thermal_zone0"],
  );
  assert.equal(result.status, "unavailable");
  assert.equal(result.celsius, null);
});
