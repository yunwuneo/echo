import CompanionCore
import Foundation

#if canImport(WidgetKit)
  import WidgetKit
#endif
struct SystemInboxItem: Codable, Sendable {
  var id = UUID().uuidString
  var namespace: String
  var actor: String
  var room: String
  var content: String
  var image: Data?
  var mime: String?
  var send = false
  var openOnly = false
}
enum SystemInbox {
  static var group: String {
    Bundle.main.object(forInfoDictionaryKey: "EchoAppGroup") as? String
      ?? "group.dev.echo2.companion"
  }
  static func directory() throws -> URL {
    guard let base = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
    else { throw APIError(status: 409, code: "app_group_unavailable") }
    let directory = base.appendingPathComponent("Inbox", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory
  }
  static func store(_ item: SystemInboxItem) throws {
    guard item.content.utf8.count <= 16000, (item.image?.count ?? 0) <= 1_048_576 else {
      throw APIError(status: 413, code: "invalid_asset")
    }
    let data = try JSONEncoder().encode(item)
    #if os(iOS)
      try data.write(
        to: try directory().appendingPathComponent(item.id + ".json"),
        options: [.atomic, .completeFileProtection])
    #else
      try data.write(
        to: try directory().appendingPathComponent(item.id + ".json"), options: .atomic)
    #endif
  }
  static func targets() -> JSONValue {
    guard
      let path = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)?
        .appendingPathComponent("targets.json"), let data = try? Data(contentsOf: path),
      let value = try? JSONDecoder().decode(JSONValue.self, from: data)
    else { return .null }
    return value
  }
  #if !ECHO_EXTENSION
    @MainActor static func publishTargets(_ model: AppModel) {
      guard let connection = model.connection,
        let base = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
      else { return }
      let targets = model.items("room").filter {
        $0["kind"].string == "direct" && $0["actor_ids"].array.count == 1
      }.map { r in
        JSONValue.object([
          "room": .string(r.id), "actor": r["actor_ids"].array[0], "name": .string(r.name),
        ])
      }
      let value: JSONValue = .object([
        "namespace": .string(connection.namespace), "targets": .array(targets),
      ])
      if let data = try? JSONEncoder().encode(value) {
        try? data.write(to: base.appendingPathComponent("targets.json"), options: .atomic)
      }
      guard model.ready else { return }
      let running = model.items("run").filter {
        ["queued", "running", "awaiting_approval", "remote_pending"].contains($0["state"].string)
      }
      let widget: JSONValue = .object([
        "updated": .number(Date().timeIntervalSince1970), "count": .number(Double(running.count)),
        "status": .string(running.first?["state"].string ?? "idle"),
      ])
      if let data = try? JSONEncoder().encode(widget) {
        try? data.write(to: base.appendingPathComponent("status.json"), options: .atomic)
      }
      #if canImport(WidgetKit)
        WidgetCenter.shared.reloadTimelines(ofKind: "EchoTaskStatus")
      #endif
    }
    @MainActor static func consume(_ model: AppModel) async throws -> String? {
      guard let connection = model.connection else { return nil }
      let base = try directory()
      var open: String?
      let paths = try FileManager.default.contentsOfDirectory(
        at: base, includingPropertiesForKeys: [.fileSizeKey]
      ).filter { $0.pathExtension == "json" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
      for path in paths.prefix(50) {
        guard (try path.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) <= 1_500_000 else {
          continue
        }
        let item = try JSONDecoder().decode(SystemInboxItem.self, from: Data(contentsOf: path))
        guard item.namespace == connection.namespace else { continue }
        guard
          let room = model.items("room").first(where: {
            $0.id == item.room && $0["actor_ids"].array.contains(.string(item.actor))
          })
        else { continue }
        if item.openOnly {
          open = room.id
          try FileManager.default.removeItem(at: path)
          continue
        }
        var assets: [JSONValue] = []
        if let bytes = item.image {
          let asset = try await model.operations(
            action: "createAsset",
            body: .object([
              "operation_id": .string(item.id), "world_id": room["world_id"],
              "actor_id": .string(item.actor), "mime": .string(item.mime ?? "image/png"),
              "content_base64": .string(bytes.base64EncodedString()),
            ]))
          assets = [asset["id"]]
        }
        guard model.connection?.namespace == connection.namespace else {
          throw APIError(status: 409, code: "connection_changed")
        }
        let received = try await model.operations(
          action: "milestone",
          body: .object([
            "action": .string("feature"), "command": .string("receiveShareDraft"),
            "operation_id": .string(item.id), "expected_revision": .number(0),
            "payload": .object([
              "actor_id": .string(item.actor), "room_id": .string(item.room),
              "content": .string(item.content), "asset_ids": .array(assets),
            ]),
          ]))
        guard model.connection?.namespace == connection.namespace else {
          throw APIError(status: 409, code: "connection_changed")
        }
        if item.send {
          _ = try await model.operations(
            action: "milestone",
            body: .object([
              "action": .string("feature"), "command": .string("sendShareDraft"),
              "operation_id": .string(item.id), "expected_revision": .number(0),
              "payload": .object(["id": received["id"]]),
            ]))
        }
        guard model.connection?.namespace == connection.namespace else {
          throw APIError(status: 409, code: "connection_changed")
        }
        open = item.room
        try FileManager.default.removeItem(at: path)
      }
      return open
    }
  #endif
}
