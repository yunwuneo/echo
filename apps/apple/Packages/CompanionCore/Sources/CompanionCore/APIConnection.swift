import Foundation
import HTTPTypes
import OpenAPIRuntime
import OpenAPIURLSession
import Security

final class NoRedirect: NSObject, URLSessionTaskDelegate, Sendable {
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping @Sendable (URLRequest?) -> Void
  ) { completionHandler(nil) }
}
struct AuthMiddleware: ClientMiddleware {
  let token: String?
  func intercept(
    _ request: HTTPRequest, body: HTTPBody?, baseURL: URL, operationID: String,
    next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
  ) async throws -> (HTTPResponse, HTTPBody?) {
    var request = request
    if let token { request.headerFields[.authorization] = "Bearer \(token)" }
    let (response, body) = try await next(request, body, baseURL)
    if response.status.code >= 300 {
      let bytes = try await body.mapAsync { try await Data(collecting: $0, upTo: 65536) }
      let value = bytes.flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) }
      throw APIError(
        status: response.status.code, code: value?["error"]["code"].string ?? "http_error")
    }
    return (response, body)
  }
}
extension Optional where Wrapped: Sendable {
  func mapAsync<T: Sendable>(_ transform: (Wrapped) async throws -> T) async rethrows -> T? {
    if let value = self { try await transform(value) } else { nil }
  }
}
public enum KeychainStore {
  public static func savePush(_ value: JSONValue, namespace: String) throws {
    try write(try JSONEncoder().encode(value), account: "push:" + namespace)
  }
  public static func readPush(namespace: String) throws -> JSONValue? {
    var result: CFTypeRef?
    let status = SecItemCopyMatching(
      [
        kSecClass: kSecClassGenericPassword, kSecAttrService: "dev.echo2.session",
        kSecAttrAccount: "push:" + namespace, kSecReturnData: true,
        kSecMatchLimit: kSecMatchLimitOne,
      ] as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data else {
      throw APIError(status: 500, code: "keychain_read")
    }
    return try JSONDecoder().decode(JSONValue.self, from: data)
  }
  public static func save(_ connection: Connection) throws {
    try write(try JSONEncoder().encode(connection), account: connection.url)
  }
  public static func read(_ url: String) throws -> Connection? {
    var result: CFTypeRef?
    let status = SecItemCopyMatching(
      [
        kSecClass: kSecClassGenericPassword, kSecAttrService: "dev.echo2.session",
        kSecAttrAccount: url, kSecReturnData: true, kSecMatchLimit: kSecMatchLimitOne,
      ] as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data else {
      throw APIError(status: 500, code: "keychain_read")
    }
    return try JSONDecoder().decode(Connection.self, from: data)
  }
  static func write(_ data: Data, account: String) throws {
    let query =
      [
        kSecClass: kSecClassGenericPassword, kSecAttrService: "dev.echo2.session",
        kSecAttrAccount: account,
      ] as [CFString: Any]
    let update = SecItemUpdate(query as CFDictionary, [kSecValueData: data] as CFDictionary)
    if update == errSecItemNotFound {
      var item = query
      item[kSecValueData] = data
      item[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else {
        throw APIError(status: 500, code: "keychain_write")
      }
    } else if update != errSecSuccess {
      throw APIError(status: 500, code: "keychain_write")
    }
  }
}

public actor APIConnection {
  public private(set) var connection: Connection
  private let session: URLSession
  private var refreshTask: Task<Credentials, Error>?
  public init(_ connection: Connection) {
    self.connection = connection
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 30
    configuration.timeoutIntervalForResource = 3600
    session = URLSession(configuration: configuration, delegate: NoRedirect(), delegateQueue: nil)
  }
  private func client(auth: Bool = true) -> Client {
    Client(
      serverURL: URL(string: connection.url)!,
      transport: URLSessionTransport(configuration: .init(session: session)),
      middlewares: [AuthMiddleware(token: auth ? connection.credentials.access_token : nil)])
  }
  private func call<T: Sendable>(_ block: @Sendable (Client) async throws -> T) async throws -> T {
    let usedToken = connection.credentials.access_token
    do { return try await block(client()) } catch {
      if Self.apiError(error)?.status != 401 { throw error }
    }
    if connection.credentials.access_token == usedToken { try await refresh() }
    return try await block(client())
  }
  public static func apiError(_ error: any Error) -> APIError? {
    if let e = error as? APIError { return e }
    if let e = error as? ClientError { return apiError(e.underlyingError) }
    return nil
  }
  public func refresh() async throws {
    if let refreshTask {
      connection.credentials = try await refreshTask.value
      return
    }
    let client = client(auth: false)
    let token = connection.credentials.refresh_token
    let task = Task {
      try await converted(
        client.refreshSession(body: .json(.init(refresh_token: token))).ok.body.json,
        to: Credentials.self)
    }
    refreshTask = task
    defer { refreshTask = nil }
    connection.credentials = try await task.value
    try KeychainStore.save(connection)
  }
  public func capabilities() async throws -> JSONValue {
    try await converted(client(auth: false).capabilities().ok.body.json)
  }
  public func snapshot() async throws -> JSONValue {
    let head: JSONValue = try await call {
      try await converted($0.beginSnapshot().created.body.json)
    }
    var data = head.object
    data.removeValue(forKey: "snapshot_id")
    data.removeValue(forKey: "expires_in")
    let mapping = [
      "world": "worlds", "room": "rooms", "character": "characters", "actor": "actors",
      "lore": "lore", "state": "states", "world_event": "world_events", "message": "messages",
      "run": "runs", "memory": "memories", "memory_settings": "memory_settings",
      "autonomy_settings": "autonomy_settings", "autonomy_policy": "autonomy_policies",
      "mcp_connection": "mcp_connections", "tool_grant": "tool_grants", "tool_call": "tool_calls",
      "asset": "assets", "model_route": "model_routes",
      "queued_input": "queued_inputs",
    ]
    for key in mapping.values { data[key] = .array([]) }
    var cursor = "0"
    while true {
      let after = cursor
      let page: JSONValue = try await call {
        try await converted(
          $0.snapshotPage(
            path: .init(id: head["snapshot_id"].string), query: .init(after: after, limit: 500)
          ).ok.body.json)
      }
      for item in page["items"].array {
        guard let key = mapping[item["kind"].string] else { continue }
        var rows = data[key]?.array ?? []
        rows.append(item["data"])
        data[key] = .array(rows)
      }
      if !page["has_more"].bool { break }
      let next = page["next_cursor"].string
      guard cursorIsNewer(next, than: cursor) else {
        throw APIError(status: 400, code: "invalid_snapshot_page")
      }
      cursor = next
    }
    return .object(data)
  }
  public func sync(cursor: String) async throws -> JSONValue {
    try await call {
      try await converted($0.sync(query: .init(cursor: cursor, limit: 100)).ok.body.json)
    }
  }
  public func providers() async throws -> JSONValue {
    try await call { try await converted($0.listProviders().ok.body.json) }
  }
  public func devices() async throws -> JSONValue {
    try await call { try await converted($0.listDevices().ok.body.json) }
  }
  public func revoke(id: String) async throws {
    _ = try await call { try await $0.revokeDevice(path: .init(id: id)) }
  }
  public func send(room: String, command: String, content: String, addressed: [String]) async throws
    -> JSONValue
  {
    try await call {
      try await converted(
        $0.sendMessage(
          path: .init(id: room),
          body: .json(
            .init(client_command_id: command, content: content, addressed_actor_ids: addressed))
        ).accepted.body.json)
    }
  }
  public func cancel(id: String) async throws {
    _ = try await call { try await $0.cancelRun(path: .init(id: id)) }
  }
  public func regenerate(id: String, command: String) async throws {
    _ = try await call {
      try await $0.regenerateRun(
        path: .init(id: id), body: .json(.init(client_command_id: command))
      ).accepted
    }
  }
  public func save(resource: String, id: String?, revision: Int, body: JSONValue) async throws {
    try await call { client in
      switch (resource, id) {
      case ("worlds", nil):
        _ = try await client.createworlds(body: .json(try converted(body))).created
      case ("worlds", let id?):
        _ = try await client.updateworlds(
          path: .init(id: id), headers: .init(if_hyphen_match: String(revision)),
          body: .json(try converted(body))
        ).ok
      case ("characters", nil):
        _ = try await client.createcharacters(body: .json(try converted(body))).created
      case ("characters", let id?):
        _ = try await client.updatecharacters(
          path: .init(id: id), headers: .init(if_hyphen_match: String(revision)),
          body: .json(try converted(body))
        ).ok
      case ("actors", nil):
        _ = try await client.createactors(body: .json(try converted(body))).created
      case ("actors", let id?):
        _ = try await client.updateactors(
          path: .init(id: id), headers: .init(if_hyphen_match: String(revision)),
          body: .json(try converted(body))
        ).ok
      case ("rooms", nil):
        _ = try await client.createrooms(body: .json(try converted(body))).created
      case ("rooms", let id?):
        _ = try await client.updaterooms(
          path: .init(id: id), headers: .init(if_hyphen_match: String(revision)),
          body: .json(try converted(body))
        ).ok
      case ("lore", nil): _ = try await client.createlore(body: .json(try converted(body))).created
      case ("lore", let id?):
        _ = try await client.updatelore(
          path: .init(id: id), headers: .init(if_hyphen_match: String(revision)),
          body: .json(try converted(body))
        ).ok
      case ("providers", nil):
        _ = try await client.createProvider(body: .json(try converted(body))).created
      case ("providers", let id?):
        _ = try await client.updateProvider(
          path: .init(id: id),
          headers: .init(if_hyphen_match: String(revision)), body: .json(try converted(body))
        ).ok
      case ("state", let id?):
        _ = try await client.correctWorldState(
          path: .init(id: id), headers: .init(if_hyphen_match: String(revision)),
          body: .json(try converted(body))
        ).ok
      default: throw APIError(status: 400, code: "unsupported_edit")
      }
    }
  }
  public func delete(resource: String, id: String, revision: Int) async throws {
    try await call { client in
      switch resource {
      case "worlds":
        _ = try await client.deleteworlds(
          path: .init(id: id), headers: .init(if_hyphen_match: String(revision)))
      case "characters":
        _ = try await client.deletecharacters(
          path: .init(id: id), headers: .init(if_hyphen_match: String(revision)))
      case "actors":
        _ = try await client.deleteactors(
          path: .init(id: id), headers: .init(if_hyphen_match: String(revision)))
      case "rooms":
        _ = try await client.deleterooms(
          path: .init(id: id), headers: .init(if_hyphen_match: String(revision)))
      case "lore":
        _ = try await client.deletelore(
          path: .init(id: id), headers: .init(if_hyphen_match: String(revision)))
      default: throw APIError(status: 400, code: "unsupported_delete")
      }
    }
  }
  public func continuity(action: String, id: String, revision: Int = 1, body: JSONValue = .null)
    async throws -> JSONValue
  {
    try await call { client in
      switch action {
      case "status":
        return try await converted(client.memoryStatus(path: .init(id: id)).ok.body.json)
      case "revisions":
        return try await converted(client.memoryRevisions(path: .init(id: id)).ok.body.json)
      case "settings":
        return try await converted(
          client.saveMemorySettings(
            path: .init(id: id), headers: .init(if_hyphen_match: String(revision)),
            body: .json(try converted(body))
          ).ok.body.json)
      case "update":
        return try await converted(
          client.updateMemory(
            path: .init(id: id), headers: .init(if_hyphen_match: String(revision)),
            body: .json(try converted(body))
          ).ok.body.json)
      case "forget":
        _ = try await client.deleteMemory(
          path: .init(id: id), headers: .init(if_hyphen_match: String(revision)))
        return .null
      case "erase":
        _ = try await client.deleteMessage(path: .init(id: id))
        return .null
      case "retry":
        _ = try await client.retryMemory(path: .init(id: id))
        return .null
      case "preview":
        return try await converted(
          client.previewImport(path: .init(id: id), body: .json(try converted(body))).ok.body.json)
      case "commit":
        return try await converted(
          client.commitImport(path: .init(id: id), body: .json(try converted(body))).ok.body.json)
      case "original":
        return try await converted(client.exportImport(path: .init(id: id)).ok.body.json)
      default: throw APIError(status: 400, code: "unsupported_action")
      }
    }
  }
  public func autonomy(action: String, id: String = "", revision: Int = 1, body: JSONValue = .null)
    async throws -> JSONValue
  {
    try await call { client in
      switch action {
      case "global": return try await converted(client.getAutonomySettings().ok.body.json)
      case "saveGlobal":
        return try await converted(
          client.saveAutonomySettings(
            headers: .init(if_hyphen_match: String(revision)), body: .json(try converted(body))
          ).ok.body.json)
      case "policy":
        return try await converted(client.getAutonomyPolicy(path: .init(id: id)).ok.body.json)
      case "savePolicy":
        return try await converted(
          client.saveAutonomyPolicy(
            path: .init(id: id), headers: .init(if_hyphen_match: String(revision)),
            body: .json(try converted(body))
          ).ok.body.json)
      case "recaps":
        return try await converted(
          client.getRecaps(path: .init(id: id), query: .init(after: body["after"].int)).ok.body.json
        )
      case "readRecaps":
        _ = try await client.readRecaps(path: .init(id: id), body: .json(.init(revision: revision)))
        return .null
      case "usage": return try await converted(client.getBackgroundUsage().ok.body.json)
      case "connections": return try await converted(client.listMcpConnections().ok.body.json)
      case "createConnection":
        return try await converted(
          client.createMcpConnection(body: .json(try converted(body))).created.body.json)
      case "updateConnection":
        return try await converted(
          client.updateMcpConnection(
            path: .init(id: id), headers: .init(if_hyphen_match: String(revision)),
            body: .json(try converted(body))
          ).ok.body.json)
      case "discover":
        return try await converted(client.discoverMcpTools(path: .init(id: id)).ok.body.json)
      case "grants": return try await converted(client.listToolGrants().ok.body.json)
      case "createGrant":
        return try await converted(
          client.createToolGrant(body: .json(try converted(body))).created.body.json)
      case "updateGrant":
        return try await converted(
          client.updateToolGrant(
            path: .init(id: id), headers: .init(if_hyphen_match: String(revision)),
            body: .json(try converted(body))
          ).ok.body.json)
      case "revokeGrant":
        _ = try await client.revokeToolGrant(path: .init(id: id))
        return .null
      case "calls": return try await converted(client.listToolCalls().ok.body.json)
      case "decide":
        return try await converted(
          client.decideTool(path: .init(id: id), body: .json(try converted(body))).ok.body.json)
      default: throw APIError(status: 400, code: "unsupported_action")
      }
    }
  }
  public func operations(action: String, id: String = "", body: JSONValue = .null) async throws
    -> JSONValue
  {
    try await call { client in
      switch action {
      case "createAsset":
        return try await converted(
          client.createAsset(body: .json(try converted(body))).created.body.json)
      case "sendAttached":
        return try await converted(
          client.sendMessage(path: .init(id: id), body: .json(try converted(body))).accepted.body
            .json)
      case "milestone":
        return try await converted(client.milestone(body: .json(try converted(body))).ok.body.json)
      case "notifications": return try await converted(client.notificationStatus().ok.body.json)
      case "beginPush": return try await converted(client.beginPushBinding().ok.body.json)
      case "enablePush":
        return try await converted(client.enablePush(body: .json(try converted(body))).ok.body.json)
      case "disablePush":
        _ = try await client.disablePush()
        return .null
      case "resolvePush":
        return try await converted(client.resolvePush(path: .init(id: id)).ok.body.json)
      case "export": return try await converted(client.exportData().ok.body.json)
      case "diagnostics": return try await converted(client.diagnostics().ok.body.json)
      case "modelRoutes": return try await converted(client.listModelRoutes().ok.body.json)
      case "saveModelRoute":
        return try await converted(
          client.saveModelRoute(body: .json(try converted(body))).ok.body.json)
      case "messageVersions":
        return try await converted(client.messageVersions(path: .init(id: id)).ok.body.json)
      case "editMessage":
        return try await converted(
          client.editMessage(path: .init(id: id), body: .json(try converted(body))).ok.body.json)
      case "exportConversation":
        return try await converted(client.exportConversation(path: .init(id: id)).ok.body.json)
      case "queuedInputs":
        return try await converted(client.queuedInputs(path: .init(id: id)).ok.body.json)
      case "branchConversation":
        return try await converted(
          client.branchConversation(path: .init(id: id), body: .json(try converted(body))).ok.body
            .json)
      case "queueInput":
        return try await converted(
          client.queueInput(path: .init(id: id), body: .json(try converted(body))).ok.body.json)
      case "updateQueuedInput":
        return try await converted(
          client.updateQueuedInput(path: .init(id: id), body: .json(try converted(body))).ok.body
            .json)
      case "startQueuedTurn":
        return try await converted(
          client.startQueuedTurn(path: .init(id: id), body: .json(try converted(body))).ok.body.json
        )
      default: throw APIError(status: 400, code: "unsupported_action")
      }
    }
  }
  public static func relay(url: String, path: String, ticket: String? = nil, body: JSONValue)
    async throws -> JSONValue
  {
    let base = try ConnectionPolicy.serverURL(url, allowLocal: true)
    let transport = URLSession(
      configuration: .ephemeral, delegate: NoRedirect(), delegateQueue: nil)
    defer { transport.invalidateAndCancel() }
    var request = URLRequest(url: base.appendingPathComponent(path))
    request.httpMethod = "POST"
    request.timeoutInterval = 15
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    if let ticket { request.setValue("Bearer \(ticket)", forHTTPHeaderField: "Authorization") }
    request.httpBody = try JSONEncoder().encode(body)
    let (bytes, response) = try await transport.bytes(for: request)
    guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
      throw APIError(
        status: (response as? HTTPURLResponse)?.statusCode ?? 500, code: "relay_rejected")
    }
    var data = Data()
    for try await byte in bytes {
      data.append(byte)
      if data.count > 16384 { throw APIError(status: 413, code: "relay_response_limit") }
    }
    return try JSONDecoder().decode(JSONValue.self, from: data)
  }
  public func events(cursor: String) async throws -> URLSession.AsyncBytes {
    var parts = URLComponents(
      url: URL(string: connection.url)!.appendingPathComponent("v1/events"),
      resolvingAgainstBaseURL: false)!
    parts.queryItems = [.init(name: "cursor", value: cursor)]
    var request = URLRequest(url: parts.url!)
    request.setValue(
      "Bearer \(connection.credentials.access_token)", forHTTPHeaderField: "Authorization")
    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
    let (bytes, response) = try await session.bytes(for: request)
    guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
      throw APIError(
        status: (response as? HTTPURLResponse)?.statusCode ?? 500, code: "event_stream")
    }
    return bytes
  }
  public static func pair(url: String, code: String, device: String, allowLocal: Bool = false)
    async throws -> Connection
  {
    let canonical = try ConnectionPolicy.serverURL(url, allowLocal: allowLocal).absoluteString
    let empty = Credentials(access_token: "", refresh_token: "", device_id: "", owner_id: "")
    let api = APIConnection(Connection(url: canonical, instance: "", epoch: "", credentials: empty))
    let caps = try await api.capabilities()
    guard caps["protocol_version"].int == ConnectionPolicy.version,
      caps["features"].array.contains(.string("group-runs")),
      caps["features"].array.contains(.string("paged-snapshots"))
    else { throw APIError(status: 400, code: "server_upgrade_required") }
    let credentials = try await api.pairCredentials(code: code, device: device)
    let connection = Connection(
      url: canonical, instance: caps["server_instance_id"].string, epoch: caps["data_epoch"].string,
      credentials: credentials)
    try KeychainStore.save(connection)
    return connection
  }
  private func pairCredentials(code: String, device: String) async throws -> Credentials {
    try await converted(
      client(auth: false).pair(body: .json(.init(code: code, device_name: device))).created.body
        .json)
  }
}
