import Foundation

/// Presentation decisions use persisted timestamps and actor identity, never simulated presence.
public enum ChatPresentation {
  public static let messageLimit = 16_000

  public static func date(_ message: Record) -> Date? {
    let raw = message["created_at"].string
    return
      (try? Date(
        raw, strategy: .iso8601.year().month().day().time(includingFractionalSeconds: true)))
      ?? (try? Date(raw, strategy: .iso8601))
  }

  public static func continues(_ message: Record, after previous: Record?) -> Bool {
    guard let previous, message["role"] == previous["role"],
      message["actor_id"] == previous["actor_id"],
      message["status"].string != "invalidated", previous["status"].string != "invalidated",
      let date = date(message), let prior = self.date(previous)
    else { return false }
    let interval = date.timeIntervalSince(prior)
    return interval >= 0 && interval < 300 && Calendar.current.isDate(date, inSameDayAs: prior)
  }

  public static func needsTimestamp(_ message: Record, after previous: Record?) -> Bool {
    guard let date = date(message) else { return false }
    guard let previous, let prior = self.date(previous) else { return true }
    return date.timeIntervalSince(prior) > 1_800
      || !Calendar.current.isDate(date, inSameDayAs: prior)
  }

  public static func length(_ text: String) -> Int { text.unicodeScalars.count }
  public static func canSend(_ text: String) -> Bool {
    !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && length(text) <= messageLimit
  }
}
