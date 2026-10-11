import Foundation
import Testing

@testable import CompanionCore

@Test func parsesDurableSSEAndIgnoresHeartbeat() throws {
  var parser = SSEParser()
  #expect(try parser.consume(": heartbeat") == nil)
  #expect(try parser.consume("") == nil)
  #expect(try parser.consume("id: 9007199254740993") == nil)
  #expect(try parser.consume("data: {\"kind\":\"message\"}") == nil)
  let parsed = try parser.consume("")
  let frame = try #require(parsed)
  #expect(frame.id == "9007199254740993")
  #expect(frame.data == "{\"kind\":\"message\"}")
  #expect(cursorIsNewer("9007199254740993", than: "9007199254740992"))
  #expect(cursorIsNewer("10", than: "9"))
}
@MainActor @Test func atomicCacheReplayAndSnapshotPreserveDrafts() throws {
  let store = try CacheStore(inMemory: true)
  let namespace = "server|instance|epoch|owner"
  let initial: JSONValue = .object(["high_water_cursor": .string("1"), "messages": .array([])])
  try store.replace(namespace: namespace, snapshot: initial)
  try store.draft(namespace: namespace, room: "room", content: "离线草稿")
  let command = try store.enqueue(
    namespace: namespace, room: "room", content: "待发送", addressed: ["actor"])
  try store.draft(namespace: namespace, room: "room", content: "第二份草稿")
  let event: JSONValue = .object([
    "cursor": .string("2"), "kind": .string("message"), "entity_id": .string("message"),
    "data": .object([
      "id": .string("message"), "room_id": .string("room"), "content": .string("权威回复"),
    ]),
  ])
  try store.apply(namespace: namespace, events: [event, event], cursor: "2")
  #expect(try store.records(namespace: namespace).count == 1)
  #expect(try store.cursor(namespace: namespace) == "2")
  let replacement: JSONValue = .object([
    "high_water_cursor": .string("8"), "messages": .array([event["data"]]),
  ])
  try store.replace(namespace: namespace, snapshot: replacement)
  #expect(
    try store.commands(namespace: namespace).contains {
      $0.id == command.id && $0.state == "pending"
    })
  #expect(
    try store.commands(namespace: namespace).contains {
      $0.state == "draft" && $0.content == "第二份草稿"
    })
  #expect(try store.cursor(namespace: namespace) == "8")
}
@MainActor @Test func namespaceAndTombstonesPreventCrossServerLeak() throws {
  let store = try CacheStore(inMemory: true)
  try store.draft(namespace: "server-a|epoch1", room: "room", content: "A 的秘密")
  #expect(try store.commands(namespace: "server-b|epoch1").isEmpty)
  #expect(try store.commands(namespace: "server-a|epoch2").isEmpty)
  let room: JSONValue = .object([
    "cursor": .string("1"), "kind": .string("room"), "entity_id": .string("room"),
    "data": .object(["id": .string("room"), "name": .string("舰桥")]),
  ])
  try store.apply(namespace: "server-a|epoch1", events: [room], cursor: "1")
  let deletion: JSONValue = .object([
    "cursor": .string("2"), "kind": .string("room_deleted"), "entity_id": .string("room"),
    "data": .object(["id": .string("room")]),
  ])
  try store.apply(namespace: "server-a|epoch1", events: [deletion], cursor: "2")
  #expect(try store.records(namespace: "server-a|epoch1").isEmpty)
  #expect(try store.commands(namespace: "server-a|epoch1").count == 1)
}
@Test func canonicalServerIdentityDoesNotDependOnClock() throws {
  #expect(
    try ConnectionPolicy.serverURL("https://EXAMPLE.com:443/").absoluteString
      == "https://example.com")
  #expect(throws: (any Error).self) {
    try ConnectionPolicy.serverURL("http://192.168.1.2", allowLocal: true)
  }
  #expect(throws: (any Error).self) {
    try ConnectionPolicy.serverURL("https://example.com?token=bad")
  }
}

@Test func byteParserPreservesBlankSeparatorsAndSplitChineseUTF8() throws {
  var parser = SSEParser()
  var frames: [SSEFrame] = []
  for byte
    in "id: 12\r\nevent: sync\r\ndata: {\"content\":\"星港\"}\r\n\r\n: heartbeat\n\nid: 13\ndata: {}\n\n"
    .utf8
  {
    if let frame = try parser.consume(byte: byte) { frames.append(frame) }
  }
  #expect(frames.count == 3)
  #expect(frames[0].id == "12")
  #expect(frames[0].data == "{\"content\":\"星港\"}")
  #expect(frames[1].data.isEmpty)
  #expect(frames[2].id == "13")
}

@MainActor @Test func memoryPrivacyResetReplacesContentAndPreservesDrafts() throws {
  let store = try CacheStore(inMemory: true)
  let memory: JSONValue = .object([
    "id": .string("memory"), "world_id": .string("world"), "content": .string("合成暗号"),
    "status": .string("active"),
  ])
  try store.replace(
    namespace: "test",
    snapshot: .object([
      "high_water_cursor": .string("8"), "memories": .array([memory]),
      "memory_settings": .array([.object(["world_id": .string("world"), "enabled": .bool(true)])]),
    ]))
  #expect(try store.records(namespace: "test").filter { $0.kind == "memory" }.count == 1)
  try store.draft(namespace: "test", room: "room", content: "未发送草稿")
  var erased = memory.object
  erased["content"] = .string("")
  erased["status"] = .string("deleted")
  try store.replace(
    namespace: "test",
    snapshot: .object(["high_water_cursor": .string("12"), "memories": .array([.object(erased)])]))
  #expect(try store.records(namespace: "test").allSatisfy { $0["content"].string.isEmpty })
  #expect(try store.commands(namespace: "test").first?.content == "未发送草稿")
}

@MainActor @Test func bulkSnapshotReplacementKeepsNamespacesAndLatestContent() throws {
  let store = try CacheStore(inMemory: true)
  let count = ProcessInfo.processInfo.environment["ECHO_CACHE_BENCHMARK"] == "1" ? 100_000 : 1_000
  let messages: [JSONValue] = (0..<count).map { i in
    .object(["id": .string("message-\(i)"), "room_id": .string("room"), "content": .string("合成消息 \(i)")])
  }
  try store.replace(namespace: "other-server", snapshot: .object([
    "high_water_cursor": .string("2"), "messages": .array([messages[0]])]))
  let start = Date()
  try store.replace(namespace: "bulk", snapshot: .object([
    "high_water_cursor": .string("100001"), "messages": .array(messages)]))
  #expect(try store.records(namespace: "bulk").count == count)
  #expect(try store.cursor(namespace: "bulk") == "100001")
  let firstLoad = Date().timeIntervalSince(start)
  try store.draft(namespace: "bulk", room: "room", content: "保留草稿")
  let changed: JSONValue = .object(["id": .string("message-0"), "content": .string("最新纠正")])
  try store.replace(namespace: "bulk", snapshot: .object([
    "high_water_cursor": .string("100002"), "messages": .array([changed])]))
  #expect(try store.records(namespace: "bulk").count == 1)
  #expect(try store.records(namespace: "bulk").first?["content"].string == "最新纠正")
  #expect(try store.records(namespace: "other-server").count == 1)
  #expect(try store.commands(namespace: "bulk").first?.content == "保留草稿")
  if count == 100_000 { print("P6 synthetic 100000-record in-memory SwiftData load+decode seconds: \(firstLoad)") }
}
