import EagleDevices
import Foundation
import Testing

@testable import EagleFeatures

@Suite("Bots daemon supervisor")
@MainActor
struct BotsDaemonSupervisorTests {
  private func tree() throws -> URL {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("eagle-daemon-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(
      at: root.appendingPathComponent("apps/bots/scripts"),
      withIntermediateDirectories: true
    )
    try Data().write(to: root.appendingPathComponent("apps/bots/scripts/serve.ts"))
    return root
  }

  @Test("the development daemon is found from an unpackaged executable's ancestry")
  func resolvesFromAncestry() throws {
    let root = try tree()
    defer { try? FileManager.default.removeItem(at: root) }
    let executable = root.appendingPathComponent(
      "apps/macos/.build/debug/EagleApp"
    )
    let resolved = BotsDaemonSupervisor.resolveDaemonDirectory(
      explicit: nil,
      executable: executable
    )
    #expect(
      resolved?.standardizedFileURL.path
        == root.appendingPathComponent("apps/bots").standardizedFileURL.path)
  }

  @Test("an explicit directory must actually contain the daemon")
  func explicitDirectory() throws {
    let root = try tree()
    defer { try? FileManager.default.removeItem(at: root) }
    let good = BotsDaemonSupervisor.resolveDaemonDirectory(
      explicit: root.appendingPathComponent("apps/bots").path,
      executable: nil
    )
    #expect(good != nil)
    let bad = BotsDaemonSupervisor.resolveDaemonDirectory(
      explicit: root.appendingPathComponent("nope").path,
      executable: nil
    )
    #expect(bad == nil)
  }

  @Test("an explicit node path is used or refused, never silently replaced")
  func nodeResolution() throws {
    #expect(BotsDaemonSupervisor.resolveNode(environment: ["BOTS_NODE": "/bin/sh"]) == "/bin/sh")
    #expect(BotsDaemonSupervisor.resolveNode(environment: ["BOTS_NODE": "/nope"]) == nil)
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    try FileManager.default.createSymbolicLink(
      at: root.appendingPathComponent("node"), withDestinationURL: URL(fileURLWithPath: "/bin/sh"))
    #expect(BotsDaemonSupervisor.resolveNode(environment: ["PATH": root.path]) != nil)
  }

  @Test("an installed App resolves Bots from its own runtime outside the repository")
  func bundledRuntime() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let app = root.appendingPathComponent("Eagle Device Candidate.app")
    let bots = app.appendingPathComponent("Contents/Resources/DeviceRuntime/bots")
    try FileManager.default.createDirectory(
      at: bots.appendingPathComponent("scripts"), withIntermediateDirectories: true)
    try Data().write(to: bots.appendingPathComponent("scripts/serve.ts"))
    #expect(
      BotsDaemonSupervisor.resolveDaemonDirectory(
        explicit: nil, executable: app.appendingPathComponent("Contents/MacOS/Eagle"))?.path
        == bots.path)
  }

  @Test("a source run tells the daemon where the development token is; a build never does")
  func developmentTokenEnvironment() {
    let source = BotsDaemonSupervisor.daemonEnvironment(
      packaged: false,
      environment: ["HOME": "/Users/me"],
      isolatedConfigHome: nil,
      deviceSocketPath: nil
    )
    #expect(source["BOTS_DEV_AGENT_TOKEN"] == "/Users/me/.config/eagle-dev/token")

    let packaged = BotsDaemonSupervisor.daemonEnvironment(
      packaged: true,
      environment: ["HOME": "/Users/me"],
      isolatedConfigHome: nil,
      deviceSocketPath: nil
    )
    #expect(packaged["BOTS_DEV_AGENT_TOKEN"] == nil, "a packaged build never offers it")
  }

  @Test("the App launches real Bots with bundled Node and its fixed offline device port")
  func launchesBundledDaemon() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let app = root.appendingPathComponent("Eagle Device Candidate.app")
    let runtime = app.appendingPathComponent("Contents/Resources/DeviceRuntime")
    try FileManager.default.createDirectory(at: runtime, withIntermediateDirectories: true)
    let config = Data(
      #"{"version":1,"profile":"device-candidate","baseUrl":"http://127.0.0.1:1","machServiceName":"ai.hexly.eagle.devices.candidate","launchAgentPlist":"ai.hexly.eagle.devices.candidate.plist"}"#
        .utf8)
    try config.write(
      to: runtime.deletingLastPathComponent().appendingPathComponent("DeviceHost.json"))
    let configuration = try DeviceHostConfiguration.load(bundle: app)
    let repository = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .appendingPathComponent("../../../../").standardizedFileURL
    let command = Process()
    command.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    command.arguments = [
      "node", "--input-type=module", "-e",
      """
      import {createServer} from 'node:net';
      import {readFileSync,mkdirSync,realpathSync,rmSync} from 'node:fs';
      import {join} from 'node:path';
      const input=JSON.parse(readFileSync(0,'utf8'));
      const {lockPort}=await import(input.module);
      const listen=port=>new Promise((resolve,reject)=>{const s=createServer();s.once('error',reject);s.listen(port,'127.0.0.1',()=>resolve(s));});
      let root;
      // Select only our fixture path; an existing daemon's lock is never changed.
      for(let n=0;n<32;n++){
        const candidate=join(input.parent,'data-'+n);mkdirSync(candidate);
        try{const lock=await listen(lockPort(realpathSync(candidate)));await new Promise(r=>lock.close(r));root=candidate;break;}
        catch(error){rmSync(candidate);if(error.code!=='EADDRINUSE')throw error;}
      }
      if(!root)throw new Error('fixture lock ports unavailable');
      const server=await listen(0);
      console.log(JSON.stringify({node:process.execPath,port:server.address().port,root}));
      await new Promise(r=>server.close(r));
      """,
    ]
    let pipe = Pipe()
    let input = Pipe()
    command.standardInput = input
    command.standardOutput = pipe
    try command.run()
    try input.fileHandleForWriting.write(
      contentsOf: JSONEncoder().encode([
        "parent": root.path,
        "module": repository.appendingPathComponent("apps/bots/src/server/singleton.ts")
          .absoluteString,
      ]))
    try input.fileHandleForWriting.close()
    let info = try JSONDecoder().decode(
      DeviceJSON.self, from: pipe.fileHandleForReading.readDataToEndOfFile())
    command.waitUntilExit()
    let node = try #require(info["node"]?.string)
    let port = try #require(info["port"]?.number)
    try FileManager.default.createSymbolicLink(
      at: runtime.appendingPathComponent("node"), withDestinationURL: URL(fileURLWithPath: node))
    try FileManager.default.createSymbolicLink(
      at: runtime.appendingPathComponent("bots"),
      withDestinationURL: repository.appendingPathComponent("apps/bots"))
    let defaultsName = "eagle-bundled-bots-" + UUID().uuidString
    let defaults = try #require(UserDefaults(suiteName: defaultsName))
    defer {
      defaults.removePersistentDomain(forName: defaultsName)
      try? FileManager.default.removeItem(at: root)
    }
    let normal = BotsSettings(environment: [:], bundle: app)
    #expect(normal.port == "43118")
    #expect(normal.rootPath.hasSuffix("eagle-bots-device-candidate"))
    #expect(normal.clientDirectory.path.hasPrefix(normal.rootPath))
    let inheritedDaily = BotsSettings(
      environment: ["BOTS_ROOT": "/daily/bots", "BOTS_PORT": "43117"], bundle: app)
    #expect(inheritedDaily.rootPath == normal.rootPath)
    #expect(inheritedDaily.port == normal.port)
    let settings = BotsSettings(
      rootPath: try #require(info["root"]?.string), port: String(Int(port)))
    let daemon = BotsDaemonSupervisor(
      settings: settings, bundle: app,
      environment: [
        "PATH": "", "NODE_OPTIONS": "--invalid-test-option", "BOTS_NODE": "/missing",
        "BOTS_DAEMON_DIR": "/missing", "BOTS_DEVICE_SOCKET": "/wrong",
      ], defaults: defaults)
    await daemon.startIfNeeded()
    if case .running = daemon.status {
    } else {
      Issue.record("bundled daemon did not start: \(daemon.status)")
    }
    do {
      let (data, response) = try await URLSession.shared.data(
        from: settings.baseURL.appendingPathComponent("v1/health"))
      #expect((response as? HTTPURLResponse)?.statusCode == 200)
      let health = try JSONDecoder().decode(DeviceJSON.self, from: data)
      #expect(health["deviceAccess"]?["version"]?.number == 1)
      #expect(!String(decoding: data, as: UTF8.self).contains(configuration.socketPath))
      #expect(
        FileManager.default.fileExists(
          atPath: settings.rootURL.appendingPathComponent("token").path))
    } catch {
      await daemon.stop()
      throw error
    }
    await daemon.stop()
    #expect(daemon.status == .stopped)
  }
}
