import Foundation
import Observation

@Observable @MainActor public final class AppModel {
  public private(set) var records: [Record] = []
  public private(set) var pending: [LocalCommand] = []
  public private(set) var providers: [Record] = []
  public private(set) var devices: [Record] = []
  public private(set) var connection: Connection?
  public var status = "未连接"
  public var error: String?
  public private(set) var ready = false
  private let cache: CacheStore
  private var api: APIConnection?
  private var loop: Task<Void, Never>?
  private var generation = UUID()
  private var flushing: Set<UUID> = []
  private var syncing: Set<UUID> = []
  public init(cache: CacheStore) { self.cache = cache }
  public func restore() async {
    guard let url = UserDefaults.standard.string(forKey: "echo2.activeServer") else { return }
    do { if let connection = try KeychainStore.read(url) { try activate(connection) } } catch {
      report(error)
    }
  }
  public func pair(url: String, code: String, device: String, allowLocal: Bool = false) async throws
  {
    let saved = try await APIConnection.pair(
      url: url, code: code, device: device, allowLocal: allowLocal)
    try activate(saved)
  }
  public func switchServer() {
    generation = UUID()
    loop?.cancel()
    loop = nil
    api = nil
    connection = nil
    records = []
    pending = []
    providers = []
    devices = []
    ready = false
    status = "未连接"
    UserDefaults.standard.removeObject(forKey: "echo2.activeServer")
  }
  public func resume(url: String, allowLocal: Bool = false) throws {
    let canonical = try ConnectionPolicy.serverURL(url, allowLocal: allowLocal).absoluteString
    guard let saved = try KeychainStore.read(canonical) else {
      throw APIError(status: 401, code: "pairing_required")
    }
    try activate(saved)
  }
  private func activate(_ saved: Connection) throws {
    // Recheck saved Debug connections when a Release build restores Keychain.
    _ = try ConnectionPolicy.serverURL(saved.url, allowLocal: true)
    switchServer()
    connection = saved
    api = APIConnection(saved)
    UserDefaults.standard.set(saved.url, forKey: "echo2.activeServer")
    try reload()
    status = "离线缓存 · 正在连接"
    let version = generation
    loop = Task { await self.synchronizeLoop(version: version) }
  }
  private func reload() throws {
    guard let connection else { return }
    records = try cache.records(namespace: connection.namespace)
    let commands = try cache.commands(namespace: connection.namespace)
    let received = Set(records.filter { $0.kind == "message" }.map(\.id))
    for command in commands
    where command.state == "accepted" && received.contains(command.messageID) {
      cache.context.delete(command)
    }
    if cache.context.hasChanges { try cache.context.save() }
    pending = try cache.commands(namespace: connection.namespace)
  }
  public func items(_ kind: String) -> [Record] {
    records.filter { $0.kind == kind }.sorted {
      $0.name.localizedStandardCompare($1.name) == .orderedAscending
    }
  }
  public func messages(room: String) -> [Record] {
    items("message").filter { $0["room_id"].string == room }.sorted {
      cursorIsNewer($1["sequence"].string, than: $0["sequence"].string)
    }
  }
  public func draft(room: String) -> String {
    pending.first { $0.room == room && $0.state == "draft" }?.content ?? ""
  }
  public func saveDraft(room: String, content: String) {
    do {
      guard let connection else { return }
      try cache.draft(namespace: connection.namespace, room: room, content: content)
      try reload()
    } catch { report(error) }
  }
  public func send(room: String, content: String, addressed: [String]) async throws {
    guard let connection, !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      return
    }
    try cache.enqueue(
      namespace: connection.namespace, room: room, content: content, addressed: addressed)
    try reload()
    if ready { await flush(version: generation) }
  }
  public func retry(_ command: LocalCommand) async {
    command.state = "pending"
    command.failure = ""
    do {
      try cache.context.save()
      try reload()
      if ready { await flush(version: generation) }
    } catch { report(error) }
  }
  public func discard(_ command: LocalCommand) {
    cache.context.delete(command)
    do {
      try cache.context.save()
      try reload()
    } catch { report(error) }
  }
  private func validate(_ api: APIConnection, saved: Connection) async throws {
    let caps = try await api.capabilities()
    guard caps["server_instance_id"].string == saved.instance,
      caps["data_epoch"].string == saved.epoch,
      caps["owner_id"].string == saved.credentials.owner_id
    else { throw APIError(status: 401, code: "instance_changed_repair_required") }
    guard caps["protocol_version"].int == 1, caps["features"].array.contains(.string("group-runs")),
      caps["features"].array.contains(.string("paged-snapshots"))
    else { throw APIError(status: 400, code: "server_upgrade_required") }
  }
  private func synchronizeLoop(version: UUID) async {
    var backoff = 1
    while !Task.isCancelled && version == generation {
      guard let api, let saved = connection else { return }
      do {
        try await validate(api, saved: saved)
        guard version == generation else { return }
        try await catchUp(api: api, saved: saved, version: version)
        guard version == generation else { return }
        ready = true
        status = "已连接 · 云端同步"
        backoff = 1
        await flush(version: version)
        let cursor = try cache.cursor(namespace: saved.namespace)
        let bytes = try await api.events(cursor: cursor)
        var parser = SSEParser()
        for try await byte in bytes {
          if Task.isCancelled || version != generation { return }
          if let frame = try parser.consume(byte: byte) {
            if frame.data.isEmpty {
              await flush(version: version)
              continue
            }
            guard let data = frame.data.data(using: .utf8) else {
              throw APIError(status: 400, code: "invalid_event")
            }
            let event = try JSONDecoder().decode(JSONValue.self, from: data)
            try cache.apply(namespace: saved.namespace, events: [event], cursor: frame.id)
            try reload()
          }
        }
      } catch {
        guard version == generation && !Task.isCancelled else { return }
        ready = false
        status = "离线 · 缓存可读，发送待重连"
        if APIConnection.apiError(error)?.code == "instance_changed_repair_required" {
          self.error = "服务器身份或恢复版本已改变。旧草稿保留在原实例，请重新配对。"
          status = "需要重新配对"
          return
        }
        if let e = APIConnection.apiError(error), e.status == 401 {
          do { try await api.refresh() } catch {
            self.error = "设备凭证失效或服务器已恢复，请重新配对。"
            status = "需要重新配对"
            return
          }
        } else if let e = APIConnection.apiError(error), e.status == 410 {
          do {
            let snap = try await api.snapshot()
            guard version == generation else { return }
            try cache.replace(namespace: saved.namespace, snapshot: snap)
            try reload()
          } catch { report(error) }
        } else if APIConnection.apiError(error)?.status == 400 {
          report(error)
          return
        }
      }
      try? await Task.sleep(for: .seconds(backoff))
      backoff = min(backoff * 2, 30)
    }
  }
  private func catchUp(api: APIConnection, saved: Connection, version: UUID) async throws {
    if syncing.contains(version) { return }
    syncing.insert(version)
    defer { syncing.remove(version) }
    let namespace = saved.namespace
    if try cache.cursor(namespace: namespace) == "0" {
      let snap = try await api.snapshot()
      guard version == generation else { return }
      try cache.replace(namespace: namespace, snapshot: snap)
    }
    while version == generation {
      let batch = try await api.sync(cursor: cache.cursor(namespace: namespace))
      guard version == generation else { return }
      try cache.apply(
        namespace: namespace, events: batch["items"].array, cursor: batch["next_cursor"].string)
      if !batch["has_more"].bool { break }
    }
    guard version == generation else { return }
    try reload()
  }
  private func flush(version: UUID) async {
    guard !flushing.contains(version), let api, let saved = connection else { return }
    flushing.insert(version)
    defer { flushing.remove(version) }
    do {
      for command in try cache.commands(namespace: saved.namespace) where command.state == "pending"
      {
        guard version == generation else { return }
        do {
          let ack = try await api.send(
            room: command.room, command: command.id, content: command.content,
            addressed: command.addressed)
          command.state = "accepted"
          command.messageID = ack["message_id"].string
          try cache.context.save()
        } catch {
          if let e = APIConnection.apiError(error), (400..<500).contains(e.status),
            e.status != 401 && e.status != 429
          {
            command.state = "failed"
            command.failure = e.localizedDescription
            try cache.context.save()
          } else {
            throw error
          }
        }
      }
      guard version == generation else { return }
      try reload()
      ready = true
      status = "已连接 · 云端同步"
    } catch {
      if version == generation {
        ready = false
        status = "发送保留在本机，等待重连"
        if APIConnection.apiError(error)?.status == 401 { report(error) }
      }
    }
  }
  public func refreshSettings() async throws {
    guard let api else { return }
    let version = generation
    let p = try await api.providers()
    let d = try await api.devices()
    guard version == generation else { return }
    providers = p["items"].array.map { Record(kind: "provider", value: $0) }
    devices = d["items"].array.map { Record(kind: "device", value: $0) }
  }
  public func save(resource: String, id: String?, revision: Int, body: JSONValue) async throws {
    guard let api, let saved = connection else { return }
    let version = generation
    do { try await api.save(resource: resource, id: id, revision: revision, body: body) } catch {
      if APIConnection.apiError(error)?.status == 409 {
        try? await catchUp(api: api, saved: saved, version: version)
      }
      throw error
    }
    try await catchUp(api: api, saved: saved, version: version)
    if resource == "providers" { try await refreshSettings() }
  }
  public func delete(resource: String, record: Record) async throws {
    guard let api, let saved = connection else { return }
    let version = generation
    try await api.delete(resource: resource, id: record.id, revision: record["revision"].int)
    try await catchUp(api: api, saved: saved, version: version)
  }
  public func continuity(action: String, id: String, revision: Int = 1, body: JSONValue = .null)
    async throws -> JSONValue
  {
    guard let api, let saved = connection else {
      throw APIError(status: 401, code: "not_connected")
    }
    let version = generation
    let value = try await api.continuity(action: action, id: id, revision: revision, body: body)
    guard version == generation else { throw APIError(status: 409, code: "connection_changed") }
    if !["status", "revisions", "preview", "original"].contains(action) {
      do { try await catchUp(api: api, saved: saved, version: version) } catch {
        guard APIConnection.apiError(error)?.status == 410 else { throw error }
        let snap = try await api.snapshot()
        guard version == generation else { throw APIError(status: 409, code: "connection_changed") }
        try cache.replace(namespace: saved.namespace, snapshot: snap)
        try reload()
      }
    }
    return value
  }
  public func autonomy(action: String, id: String = "", revision: Int = 1, body: JSONValue = .null)
    async throws -> JSONValue
  {
    guard let api, let saved = connection else {
      throw APIError(status: 401, code: "not_connected")
    }
    let version = generation
    let value = try await api.autonomy(action: action, id: id, revision: revision, body: body)
    guard version == generation else { throw APIError(status: 409, code: "connection_changed") }
    if !["global", "policy", "recaps", "usage", "connections", "grants", "calls"].contains(action) {
      try await catchUp(api: api, saved: saved, version: version)
    }
    return value
  }
  public func operations(action: String, id: String = "", body: JSONValue = .null) async throws
    -> JSONValue
  {
    guard let api, let saved = connection else {
      throw APIError(status: 401, code: "not_connected")
    }
    let version = generation
    try await validate(api, saved: saved)
    let result = try await api.operations(action: action, id: id, body: body)
    guard version == generation else { throw APIError(status: 409, code: "connection_changed") }
    if action == "resolvePush" { try await catchUp(api: api, saved: saved, version: version) }
    return result
  }
  public func bindPush(invitation: String, apnsToken: String, topic: String, environment: String)
    async throws
  {
    guard let saved = connection else { throw APIError(status: 401, code: "not_connected") }
    let challenge = try await operations(action: "beginPush")
    let enrolled = try await APIConnection.relay(
      url: challenge["relay_url"].string, path: "v1/tickets",
      body: .object([
        "invitation": .string(invitation), "binding": challenge["binding"], "topic": .string(topic),
        "environment": .string(environment), "apns_token": .string(apnsToken),
      ]))
    guard connection?.namespace == saved.namespace else {
      throw APIError(status: 409, code: "connection_changed")
    }
    _ = try await operations(action: "enablePush", body: .object(["ticket": enrolled["ticket"]]))
    try KeychainStore.savePush(
      .object([
        "ticket": enrolled["ticket"], "relay_url": challenge["relay_url"],
        "expires_at": enrolled["expires_at"], "apns_token": .string(apnsToken),
      ]), namespace: saved.namespace)
  }
  public func updatePushToken(_ token: String) async throws {
    guard let saved = connection,
      let binding = try KeychainStore.readPush(namespace: saved.namespace),
      !binding["ticket"].string.isEmpty
    else { return }
    if binding["apns_token"].string == token { return }
    _ = try await APIConnection.relay(
      url: binding["relay_url"].string, path: "v1/tickets/token", ticket: binding["ticket"].string,
      body: .object(["apns_token": .string(token)]))
    try KeychainStore.savePush(
      .object([
        "ticket": binding["ticket"], "relay_url": binding["relay_url"],
        "expires_at": binding["expires_at"], "apns_token": .string(token),
      ]), namespace: saved.namespace)
  }
  public func disablePush() async throws {
    guard let saved = connection else { return }
    _ = try await operations(action: "disablePush")
    try KeychainStore.savePush(.null, namespace: saved.namespace)
  }
  public func cancel(id: String) async throws { try await api?.cancel(id: id) }
  public func regenerate(id: String) async throws {
    try await api?.regenerate(id: id, command: UUID().uuidString)
  }
  public func revoke(id: String) async throws {
    try await api?.revoke(id: id)
    try await refreshSettings()
  }
  public func report(_ failure: any Error) {
    error = APIConnection.apiError(failure)?.localizedDescription ?? failure.localizedDescription
  }
}
