import AppKit
import EagleDevices
import Foundation
import Testing

@testable import EagleFeatures

@MainActor private final class WithdrawalGate {
  var stalled = false
}

@Suite("Bots daemon supervisor")
@MainActor
struct BotsDaemonSupervisorTests {
  @Test("one owned composition shares settings, defaults and trusted control across its consumers")
  func ownedComposition() async throws {
    let suite = "eagle-composition-" + UUID().uuidString
    let defaults = try #require(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(suite)
    let control = DeviceSettingsControlStub()
    let composition = BotsComposition(
      settings: BotsSettings(rootPath: root.path, port: "49991"), defaults: defaults,
      control: control, environment: [:])
    #expect(composition.supervisor.rootPath == root.path)
    #expect(composition.settings.clientDirectory.path == root.appendingPathComponent("client").path)
    composition.supervisor.autoStart = false
    #expect(defaults.bool(forKey: "eagle.bots.autoStart") == false)
    control.handler = { method, _ in method == "sync.endpoints.publish" ? .object([:]) : nil }
    await composition.devices.startIfNeeded()
    try await composition.devices.publishSyncEndpoints(
      port: 49992, expectedSelfDigest: "owned-self")
    #expect(control.calls.last?.0 == "sync.endpoints.publish")
    #expect(control.calls.last?.1?["syncPort"] == .number(49992))
    let delegate = EagleApplicationDelegate(composition: composition, reply: {})
    #expect(delegate.applicationShouldTerminate(NSApplication.shared) == .terminateLater)
    #expect(composition.supervisor.autoStart == false)
  }

  @Test("owned endpoint publication revalidates current Registry identity after pairing")
  func publicationAfterPairing() async throws {
    let repository = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .appendingPathComponent("../../../../").standardizedFileURL
    let fixture = Process()
    let output = Pipe()
    let input = Pipe()
    fixture.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    fixture.arguments = ["node", "tests/device-integration/sync-publication.fixture.ts"]
    fixture.currentDirectoryURL = repository
    fixture.standardOutput = output
    fixture.standardInput = input
    try fixture.run()
    defer {
      try? input.fileHandleForWriting.close()
      if fixture.isRunning { fixture.waitUntilExit() }
    }
    let info = try JSONDecoder().decode(
      DeviceJSON.self, from: output.fileHandleForReading.availableData)
    let bridgeText = try #require(info["bridge"]?.string)
    let bridge = try #require(URL(string: bridgeText))
    let pid = Int(try #require(info["pid"]?.number))
    let root = try #require(info["root"]?.string)
    let port = Int(try #require(info["port"]?.number))
    let socket = try #require(info["socket"]?.string)
    func call(_ path: String, body: DeviceJSON? = nil) async throws -> (Int, DeviceJSON) {
      var request = URLRequest(url: bridge.appendingPathComponent(path))
      request.timeoutInterval = 5
      if let body {
        request.httpMethod = "POST"
        request.httpBody = try JSONEncoder().encode(body)
      }
      let (data, response) = try await URLSession.shared.data(for: request)
      return (
        (response as? HTTPURLResponse)?.statusCode ?? 0,
        try JSONDecoder().decode(DeviceJSON.self, from: data)
      )
    }
    let name = "eagle-publication-" + UUID().uuidString
    let defaults = try #require(UserDefaults(suiteName: name))
    defer { defaults.removePersistentDomain(forName: name) }
    defaults.set(pid, forKey: "eagle.bots.daemonPid")
    let supervisor = BotsDaemonSupervisor(
      settings: BotsSettings(rootPath: root, port: String(port)),
      environment: ["BOTS_DEVICE_SOCKET": socket], defaults: defaults,
      publishSync: { port, digest in
        var params: [String: DeviceJSON] = ["syncPort": port.map { .number(Double($0)) } ?? .null]
        if let digest { params["expectedSelfDigest"] = .string(digest) }
        let result = try await call("publish", body: .object(params))
        guard result.0 == 200 else { throw DeviceHostError.unavailable }
      })
    await supervisor.startIfNeeded()
    var before: DeviceJSON = .null
    for _ in 0..<80 {
      before = try await call("state").1
      if (before["publications"]?.number ?? 0) > 0 { break }
      try await Task.sleep(for: .milliseconds(100))
    }
    #expect((before["publications"]?.number ?? 0) > 0)
    #expect(before["groupId"] == .null, "first actual publication precedes a real group")
    #expect(try await call("pair", body: .object([:])).0 == 200)
    var after = before
    for _ in 0..<80 {
      after = try await call("state").1
      if (after["publications"]?.number ?? 0) > (before["publications"]?.number ?? 0) { break }
      try await Task.sleep(for: .milliseconds(100))
    }
    #expect(after["pid"] == before["pid"])
    #expect(after["lastPort"] == before["lastPort"])
    #expect(after["lastDigest"] == before["lastDigest"])
    #expect(after["groupId"] != .null)
    #expect(
      (after["publications"]?.number ?? 0) > (before["publications"]?.number ?? 0),
      "same ready daemon revalidates publication under its new current identity")
    let access = try await call("access")
    #expect(access.0 == 200)
    #expect(access.1["endpoints"]?["candidates"]?.array?.count == 1)
    #expect(try await call("revoke", body: .object([:])).0 == 200)
    #expect(
      try await call("access").0 == 403, "old endpoint metadata never authorizes a revoked peer")
    await supervisor.stop()
  }

  @Test("the public application quit entry defers termination until owned synchronization shutdown")
  func publicQuitEntry() {
    let delegate: any NSApplicationDelegate = EagleApplicationDelegate()
    #expect(delegate.applicationShouldTerminate?(NSApplication.shared) == .terminateLater)
  }

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
    var publications: [(Int?, String?)] = []
    let withdrawalGate = WithdrawalGate()
    var stalled: [CheckedContinuation<Void, Never>] = []
    let daemon = BotsDaemonSupervisor(
      settings: settings, bundle: app,
      environment: [
        "PATH": "", "NODE_OPTIONS": "--invalid-test-option", "BOTS_NODE": "/missing",
        "BOTS_DAEMON_DIR": "/missing", "BOTS_DEVICE_SOCKET": "/wrong",
      ], defaults: defaults,
      publishSync: { port, digest in
        publications.append((port, digest))
        if withdrawalGate.stalled { await withCheckedContinuation { stalled.append($0) } }
      })
    let stoppedStartup = Task { await daemon.startIfNeeded() }
    await Task.yield()
    await daemon.stop()
    await stoppedStartup.value
    #expect(daemon.status == .stopped, "stop invalidates and drains the old startup")
    var coldReplies = 0
    let coldQuit = EagleApplicationDelegate(supervisor: daemon, reply: { coldReplies += 1 })
    let startup = Task { await daemon.startIfNeeded() }
    await Task.yield()
    #expect(coldQuit.applicationShouldTerminate(NSApplication.shared) == .terminateLater)
    await startup.value
    for _ in 0..<100 {
      if coldReplies == 1 { break }
      try await Task.sleep(for: .milliseconds(20))
    }
    #expect(coldReplies == 1)
    #expect(daemon.status == .stopped, "a pending startup cannot leave a child after public quit")
    await daemon.stop()
    await daemon.restart()
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
    for _ in 0..<100 {
      if !publications.isEmpty { break }
      try await Task.sleep(for: .milliseconds(10))
    }
    #expect(publications.first?.0 == nil, "unready listener is explicitly withdrawn")
    var replies = 0
    let delegate = EagleApplicationDelegate(supervisor: daemon, reply: { replies += 1 })
    #expect(delegate.applicationShouldTerminate(NSApplication.shared) == .terminateLater)
    #expect(delegate.applicationShouldTerminate(NSApplication.shared) == .terminateLater)
    for _ in 0..<100 {
      if replies == 1 { break }
      try await Task.sleep(for: .milliseconds(20))
    }
    #expect(replies == 1)
    #expect(daemon.withdrawal == .confirmed)
    #expect(daemon.status == .stopped)
    #expect(delegate.applicationShouldTerminate(NSApplication.shared) == .terminateNow)
    delegate.applicationWillTerminate(Notification(name: NSApplication.willTerminateNotification))
    #expect(replies == 1)

    await daemon.restart()
    if case .running = daemon.status {} else { Issue.record("second owned daemon did not start") }
    withdrawalGate.stalled = true
    let unknown = EagleApplicationDelegate(supervisor: daemon, reply: { replies += 1 })
    let started = ContinuousClock.now
    #expect(unknown.applicationShouldTerminate(NSApplication.shared) == .terminateLater)
    #expect(unknown.applicationShouldTerminate(NSApplication.shared) == .terminateLater)
    for _ in 0..<250 {
      if replies == 2 { break }
      try await Task.sleep(for: .milliseconds(20))
    }
    #expect(replies == 2, "non-cooperative publisher cannot prevent the quit reply")
    #expect(started.duration(to: .now) < .seconds(5))
    #expect(daemon.withdrawal == .unknown)
    #expect(daemon.status == .stopped)
    withdrawalGate.stalled = false
    await daemon.restart()
    guard case .running(_, let newPid, false) = daemon.status else {
      Issue.record("new owned generation did not start")
      return
    }
    for continuation in stalled { continuation.resume() }
    stalled.removeAll()
    await Task.yield()
    #expect(daemon.withdrawal == .unknown, "late response cannot relabel a timed-out withdrawal")
    #expect(replies == 2)
    guard case .running(_, let currentPid, false) = daemon.status else {
      Issue.record("old callback invalidated the new daemon")
      return
    }
    #expect(currentPid == newPid)
    let beforeExit = publications.count
    kill(pid_t(newPid), SIGKILL)
    for _ in 0..<100 {
      if publications.count > beforeExit, daemon.withdrawal == .confirmed { break }
      try await Task.sleep(for: .milliseconds(20))
    }
    #expect(publications.count > beforeExit, "unexpected owned exit dispatches withdrawal")
    #expect(publications.last?.0 == nil)
    #expect(daemon.withdrawal == .confirmed)
    #expect(daemon.status == .stopped)
  }

  @Test(
    "owned status binding and recorded-process quit remain strict when health stops answering",
    arguments: ["matching", "wrongPid", "wrongBinding", "wrongInstance", "external"])
  func adoptedQuitWithoutHealth(mode: String) async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let socket = root.appendingPathComponent("device.sock").path
    let encodedSocket = String(decoding: try JSONEncoder().encode(socket), as: UTF8.self)
    let script = root.appendingPathComponent("owned.mjs")
    try Data(
      """
      import {createServer} from 'node:http';import {createHash} from 'node:crypto';
      const binding=createHash('sha256').update(\(encodedSocket)).digest('hex');let health=true;const mode='\(mode)';
      process.stdin.on('data',()=>{health=false;console.log('health-off');});
      const server=createServer((req,res)=>{
        if(req.url==='/v1/health')res.writeHead(health?200:503).end(JSON.stringify({version:'test',pid:process.pid,instance:'i_owned',deviceAccess:{version:1,binding}}));
        else res.writeHead(200).end(JSON.stringify({version:1,pid:mode==='wrongPid'?process.pid+1:process.pid,instance:mode==='wrongInstance'?'i_old':'i_owned',binding:mode==='wrongBinding'?'wrong':binding,ready:true,actualPort:43222,selfDigest:'a'.repeat(64)}));
      });server.listen(0,'127.0.0.1',()=>console.log(server.address().port));
      """.utf8
    ).write(to: script)
    try Data("owned-token-012345678901234567890123".utf8).write(
      to: root.appendingPathComponent("token"))
    let process = Process()
    let output = Pipe()
    let input = Pipe()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["node", script.path]
    process.standardOutput = output
    process.standardInput = input
    try process.run()
    let name = "eagle-adopted-" + UUID().uuidString
    let defaults = try #require(UserDefaults(suiteName: name))
    defer {
      if process.isRunning {
        process.terminate()
        process.waitUntilExit()
      }
      defaults.removePersistentDomain(forName: name)
      try? FileManager.default.removeItem(at: root)
    }
    let portText = String(decoding: output.fileHandleForReading.availableData, as: UTF8.self)
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let port = try #require(Int(portText))
    if mode != "external" {
      defaults.set(Int(process.processIdentifier), forKey: "eagle.bots.daemonPid")
    }
    var withdrawals = 0
    var published: [Int] = []
    let supervisor = BotsDaemonSupervisor(
      settings: BotsSettings(rootPath: root.path, port: String(port)),
      environment: ["BOTS_DEVICE_SOCKET": socket], defaults: defaults,
      publishSync: { port, _ in
        if let port { published.append(port) } else { withdrawals += 1 }
      })
    await supervisor.startIfNeeded()
    guard case .running(_, let pid, let external) = supervisor.status else {
      Issue.record("recorded daemon health was not accepted")
      return
    }
    #expect(external == (mode == "external"))
    #expect(pid == Int(process.processIdentifier))
    for _ in 0..<100 {
      if !published.isEmpty || withdrawals > 0 { break }
      try await Task.sleep(for: .milliseconds(10))
    }
    #expect(
      published == (mode == "matching" ? [43222] : []),
      "only current owned pid/instance/binding can publish a ready port")
    try input.fileHandleForWriting.write(contentsOf: Data("health-off\n".utf8))
    #expect(
      String(decoding: output.fileHandleForReading.availableData, as: UTF8.self).contains(
        "health-off"))
    var replied = false
    let delegate = EagleApplicationDelegate(supervisor: supervisor, reply: { replied = true })
    #expect(delegate.applicationShouldTerminate(NSApplication.shared) == .terminateLater)
    for _ in 0..<200 {
      if replied { break }
      try await Task.sleep(for: .milliseconds(20))
    }
    #expect(replied)
    if mode == "external" {
      #expect(withdrawals == 0)
      #expect(supervisor.withdrawal == .notOwned)
      #expect(process.isRunning, "a healthy external process is never killed by App quit")
    } else {
      #expect(withdrawals > 0)
      #expect(supervisor.withdrawal == .confirmed)
      #expect(!process.isRunning, "verified process start identity survives unavailable health")
    }
  }

}
