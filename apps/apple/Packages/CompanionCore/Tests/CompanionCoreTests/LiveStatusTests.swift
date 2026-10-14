import Foundation
import Testing

@testable import CompanionCore

@Suite struct LiveStatusTests {
  private let now = ChatPresentation.parseDate("2026-10-11T12:00:00Z")!

  private func record(_ kind: String, _ id: String, _ values: [String: JSONValue] = [:]) -> Record {
    var values = values
    values["id"] = .string(id)
    return Record(kind: kind, value: .object(values))
  }
  private func room(_ id: String = "room") -> Record {
    record("room", id, ["name": .string("周末小聚"), "world_id": .string("world")])
  }
  private func run(_ id: String = "run", state: String = "running", room: String = "room") -> Record {
    record("run", id, ["state": .string(state), "room_id": .string(room),
      "world_id": .string("world"), "created_at": .string("2026-10-11T11:50:00Z")])
  }
  private func message(_ id: String = "message", run: String = "run", actor: String = "actor",
    status: String = "streaming", role: String = "assistant", sequence: String = "20") -> Record
  {
    record("message", id, ["run_id": .string(run), "room_id": .string("room"),
      "actor_id": .string(actor), "actor_name": .string("合成角色"), "status": .string(status),
      "role": .string(role), "created_at": .string("2026-10-11T11:55:00Z"),
      "sequence": .string(sequence), "content": .string("合成测试消息")])
  }
  private func call(_ id: String = "call", run: String = "run", state: String = "pending",
    expiry: String = "2026-10-12T12:00:00Z", date: String = "2026-10-11T11:58:00Z") -> Record
  {
    record("tool_call", id, ["run_id": .string(run), "actor_id": .string("actor"),
      "state": .string(state), "created_at": .string(date), "expires_at": .string(expiry)])
  }

  @Test func unknownEnumsDoNotImplyDeliveryOrACharacter() {
    let typed = ChatMessage(record: message(status: "future_delivered", role: "future_role"))
    #expect(typed.status == .unknown("future_delivered"))
    #expect(typed.role == .unknown("future_role"))
    #expect(!typed.isUser && !typed.isAssistant && !typed.canRegenerate)
    #expect(typed.displayName == "消息")
    #expect(!RunState(rawValue: "future_running").isActive)
    #expect(LiveStatus(records: [room(), run(state: "future_running"), message()],
      isConnected: true, now: now).current == nil)
  }

  @Test func replacementRequiresCompletedCharacterReply() {
    #expect(ChatMessage(record: message(status: "completed")).canRegenerate)
    #expect(!ChatMessage(record: message(status: "completed", role: "user")).canRegenerate)
    for status in ["accepted", "streaming", "failed", "interrupted", "cancelled", "invalidated", ""] {
      #expect(!ChatMessage(record: message(status: status)).canRegenerate)
    }
    #expect(MessageStatus(rawValue: "interrupted").isIncomplete)
    #expect(!MessageStatus(rawValue: "completed").isIncomplete)
  }

  @Test func groupingDoesNotHideFailureOrJoinDifferentRoomsAndUnknownActors() {
    let previous = ChatMessage(record: message(status: "completed"))
    #expect(ChatPresentation.continues(ChatMessage(record: message()), after: previous))
    for status in ["failed", "interrupted", "cancelled", "invalidated", "future"] {
      #expect(!ChatPresentation.continues(ChatMessage(record: message(status: status)), after: previous))
    }
    var otherRoom = message().value.object
    otherRoom["room_id"] = .string("another-room")
    #expect(!ChatPresentation.continues(ChatMessage(record: Record(kind: "message", value: .object(otherRoom))),
      after: previous))
    let missingActor = ChatMessage(record: message(actor: ""))
    #expect(!ChatPresentation.continues(missingActor, after: missingActor))
  }

  @Test func actualStreamingSpeakerWinsOverOtherGroupMembersAndCompletedMessages() {
    let records = [room(), run(), message("old", actor: "old-actor", status: "completed", sequence: "19"),
      message(), record("actor", "another-actor", ["name": .string("不该被归属的角色")])]
    let live = LiveStatus(records: records, isConnected: true, now: now)
    #expect(live.current?.actorID == "actor")
    #expect(live.current?.partnerName == "合成角色")
    #expect(live.current?.kind == .composing)
    #expect(live.current?.roomID == "room")
    #expect(live.current?.text == "合成角色 正在给你写消息…")
    #expect(live.current?.shortText == "合成角色 正在输入…")
  }

  @Test func runningAloneDoesNotInventTypingOrSpeaker() {
    let live = LiveStatus(records: [room(), run(), message(status: "completed")],
      isConnected: true, now: now)
    #expect(live.current?.kind == .preparing)
    #expect(live.current?.actorID == nil)
    #expect(live.current?.partnerName == "周末小聚")
    #expect(live.current?.isComposing == false)
  }

  @Test func executingToolCannotMasqueradeAsTyping() {
    for state in ["approved", "executing"] {
      let live = LiveStatus(records: [room(), run(), message(), call(state: state)],
        isConnected: true, now: now)
      #expect(live.current?.kind == .preparing)
      #expect(live.current?.isComposing == false)
    }
  }

  @Test func offlineCompletedQueuedAndMissingRoomStayQuiet() {
    #expect(LiveStatus(records: [room(), run(), message()], isConnected: false, now: now).items.isEmpty)
    for state in ["queued", "completed", "failed", "interrupted", "cancelled"] {
      #expect(LiveStatus(records: [room(), run(state: state), message()],
        isConnected: true, now: now).items.isEmpty)
    }
    #expect(LiveStatus(records: [run(), message()], isConnected: true, now: now).items.isEmpty)
  }

  @Test func pendingDecisionNeedsUnexpiredCallAndWaitingRun() {
    let actor = record("actor", "actor", ["name": .string("合成角色")])
    let live = LiveStatus(records: [room(), run(state: "awaiting_approval"), call(), message(), actor],
      isConnected: true, now: now)
    #expect(live.items.count == 1)
    #expect(live.current?.kind == .decision && live.current?.needsDecision == true)
    #expect(live.current?.toolCallID == "call")
    #expect(live.current?.shortText == "合成角色 等你决定")
    for expiry in ["2026-10-11T12:00:00Z", "2026-10-10T12:00:00Z", "", "malformed"] {
      #expect(LiveStatus(records: [room(), run(state: "awaiting_approval"), call(expiry: expiry)],
        isConnected: true, now: now).current == nil)
    }
    #expect(LiveStatus(records: [room(), run(state: "cancelled"), call()],
      isConnected: true, now: now).current == nil)
  }

  @Test func uncertainExternalOutcomeRemainsActionableAfterCancellation() {
    let live = LiveStatus(records: [room(), run(state: "cancelled"), call(state: "outcome_unknown")],
      isConnected: true, now: now)
    #expect(live.current?.kind == .reconciliation)
    #expect(live.current?.needsDecision == true)
    #expect(live.current?.shortText.contains("核对") == true)
    #expect(LiveStatus(records: [room(), run(state: "cancelled"), call(state: "resolved")],
      isConnected: true, now: now).current == nil)
  }

  @Test func statusOrderIsNewestFirstAndStableForEquivalentTimestamps() {
    let records = [room(), run(state: "awaiting_approval"),
      call("z", date: "2026-10-11T19:58:00+08:00"),
      call("a", date: "2026-10-11T11:58:00.000Z"),
      call("newer", date: "2026-10-11T11:59:00Z")]
    let live = LiveStatus(records: records, isConnected: true, now: now)
    #expect(live.items.map(\.toolCallID) == ["newer", "a", "z"])
    #expect(live.remainingCount == 2)
    #expect(live == LiveStatus(records: records.reversed(), isConnected: true, now: now))
  }
}
