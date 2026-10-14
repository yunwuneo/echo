import Foundation

/// Unknown protocol values stay unknown; they never imply successful delivery or a role.
public enum MessageRole: Hashable, Sendable {
  case user, assistant
  case unknown(String)

  public init(rawValue: String) {
    switch rawValue {
    case "user": self = .user
    case "assistant": self = .assistant
    default: self = .unknown(rawValue)
    }
  }
}

public enum MessageStatus: Hashable, Sendable {
  case accepted, streaming, completed, failed, interrupted, cancelled, invalidated
  case unknown(String)

  public init(rawValue: String) {
    switch rawValue {
    case "accepted": self = .accepted
    case "streaming": self = .streaming
    case "completed": self = .completed
    case "failed": self = .failed
    case "interrupted": self = .interrupted
    case "cancelled": self = .cancelled
    case "invalidated": self = .invalidated
    default: self = .unknown(rawValue)
    }
  }

  public var isFailure: Bool { self == .failed || self == .interrupted }
  public var isIncomplete: Bool { isFailure }
  public var allowsGrouping: Bool {
    switch self {
    case .accepted, .streaming, .completed: true
    default: false
    }
  }
}

public enum RunState: Hashable, Sendable {
  case queued, running, awaitingApproval, remotePending, completed, failed, cancelled, interrupted
  case unknown(String)

  public init(rawValue: String) {
    switch rawValue {
    case "queued": self = .queued
    case "running": self = .running
    case "awaiting_approval": self = .awaitingApproval
    case "remote_pending": self = .remotePending
    case "completed": self = .completed
    case "failed": self = .failed
    case "cancelled": self = .cancelled
    case "interrupted": self = .interrupted
    default: self = .unknown(rawValue)
    }
  }

  public var isActive: Bool {
    self == .queued || self == .running || self == .awaitingApproval || self == .remotePending
  }
}

/// A typed presentation projection of the existing synchronized cache, not another data source.
public struct ChatMessage: Identifiable, Hashable, Sendable {
  public let id: String
  public let roomID: String
  public let runID: String
  public let actorID: String?
  public let actorName: String
  public let role: MessageRole
  public let status: MessageStatus
  public let content: String
  public let sequence: String
  public let createdAt: Date?

  public init(record: Record) {
    id = record.id
    roomID = record["room_id"].string
    runID = record["run_id"].string
    actorID = record["actor_id"].string.nilIfEmpty
    actorName = record["actor_name"].string
    role = MessageRole(rawValue: record["role"].string)
    status = MessageStatus(rawValue: record["status"].string)
    content = record["content"].string
    sequence = record["sequence"].string
    createdAt = ChatPresentation.date(record)
  }

  public var isUser: Bool { role == .user }
  public var isAssistant: Bool { role == .assistant }
  public var displayName: String {
    switch role {
    case .user: String(localized: "你", bundle: .main)
    case .assistant: actorName.nilIfEmpty ?? "TA"
    case .unknown: String(localized: "消息", bundle: .main)
    }
  }
  public var canRequestReplacement: Bool {
    isAssistant && status == .completed && !runID.isEmpty
  }
  public var canRegenerate: Bool { canRequestReplacement }
}

public struct ChatRun: Identifiable, Hashable, Sendable {
  public let id: String
  public let roomID: String
  public let worldID: String
  public let state: RunState
  public let createdAt: Date?

  public init(record: Record) {
    id = record.id
    roomID = record["room_id"].string
    worldID = record["world_id"].string
    state = RunState(rawValue: record["state"].string)
    createdAt = ChatPresentation.date(record)
  }
}

extension String {
  var nilIfEmpty: String? { isEmpty ? nil : self }
}
