# Machine environment resources

Resources use the existing Agent report, machine Durable Object and machine
page. There is no additional collector service or remote telemetry destination.
Website/Worker **0.10.1** and independent npm Agent **0.8.1** ship together.
Website `config.publishedAgentVersion` pins the verified Agent artifact for
Connect. Upgrade the receiving Worker before installing the Agent's additional
environment fields. Publication does not automatically upgrade or restart
installed agents; service upgrades require explicit authorization.

## Sampling and cost

Agent **0.8.1** adds optional, read-only macOS hardware observations.
Connect pins the independently published Agent version.
Install `macmon` separately on Apple Silicon and make it available on the
collector service's PATH. No automatic installation, privilege elevation or
fan-control command is performed. One bounded macmon JSON sample per fast cycle
provides CPU/GPU temperatures, GPU active percentage, per-fan RPM/maximum RPM,
used memory and swap. Missing tools, unsupported machines or invalid readings
remain unknown. Fields are allowlisted; raw output and device identifiers are
not reported. These are macmon readings, not calibrated sensor guarantees.

macOS traffic uses two bounded `netstat -ibn` reads approximately 500 ms apart.
Only one link-layer counter per physical `en` interface participates; loopback,
VPN/tunnel and virtual interfaces are excluded to avoid double counting. Rates
include LAN traffic, not just Internet traffic. Counter resets or interface
changes invalidate the sample. No link-speed percentage or health score is
inferred. Linux keeps its existing CPU thermal probe; GPU/fan/traffic readings
are unavailable there. New readings stay in the current snapshot and existing
daily-input retention; no history table or longer retention is introduced.

| Measurement | Target cadence | Meaning and cost |
| --- | --- | --- |
| CPU | 30 seconds | Utilization across logical CPUs over a fresh approximately 250 ms window; percent, not a 30-second average |
| Load | 30 seconds | OS 1/5/15-minute load averages; runnable/uninterruptible work, not percentages; unavailable on unsupported platforms |
| Memory | 30 seconds | History uses OS total/free bytes; the card uses macmon used RAM when available, otherwise total minus free. Neither is memory pressure |
| Network and VPN | 30 seconds | Two bounded OS status commands; each at most 1.5 seconds and 32 KiB of output; no packets sent to test public Internet |
| Home-filesystem disk | 300 seconds by default | One `statfs` on the collector user's home filesystem, not an all-volume scan; total/available bytes |
| Linux CPU temperature | 300 seconds by default | Celsius from a bounded Linux CPU thermal-zone allowlist |
| macOS hardware and traffic | 30 seconds | Optional bounded unprivileged macmon and physical-interface counter samples; no controls |

`intervalSeconds` is now required to be **30** when present. Older configurations
that chose a different report cadence must explicitly set 30 before starting the
new Agent. `slowIntervalSeconds` defaults to **300**, accepts integer values from
**60 through 3600**, and controls disk and Linux temperature together:

```json
{
  "intervalSeconds": 30,
  "slowIntervalSeconds": 300
}
```

These are fields to merge into the secure Agent config, not a replacement config.
The existing awaited watch loop schedules the next complete report from the
start of the previous cycle. A slow collection/upload delays the next cycle;
cycles never overlap or synthesize missed samples. Calls to the same resource
sampler share an in-flight sample. Keep one collector process per secure config,
as required by the existing Agent contract.

Slow measurements retain their original observation time when reused. The
existing private `latest-report.json` cache can reuse them after a restart or a
one-shot invocation. Expired or future cache times cause a fresh read. Failed
reads remain null/unavailable and are not retried every fast cycle. No new
credential, OS service, elevated command or kernel component is installed.

## Network, VPN and temperature evidence

Only allowlisted numeric readings, state enums, fixed source identifiers and timestamps leave the probe.
Interface names, service/profile names, IP addresses, routes, connection lists,
peers, public keys and command output are never included in telemetry. The
network commands inspect status; they do not enumerate network connections.

- **macOS network:** `scutil -r 0.0.0.0` reports whether the OS has a reachable
  network path. `Reachable` without a required/on-demand connection means
  connected; `Not Reachable` means disconnected. Transitional/unrecognized
  output or command failure means unknown. This does not certify DNS, a remote
  server, or public Internet access.
- **macOS VPN:** `scutil --nc list` must report a connection row as `Connected`
  to establish connected. All recognized services reporting `Disconnected`
  establishes disconnected only when there is no unclassified tunnel interface.
  No registered service, missing permission/tool, transition, or an unclassified
  `utun`/`tun`/`tap`/`wg`/`ppp`/`ipsec`/`tailscale`/`zt` interface means unknown. A tunnel alone
  never certifies a connected VPN; a registered disconnected profile does not
  disprove an unmanaged VPN. Profile names are discarded.
- **Linux network:** installed NetworkManager's `nmcli ... general` state
  distinguishes connected (including local-only) and disconnected/asleep.
  Missing NetworkManager and transitional output remain unknown; nothing is
  installed automatically.
- **Linux VPN:** an active NetworkManager `vpn:activated` connection establishes
  connected. Only recognized active non-tunnel connection types, with no
  unclassified tunnel interfaces, establish no detected active VPN. WireGuard
  activation alone does not prove a peer handshake and remains unknown. Empty,
  unsupported or failed status output remains unknown. These states describe
  observable OS evidence, not an exhaustive claim about every third-party VPN.
- **Temperature:** macOS without macmon and unsupported platforms report `unavailable` with
  `celsius:null`. Linux reads at most 16 `/sys/class/thermal/thermal_zone*`
  entries and only `x86_pkg_temp`, `cpu-thermal`, `cpu_thermal`, or `soc_thermal`
  zones. It reports the maximum valid CPU/SoC reading, in Celsius. Empty,
  unreadable, unrecognized or out-of-range (-20 to 150 Celsius) data remains
  unavailable. No `sudo`, SMC helper, `powermetrics`, kernel extension, peer
  enumeration or privileged sensor package is used.

## Protocol, persistence and history

Whole-machine report `schemaVersion:1` is retained. Optional telemetry additions
are `sampleIntervalSeconds`, `slowIntervalSeconds`, `diskObservedAt`, `network`,
`vpn`, `temperature`, optional `hardware` and `traffic`. Old v1 reports retain their exact parsed fields and
receipt digest; absent telemetry or fields remain unknown. New strict servers
must be deployed before new agents because old servers reject added fields.
The generated public JSON Schema describes the input contract.

The existing `POST /api/v1/reports` write creates a compact DO resource sample:
UTC ISO observation time, nominal interval, CPU percent, memory percent, and
1/5/15-minute load. Disk, temperature, network, ports and full reports are not
copied into this chart table. Their latest observations remain in the existing
current snapshot. The existing 48-hour daily-report input retention is separate.

- A sample is keyed by normalized `telemetry.observedAt`, never receipt time.
- Replayed reports and same-time observations do not add duplicate points. The
  first accepted value at the same observation time is retained.
- Valid late reports can fill earlier history without rolling back current
  state, which retains its existing capture-time/report-ID ordering.
- Conflicting report IDs and future timestamps beyond the existing five-minute
  skew allowance are rejected. Child observations cannot exceed the parent
  telemetry observation time. Future points are hidden until their time arrives.
- Each machine retains **at most 24 hours and 2880 newest points**. Denser
  submissions can shorten the visible window. Expiration and count pruning run
  on ingestion and history reads; stale points on an idle object are removed at
  its next access. Restart/eviction preserves the SQLite history.
- Failed resource measurements produce null values; reports without telemetry
  do not fabricate a point. No raw-report D1 archive write is re-enabled.

`GET /api/v1/resources?machine=ID` returns
`{retentionSeconds:86400,samples:[...]}` in ascending observation order.
It requires a verified viewer or the existing local-development authentication;
Agent credentials do not authorize it. Unknown/disabled machines return 404,
missing/invalid IDs 400, and non-GET methods 405. Responses are `no-store`.

## Machine details

Section **01 Space** is preserved. **02 Environment resources** retains the
CPU/memory/disk/uptime and watched-port overview. Six read-only cards show CPU,
GPU, memory, disk, aggregate physical-network rates and fans in two equal-width
columns. CPU/GPU cards include temperature, the network card retains network/VPN
status, and uptime appears with machine metadata. Every card has an accessible
top-right information control. Fan RPM is the fastest reported fan; the meter
is the highest actual/maximum RPM ratio, not a cooling-load estimate. All fan
readings remain in its tooltip. No overall health score, fan-control buttons,
fabricated trends or inferred Wi-Fi connection type are shown.

The page reads resource history for only the selected machine. It refreshes when the
current sample changes or the user requests a refresh, not on every unchanged
five-second overview poll. Switching machines aborts stale reads. Failed history
refreshes keep the last valid data with an error; 401/403 clears protected chart
data and asks the viewer to sign in again.

The chart defaults to the latest six hours. The top-right 6h/12h/24h segment
filters the already-loaded history and fixes the time axis to the selected
rolling window; it does not fetch again or change storage retention. Samples
outside the selected window, including future observations, are not displayed.
CPU, GPU, memory, disk and fan cards show equal-width meters alongside their
numeric values. Disk usage is total minus available space, while its primary
number remains available GiB. Missing values do not produce a zero meter;
uptime has no percentage meter.

CPU and memory use a fixed **0–100% left axis**. Load uses an independently
scaled **right axis**, with three dashed 1/5/15-minute lines and unit-aware
hover values. All timestamps follow the existing timezone preference. Nulls and
gaps longer than two reported sample periods break the curves. Unknown cadence
does not imply a 30-second period or fabricate gaps between observed points;
the time after the last observation remains empty. No zero fill or extrapolation
is performed. Disk and temperature
stay out of the chart to avoid interpolating cached observations.

Network/fast observations become historical after 90 seconds or loss of machine
heartbeat. Disk/temperature carry their own timestamps and become historical
after their configured slow period plus 90 seconds (macmon hardware uses 90
seconds), or when the machine is
stale/offline. Missing fields and unavailable sensors never display invented
zero values. The historical chart remains readable when a machine is offline.

## Verification and rollout boundary

Collector tests use injected clocks/probes and bounded local OS reads. Protocol
and history checks use isolated Miniflare/SQLite, including eviction and both
retention limits. Browser journeys exercise actual axes, line styles, nulls,
offline states, failure/auth handling and machine-switch isolation. No React
component unit tests were introduced.

The implementation was additionally checked with two read-only local resource
samples 30 seconds apart, and a temporary loopback Worker at 17053 using
`.local/resources-20261002/smoke-state`. Thirty-five clearly labeled synthetic
reports traversed authenticated report ingestion, DO history and the built
browser application in dark/light desktop and mobile views. The synthetic
registration was revoked after verification; daily development state and
production were untouched. Screenshots and sanitized receipts are under
`.local/resources-20261002/`. Caddy and ordinary service panes p4/p5 remain the
existing local development services.
