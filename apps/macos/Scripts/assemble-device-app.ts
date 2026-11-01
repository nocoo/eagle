// Candidate bundle preparation/signing only. The caller stages a new .app and
// publishes it only after runtime assembly and every signing verification pass.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { verifyRuntimeLinks } from "./assemble-device-runtime.ts";

type Profile = "device-candidate" | "device-release";
type HostConfig = {
  version: 1;
  profile: Profile;
  baseUrl: string;
  machServiceName: string;
  launchAgentPlist: string;
};
type PrepareOptions = {
  sourceRoot: string;
  app: string;
  binary: string;
  helper: string;
  /** The `eagle` / `eagle-dev` command this bundle installs (docs/bots/CLI.md). */
  cli?: string;
  profile: Profile;
  serviceUrl?: string;
  /** Where the app links a person for the code, the releases and the version check. */
  links?: { github?: string; release?: string; updates?: string };
};
type Execute = (program: string, args: string[]) => unknown;
const save = (path: string, value: unknown) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
/** A build-time origin is optional: a published App ships none and the person names one. */
function origin(value: string | undefined): string {
  const requirement =
    "a service origin must be an HTTPS origin without path, query or credentials";
  if (!value) throw new Error(requirement);
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(requirement);
  return url.origin;
}
function xml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
export function prepareDeviceBundle(options: PrepareOptions): void {
  const { sourceRoot, app, binary, helper, profile } = options;
  if (!app.endsWith(".app") || existsSync(app))
    throw new Error("bundle destination must be a new .app");
  const macos = join(sourceRoot, "apps/macos");
  const support = join(macos, "Support");
  const config = JSON.parse(
    readFileSync(
      join(
        support,
        profile === "device-candidate"
          ? "DeviceHost.candidate.json"
          : "DeviceHost.release.json",
      ),
      "utf8",
    ),
  ) as HostConfig;
  if (options.serviceUrl) config.baseUrl = origin(options.serviceUrl);
  if (!existsSync(binary) || !existsSync(helper))
    throw new Error("Eagle and EagleDeviceHelper binaries are required");
  // The app's version is its own: releases of the website, the Agent and the app are
  // independent, so this file is the single source for every bundle the app is built into.
  const version = JSON.parse(
    readFileSync(join(sourceRoot, "apps/macos/Support/Version.json"), "utf8"),
  ).version as string;
  const buildVersion =
    profile === "device-candidate" ? String(Date.now()) : version;
  const templatePlist = config.launchAgentPlist;
  const templateService = config.machServiceName;
  if (profile === "device-candidate") {
    config.machServiceName = `${templateService}.${buildVersion}`;
    config.launchAgentPlist = `${config.machServiceName}.plist`;
  }
  const helperRelative = "Contents/Library/LaunchServices/EagleDeviceHelper";
  const identifier =
    profile === "device-candidate"
      ? "ai.hexly.eagle.macos.device-candidate"
      : "ai.hexly.eagle.macos";
  const name =
    profile === "device-candidate" ? "Eagle Device Candidate" : "Eagle for Mac";
  let info = readFileSync(join(support, "Info.plist"), "utf8");
  info = info.replace(
    "</dict>",
    "  <key>EagleDeviceMaintenanceVersion</key>\n  <integer>1</integer>\n</dict>",
  );
  const linkKeys: Record<string, string | undefined> = {
    EagleGitHubURL: options.links?.github,
    EagleReleaseURL: options.links?.release,
    EagleUpdatesURL: options.links?.updates,
  };
  const linkPlist = Object.entries(linkKeys)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(
      ([key, value]) =>
        `  <key>${key}</key>\n  <string>${xml(value as string)}</string>`,
    )
    .join("\n");
  if (linkPlist.length > 0)
    info = info.replace("</dict>", `${linkPlist}\n</dict>`);
  for (const [key, value] of Object.entries({
    CFBundleIdentifier: identifier,
    CFBundleName: name,
    CFBundleDisplayName: name,
    CFBundleShortVersionString: version,
    // Candidate rebuilds have different signatures even when the release version is unchanged.
    // Give ServiceManagement a distinct parent build instead of reusing an old launch constraint.
    CFBundleVersion: buildVersion,
  }))
    info = info.replace(
      new RegExp(`(<key>${key}</key>\\s*)<string>[^<]*</string>`),
      `$1<string>${xml(value)}</string>`,
    );
  const contents = join(app, "Contents");
  const resources = join(contents, "Resources");
  mkdirSync(join(contents, "MacOS"), { recursive: true });
  mkdirSync(join(contents, "Helpers"), { recursive: true });
  mkdirSync(resources);
  mkdirSync(join(contents, "Library/LaunchServices"), { recursive: true });
  mkdirSync(join(contents, "Library/LaunchAgents"));
  copyFileSync(binary, join(contents, "MacOS/Eagle"));
  copyFileSync(helper, join(app, helperRelative));
  chmodSync(join(contents, "MacOS/Eagle"), 0o755);
  chmodSync(join(app, helperRelative), 0o755);
  if (options.cli !== undefined) {
    // A released App installs `eagle`; a candidate keeps `eagle-dev`, so the two never
    // take each other's link, config file or credential.
    const command = join(
      contents,
      `Helpers/${profile === "device-release" ? "eagle" : "eagle-dev"}`,
    );
    copyFileSync(options.cli, command);
    chmodSync(command, 0o755);
  }
  writeFileSync(join(contents, "Info.plist"), info);
  copyFileSync(
    join(macos, "Sources/EagleDesign/Resources/AppIcon.icns"),
    join(resources, "AppIcon.icns"),
  );
  save(join(resources, "DeviceHost.json"), config);
  let launchConfiguration = readFileSync(join(support, templatePlist), "utf8");
  if (profile === "device-candidate") {
    // A new service name prevents BTM from reusing a previous helper's launch constraint.
    launchConfiguration = launchConfiguration.replaceAll(
      templateService,
      config.machServiceName,
    );
  }
  writeFileSync(
    join(contents, "Library/LaunchAgents", config.launchAgentPlist),
    launchConfiguration,
  );
  for (const entry of readdirSync(dirname(binary), { withFileTypes: true }))
    if (entry.isDirectory() && entry.name.endsWith(".bundle"))
      cpSync(join(dirname(binary), entry.name), join(resources, entry.name), {
        recursive: true,
        verbatimSymlinks: true,
      });
}
/** Resolve only the signed candidate's own job, including pre-versioning installs. */
export function deviceCandidateServiceLabel(app: string): string {
  const config = JSON.parse(
    readFileSync(join(app, "Contents/Resources/DeviceHost.json"), "utf8"),
  ) as HostConfig;
  const build = readFileSync(join(app, "Contents/Info.plist"), "utf8").match(
    /<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/,
  )?.[1];
  const legacy = "ai.hexly.eagle.devices.candidate";
  if (
    config.profile !== "device-candidate" ||
    config.launchAgentPlist !== `${config.machServiceName}.plist` ||
    (config.machServiceName !== legacy &&
      (!build ||
        !/^[0-9]{1,20}$/.test(build) ||
        config.machServiceName !== `${legacy}.${build}`))
  )
    throw new Error("invalid candidate device service");
  return config.machServiceName;
}
/** The signed launch plist is the common source for signing and installer ownership checks. */
export function deviceHelperRelativePath(app: string): string {
  const config = JSON.parse(
    readFileSync(join(app, "Contents/Resources/DeviceHost.json"), "utf8"),
  ) as HostConfig;
  if (
    config.launchAgentPlist.includes("/") ||
    config.launchAgentPlist !== `${config.machServiceName}.plist`
  )
    throw new Error("invalid device launch configuration");
  const plist = readFileSync(
    join(app, "Contents/Library/LaunchAgents", config.launchAgentPlist),
    "utf8",
  );
  const program = plist.match(
    /<key>BundleProgram<\/key>\s*<string>([^<]+)<\/string>/,
  )?.[1];
  const build = readFileSync(join(app, "Contents/Info.plist"), "utf8").match(
    /<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/,
  )?.[1];
  const legacy = "Contents/Library/LaunchServices/EagleDeviceHelper";
  if (
    program !== legacy &&
    !(
      config.profile === "device-candidate" &&
      /^\d{1,20}$/.test(build ?? "") &&
      program === `${legacy}.${build}`
    )
  )
    throw new Error("invalid bundled helper path");
  return program;
}

export function copyDeviceRuntime(source: string, destination: string): void {
  if (existsSync(destination))
    throw new Error("runtime copy destination already exists");
  const originalNode = createHash("sha256")
    .update(readFileSync(join(source, "node")))
    .digest("hex");
  try {
    cpSync(source, destination, {
      recursive: true,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
    });
    verifyRuntimeLinks(destination);
    if (
      createHash("sha256")
        .update(readFileSync(join(destination, "node")))
        .digest("hex") !== originalNode
    )
      throw new Error("bundled Node changed during runtime copy");
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}
function nativeCode(root: string): string[] {
  const paths: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        const fd = openSync(path, "r");
        const header = Buffer.alloc(4);
        try {
          readSync(fd, header, 0, 4, 0);
        } finally {
          closeSync(fd);
        }
        if (
          [
            "feedface",
            "feedfacf",
            "cefaedfe",
            "cffaedfe",
            "cafebabe",
            "bebafeca",
            "cafebabf",
            "bfbafeca",
          ].includes(header.toString("hex"))
        )
          paths.push(path);
      }
    }
  };
  visit(root);
  return paths;
}
export function signDeviceBundle(
  app: string,
  identity: string,
  execute: Execute = (program, args) =>
    execFileSync(program, args, { stdio: "pipe" }),
  /** A published build may be ad-hoc signed on purpose: it is un-notarized and needs a manual
   * quarantine removal, so it takes an explicit opt-in rather than a default. */
  allowAdhoc = false,
): void {
  const resources = join(app, "Contents/Resources");
  const config = JSON.parse(
    readFileSync(join(resources, "DeviceHost.json"), "utf8"),
  ) as HostConfig;
  if (
    !identity ||
    (identity === "-" && config.profile !== "device-candidate" && !allowAdhoc)
  )
    throw new Error("release requires an explicit signing identity");
  const runtime = join(resources, "DeviceRuntime");
  verifyRuntimeLinks(runtime);
  const node = join(runtime, "node");
  const nodeDigest = () =>
    createHash("sha256").update(readFileSync(node)).digest("hex");
  const originalNode = nodeDigest();
  const verify = (path: string, deep = false) =>
    execute("/usr/bin/codesign", [
      "--verify",
      ...(deep ? ["--deep"] : []),
      "--strict",
      "--verbose=2",
      path,
    ]);
  const sign = (path: string, identifier?: string) => {
    execute("/usr/bin/codesign", [
      "--force",
      "--sign",
      identity,
      ...(identifier ? ["--identifier", identifier] : []),
      "--options",
      "runtime",
      identity === "-" ? "--timestamp=none" : "--timestamp",
      path,
    ]);
    verify(path);
  };
  verify(node);
  for (const path of nativeCode(runtime)) if (path !== node) sign(path);
  sign(
    join(app, deviceHelperRelativePath(app)),
    config.profile === "device-candidate"
      ? "ai.hexly.eagle.devices.candidate.helper"
      : undefined,
  );
  save(join(resources, "DeviceSigning.json"), {
    version: 1,
    mode:
      identity === "-"
        ? config.profile === "device-candidate"
          ? "ad-hoc-candidate"
          : "ad-hoc-release"
        : "configured-identity",
    nodeSignature: "preserved",
  });
  sign(app);
  verify(app, true);
  verify(node);
  if (nodeDigest() !== originalNode)
    throw new Error("bundled Node changed during signing");
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const { values } = parseArgs({
      options: {
        mode: { type: "string", default: "prepare" },
        app: { type: "string" },
        binary: { type: "string" },
        helper: { type: "string" },
        profile: { type: "string", default: "device-candidate" },
        cli: { type: "string" },
        "service-url": { type: "string" },
        "github-url": { type: "string" },
        "release-url": { type: "string" },
        "updates-url": { type: "string" },
        identity: { type: "string", default: "-" },
        "allow-adhoc": { type: "boolean", default: false },
        "source-root": {
          type: "string",
          default: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
        },
      },
    });
    if (!values.app) throw new Error("--app is required");
    if (values.mode === "sign")
      signDeviceBundle(
        resolve(values.app),
        values.identity,
        undefined,
        values["allow-adhoc"],
      );
    else {
      if (
        values.mode !== "prepare" ||
        !values.binary ||
        !values.helper ||
        !["device-candidate", "device-release"].includes(values.profile)
      )
        throw new Error(
          "prepare requires --binary, --helper and a valid --profile",
        );
      prepareDeviceBundle({
        sourceRoot: resolve(values["source-root"]),
        app: resolve(values.app),
        binary: resolve(values.binary),
        helper: resolve(values.helper),
        cli: values.cli === undefined ? undefined : resolve(values.cli),
        profile: values.profile as Profile,
        serviceUrl: values["service-url"],
        links: {
          github: values["github-url"],
          release: values["release-url"],
          updates: values["updates-url"],
        },
      });
    }
    process.stdout.write(`${values.app}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "bundle assembly failed"}\n`,
    );
    process.exitCode = 1;
  }
}
