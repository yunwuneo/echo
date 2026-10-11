import Foundation
import Testing

@testable import CompanionCore

@Suite struct ChatPresentationTests {
  private func message(_ actor: String, _ date: String, status: String = "completed") -> Record {
    Record(
      kind: "message",
      value: .object([
        "role": .string("assistant"), "actor_id": .string(actor),
        "created_at": .string(date), "status": .string(status),
      ]))
  }
  @Test func groupingKeepsIdentityAndFailuresVisible() {
    let first = message("a", "2026-10-11T12:00:00.000Z")
    #expect(ChatPresentation.continues(message("a", "2026-10-11T12:04:59Z"), after: first))
    #expect(!ChatPresentation.continues(message("b", "2026-10-11T12:01:00Z"), after: first))
    #expect(!ChatPresentation.continues(message("a", "2026-10-11T12:05:00Z"), after: first))
    #expect(!ChatPresentation.continues(message("a", "2026-10-11T11:59:00Z"), after: first))
    #expect(
      !ChatPresentation.continues(
        message("a", "2026-10-11T12:01:00Z", status: "invalidated"), after: first))
    #expect(ChatPresentation.needsTimestamp(message("a", "2026-10-11T12:31:00Z"), after: first))
    #expect(!ChatPresentation.needsTimestamp(message("a", "2026-10-11T12:20:00Z"), after: first))
  }
  @Test func inputUsesContractCodePointLimit() {
    #expect(!ChatPresentation.canSend("  \n"))
    #expect(ChatPresentation.canSend(String(repeating: "你", count: 16_000)))
    #expect(!ChatPresentation.canSend(String(repeating: "你", count: 16_001)))
    #expect(ChatPresentation.length("👩‍🚀") == 3)
    #expect(!ChatPresentation.canSend(String(repeating: "👩‍🚀", count: 6_000)))
  }
}
