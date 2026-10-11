import Foundation
import SwiftData

@Model public final class CachedEntity {
  @Attribute(.unique) public var key: String
  public var namespace: String
  public var kind: String
  public var entityID: String
  public var payload: Data
  public init(namespace: String, kind: String, id: String, payload: Data) {
    key = "\(namespace)|\(kind)|\(id)"
    self.namespace = namespace
    self.kind = kind
    entityID = id
    self.payload = payload
  }
}
@Model public final class LocalCommand {
  @Attribute(.unique) public var id: String
  public var namespace: String
  public var room: String
  public var content: String
  public var addressed: [String]
  public var state: String
  public var messageID: String
  public var failure: String
  public var queueOrder: Int64 = 0
  public var createdAt: Date
  public init(
    namespace: String, room: String, content: String, addressed: [String], state: String = "pending"
  ) {
    id = UUID().uuidString
    self.namespace = namespace
    self.room = room
    self.content = content
    self.addressed = addressed
    self.state = state
    messageID = ""
    failure = ""
    createdAt = Date()
  }
}
@MainActor public final class CacheStore {
  public let container: ModelContainer
  public let context: ModelContext
  public init(inMemory: Bool = false) throws {
    container = try ModelContainer(
      for: CachedEntity.self, LocalCommand.self,
      configurations: ModelConfiguration(isStoredInMemoryOnly: inMemory))
    context = ModelContext(container)
    context.autosaveEnabled = false
  }
  public func entities(namespace: String) throws -> [CachedEntity] {
    try context.fetch(
      FetchDescriptor<CachedEntity>(predicate: #Predicate { $0.namespace == namespace }))
  }
  public func records(namespace: String) throws -> [Record] {
    try entities(namespace: namespace).filter { $0.kind != "cursor" }.map {
      Record(kind: $0.kind, value: try JSONDecoder().decode(JSONValue.self, from: $0.payload))
    }
  }
  public func commands(namespace: String) throws -> [LocalCommand] {
    try context.fetch(
      FetchDescriptor<LocalCommand>(
        predicate: #Predicate { $0.namespace == namespace },
        sortBy: [SortDescriptor(\.queueOrder), SortDescriptor(\.createdAt)]))
  }
  public func cursor(namespace: String) throws -> String {
    let key = "\(namespace)|cursor|head"
    return try context.fetch(
      FetchDescriptor<CachedEntity>(predicate: #Predicate { $0.key == key })
    ).first.flatMap {
      String(data: $0.payload, encoding: .utf8)
    } ?? "0"
  }
  private func upsert(namespace: String, kind: String, id: String, value: JSONValue) throws {
    let key = "\(namespace)|\(kind)|\(id)"
    let bytes = try JSONEncoder().encode(value)
    if let row = try context.fetch(
      FetchDescriptor<CachedEntity>(predicate: #Predicate { $0.key == key })
    ).first {
      row.payload = bytes
    } else {
      context.insert(CachedEntity(namespace: namespace, kind: kind, id: id, payload: bytes))
    }
  }
  private func saveCursor(namespace: String, cursor: String) throws {
    let key = "\(namespace)|cursor|head"
    if let row = try context.fetch(
      FetchDescriptor<CachedEntity>(predicate: #Predicate { $0.key == key })
    ).first {
      row.payload = Data(cursor.utf8)
    } else {
      context.insert(
        CachedEntity(namespace: namespace, kind: "cursor", id: "head", payload: Data(cursor.utf8)))
    }
  }
  public func replace(namespace: String, snapshot: JSONValue) throws {
    do {
      for row in try entities(namespace: namespace) { context.delete(row) }
      let mapping = [
        "worlds": "world", "rooms": "room", "characters": "character", "actors": "actor",
        "lore": "lore", "states": "state", "world_events": "world_event", "messages": "message",
        "runs": "run", "memories": "memory", "memory_settings": "memory_settings",
        "autonomy_settings": "autonomy_settings", "autonomy_policies": "autonomy_policy",
        "mcp_connections": "mcp_connection", "tool_grants": "tool_grant", "tool_calls": "tool_call",
      ]
      for (key, kind) in mapping {
        for value in snapshot[key].array {
          let record = Record(kind: kind, value: value)
          // This namespace was cleared above. Avoid one lookup per record on a full rebuild.
          context.insert(CachedEntity(namespace: namespace, kind: kind, id: record.id,
            payload: try JSONEncoder().encode(value)))
        }
      }
      try saveCursor(namespace: namespace, cursor: snapshot["high_water_cursor"].string)
      try context.save()
    } catch {
      context.rollback()
      throw error
    }
  }
  public func apply(namespace: String, events: [JSONValue], cursor: String) throws {
    do {
      var current = try self.cursor(namespace: namespace)
      for event in events where cursorIsNewer(event["cursor"].string, than: current) {
        let kind = event["kind"].string
        let id = event["entity_id"].string
        if kind.hasSuffix("_deleted") {
          let original = String(kind.dropLast(8))
          for row in try entities(namespace: namespace)
          where (row.kind == original && row.entityID == id)
            || (original == "world"
              && (try? JSONDecoder().decode(JSONValue.self, from: row.payload)["world_id"].string)
                == id)
            || (original == "room"
              && (try? JSONDecoder().decode(JSONValue.self, from: row.payload)["room_id"].string)
                == id)
          { context.delete(row) }
        } else {
          try upsert(namespace: namespace, kind: kind, id: id, value: event["data"])
        }
        current = event["cursor"].string
      }
      if cursorIsNewer(cursor, than: current) { current = cursor }
      try saveCursor(namespace: namespace, cursor: current)
      try context.save()
    } catch {
      context.rollback()
      throw error
    }
  }
  public func draft(namespace: String, room: String, content: String) throws {
    let old = try commands(namespace: namespace).first { $0.room == room && $0.state == "draft" }
    if let old {
      old.content = content
    } else {
      context.insert(
        LocalCommand(
          namespace: namespace, room: room, content: content, addressed: [], state: "draft"))
    }
    try context.save()
  }
  @discardableResult public func enqueue(
    namespace: String, room: String, content: String, addressed: [String]
  ) throws -> LocalCommand {
    let command = LocalCommand(
      namespace: namespace, room: room, content: content, addressed: addressed)
    command.queueOrder = (try commands(namespace: namespace).map(\.queueOrder).max() ?? 0) + 1
    context.insert(command)
    for row in try commands(namespace: namespace) where row.room == room && row.state == "draft" {
      context.delete(row)
    }
    try context.save()
    return command
  }
}
