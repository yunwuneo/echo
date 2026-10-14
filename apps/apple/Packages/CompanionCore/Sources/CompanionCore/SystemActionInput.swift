import CryptoKit
import Foundation

/// Explicit invalid input never falls back to a time that could change an approved action.
public enum SystemActionInput {
  public static func notificationID(namespace: String, scheduleID: String) -> String {
    let digest = SHA256.hash(data: Data(namespace.utf8)).map { String(format: "%02x", $0) }.joined()
    return "echo-schedule-" + digest + "-" + scheduleID
  }
  public static func date(_ value: JSONValue, default fallback: Date? = nil) throws -> Date {
    if value == .null, let fallback { return fallback }
    guard case .string(let text) = value, let parsed = ChatPresentation.parseDate(text) else {
      throw APIError(status: 400, code: "invalid_date")
    }
    return parsed
  }
}
