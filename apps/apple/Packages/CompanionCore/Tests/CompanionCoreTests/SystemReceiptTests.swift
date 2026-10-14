import Foundation
import Testing

@testable import CompanionCore

@Suite @MainActor struct SystemReceiptTests {
  @Test func receiptsStayWithOriginalNamespaceAcrossConnectionChanges() throws {
    let cache = try CacheStore(inMemory: true)
    let model = AppModel(cache: cache)
    try model.storeExecutionReceipt(
      namespace: "server-a:epoch-a", id: "operation", value: "unknown")
    try model.storeExecutionReceipt(
      namespace: "server-b:epoch-b", id: "operation", value: "different")
    try model.storeExecutionReceipt(
      namespace: "server-a:epoch-a", id: "operation", value: "completed-external-id")
    #expect(
      try model.executionReceipt(namespace: "server-a:epoch-a", id: "operation")
        == "completed-external-id")
    #expect(
      try model.executionReceipt(namespace: "server-b:epoch-b", id: "operation") == "different")
    #expect(try model.executionReceipt(namespace: "server-a:new-epoch", id: "operation").isEmpty)
  }
  @Test func remotePendingIsActiveWithoutClaimingLocalGeneration() {
    #expect(RunState(rawValue: "remote_pending").isActive)
    #expect(RunState(rawValue: "remote_pending") != .running)
  }
  @Test func systemWritesRejectMissingAndInvalidDatesInsteadOfUsingNow() throws {
    let fallback = Date(timeIntervalSince1970: 100)
    #expect(throws: APIError.self) { try SystemActionInput.date(.null) }
    #expect(throws: APIError.self) {
      try SystemActionInput.date(.string("invalid"), default: fallback)
    }
    #expect(throws: APIError.self) { try SystemActionInput.date(.number(100)) }
    #expect(try SystemActionInput.date(.null, default: fallback) == fallback)
    let a = try SystemActionInput.date(.string("2026-10-14T08:00:00.123Z"))
    let b = try SystemActionInput.date(.string("2026-10-14T16:00:00.123+08:00"))
    #expect(a == b)
  }

  @Test func scheduledNotificationsRemainIsolatedAcrossServersAndRestoreEpochs() {
    let a = SystemActionInput.notificationID(namespace: "server-a:epoch-a", scheduleID: "same-id")
    #expect(
      a == SystemActionInput.notificationID(namespace: "server-a:epoch-a", scheduleID: "same-id"))
    #expect(
      a != SystemActionInput.notificationID(namespace: "server-b:epoch-a", scheduleID: "same-id"))
    #expect(
      a != SystemActionInput.notificationID(namespace: "server-a:epoch-b", scheduleID: "same-id"))
    #expect(!a.contains("server-a"))
  }

}
