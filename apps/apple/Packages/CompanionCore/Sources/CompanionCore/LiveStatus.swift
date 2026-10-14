import Foundation

/// Ephemeral UI state derived solely from synchronized records. No simulated presence/read count.
public struct LiveStatus: Hashable, Sendable {
  public enum Kind: Hashable, Sendable {
    case composing, preparing, decision, reconciliation
  }

  public struct Item: Identifiable, Hashable, Sendable {
    public let id: String
    public let roomID: String
    public let runID: String
    public let actorID: String?
    public let partnerName: String
    public let toolCallID: String?
    public let kind: Kind
    public let createdAt: Date?

    public var needsDecision: Bool { kind == .decision || kind == .reconciliation }
    public var isComposing: Bool { kind == .composing }
    public var text: String {
      switch kind {
      case .composing: String(localized: "\(partnerName) 正在给你写消息…", bundle: .main)
      case .preparing: String(localized: "\(partnerName) 正在准备回应…", bundle: .main)
      case .decision: String(localized: "\(partnerName) 想做一件事，需要你同意", bundle: .main)
      case .reconciliation: String(localized: "\(partnerName) 的一件事，需要你核对结果", bundle: .main)
      }
    }
    public var shortText: String {
      switch kind {
      case .composing: String(localized: "\(partnerName) 正在输入…", bundle: .main)
      case .preparing: String(localized: "\(partnerName) 准备回应…", bundle: .main)
      case .decision: String(localized: "\(partnerName) 等你决定", bundle: .main)
      case .reconciliation: String(localized: "\(partnerName) 等你核对", bundle: .main)
      }
    }
  }

  public let items: [Item]
  public var current: Item? { items.first }
  public var remainingCount: Int { max(0, items.count - 1) }

  public init(records: [Record], isConnected: Bool, now: Date = .now) {
    // A cache restored while disconnected cannot substantiate a real-time claim.
    guard isConnected else {
      items = []
      return
    }
    let rooms = Self.index(records.filter { $0.kind == "room" })
    let actors = Self.index(records.filter { $0.kind == "actor" })
    let runs = records.filter {
      guard $0.kind == "run" else { return false }
      let state = RunState(rawValue: $0["state"].string)
      return state == .running || state == .awaitingApproval || state == .cancelled
    }.map(ChatRun.init)
    let runIndex = Dictionary(runs.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
    // Avoid parsing dates/content for the entire message history on every status refresh.
    let messages = records.filter {
      $0.kind == "message" && MessageRole(rawValue: $0["role"].string) == .assistant
        && MessageStatus(rawValue: $0["status"].string) == .streaming
        && runIndex[$0["run_id"].string]?.state == .running
    }.map(ChatMessage.init)
    let executingRunIDs = Set(
      records.filter {
        $0.kind == "tool_call" && ["approved", "executing"].contains($0["state"].string)
      }.map { $0["run_id"].string })
    var candidates: [Item] = []

    for call in records where call.kind == "tool_call" {
      guard let run = runIndex[call["run_id"].string], let room = rooms[run.roomID] else {
        continue
      }
      let kind: Kind
      switch call["state"].string {
      case "pending":
        guard run.state == .awaitingApproval,
          let expiry = ChatPresentation.parseDate(call["expires_at"].string), expiry > now
        else { continue }
        kind = .decision
      case "outcome_unknown":
        // Cancellation cannot undo an external side effect; reconciliation remains actionable.
        guard run.state == .awaitingApproval || run.state == .cancelled else { continue }
        kind = .reconciliation
      default: continue
      }
      let actorID = call["actor_id"].string.nilIfEmpty
      let actor = actorID.flatMap { actors[$0] }
      let name =
        actor?.name.nilIfEmpty ?? room.name.nilIfEmpty ?? String(localized: "这段聊天", bundle: .main)
      candidates.append(
        Item(
          id: "decision:\(call.id)", roomID: run.roomID, runID: run.id, actorID: actorID,
          partnerName: name, toolCallID: call.id, kind: kind,
          createdAt: ChatPresentation.date(call) ?? run.createdAt))
    }

    let decisionRunIDs = Set(candidates.map(\.runID))
    for run in runs where run.state == .running && !decisionRunIDs.contains(run.id) {
      guard let room = rooms[run.roomID] else { continue }
      // Running can include a tool request. Only an actual streaming message identifies a speaker.
      // Do not attribute the next group reply to the last completed speaker or the first member.
      let streaming = messages.filter {
        $0.runID == run.id && $0.roomID == run.roomID && $0.isAssistant && $0.status == .streaming
          && !executingRunIDs.contains(run.id)
      }.sorted { lhs, rhs in
        if lhs.sequence != rhs.sequence { return cursorIsNewer(lhs.sequence, than: rhs.sequence) }
        return lhs.id < rhs.id
      }.first
      let actorID = streaming?.actorID
      let actor = actorID.flatMap { actors[$0] }
      let name =
        streaming?.actorName.nilIfEmpty ?? actor?.name.nilIfEmpty
        ?? room.name.nilIfEmpty ?? String(localized: "这段聊天", bundle: .main)
      candidates.append(
        Item(
          id: "run:\(run.id)", roomID: run.roomID, runID: run.id, actorID: actorID,
          partnerName: name, toolCallID: nil,
          kind: streaming != nil ? .composing : .preparing,
          createdAt: streaming?.createdAt ?? run.createdAt))
    }

    // Dates are parsed before comparing, so fractional precision/time-zone offsets cannot reorder
    // equivalent instants. IDs break ties deterministically across cache iteration orders.
    items = candidates.sorted {
      let lhs = $0.createdAt ?? .distantPast
      let rhs = $1.createdAt ?? .distantPast
      return lhs == rhs ? $0.id < $1.id : lhs > rhs
    }
  }

  private static func index(_ records: [Record]) -> [String: Record] {
    Dictionary(records.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
  }
}
