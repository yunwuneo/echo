import Foundation

/// Presentation decisions use persisted timestamps and actor identity, never simulated presence.
public enum ChatPresentation {
  public static let messageLimit = 16_000

  public static func date(_ message: Record) -> Date? {
    parseDate(message["created_at"].string)
  }

  public static func parseDate(_ raw: String) -> Date? {
    return
      (try? Date(
        raw,
        strategy: .iso8601.year().month().day().time(includingFractionalSeconds: true)
          .timeZone(separator: .colon)))
      ?? (try? Date(raw, strategy: .iso8601))
  }

  public static func continues(_ message: Record, after previous: Record?) -> Bool {
    continues(ChatMessage(record: message), after: previous.map(ChatMessage.init))
  }

  public static func continues(_ message: ChatMessage, after previous: ChatMessage?) -> Bool {
    guard let previous, message.role == previous.role,
      message.isUser || (message.isAssistant && message.actorID != nil),
      message.roomID == previous.roomID, message.actorID == previous.actorID,
      message.status.allowsGrouping, previous.status.allowsGrouping,
      let date = message.createdAt, let prior = previous.createdAt
    else { return false }
    let interval = date.timeIntervalSince(prior)
    return interval >= 0 && interval < 300 && Calendar.current.isDate(date, inSameDayAs: prior)
  }

  public static func needsTimestamp(_ message: Record, after previous: Record?) -> Bool {
    needsTimestamp(ChatMessage(record: message), after: previous.map(ChatMessage.init))
  }

  public static func needsTimestamp(_ message: ChatMessage, after previous: ChatMessage?) -> Bool {
    guard let date = message.createdAt else { return false }
    guard let previous, let prior = previous.createdAt else { return true }
    return date.timeIntervalSince(prior) > 1_800
      || !Calendar.current.isDate(date, inSameDayAs: prior)
  }

  public static func length(_ text: String) -> Int { text.unicodeScalars.count }
  public static func canSend(_ text: String) -> Bool {
    !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && length(text) <= messageLimit
  }
}
