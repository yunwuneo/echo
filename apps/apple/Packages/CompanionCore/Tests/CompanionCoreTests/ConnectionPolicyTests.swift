import Testing

@testable import CompanionCore

@Test func serverTrustBoundary() throws {
  #expect(try ConnectionPolicy.serverURL("https://example.com").host == "example.com")
  #expect(throws: (any Error).self) { try ConnectionPolicy.serverURL("http://example.com") }
  #expect(throws: (any Error).self) {
    try ConnectionPolicy.serverURL("https://user:secret@example.com")
  }
  #expect(throws: (any Error).self) {
    try ConnectionPolicy.serverURL("http://127.0.0.1:3012")
  }
  #if DEBUG
    #expect(
      try ConnectionPolicy.serverURL("http://127.0.0.1:3012", allowLocal: true).host == "127.0.0.1")
  #else
    #expect(throws: (any Error).self) {
      try ConnectionPolicy.serverURL("http://127.0.0.1:3012", allowLocal: true)
    }
  #endif
}
