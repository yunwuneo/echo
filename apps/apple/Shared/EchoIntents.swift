import AppIntents
import CompanionCore

struct AskEchoIntent: AppIntent {
  static let title: LocalizedStringResource = "向 Echo 提问"
  static let description = IntentDescription("默认保存草稿。只有你在此快捷指令中开启直接发送，打开 App 后才会发送。")
  static let openAppWhenRun = true
  @Parameter(title: "对话 ID") var room: String
  @Parameter(title: "问题") var question: String
  @Parameter(title: "直接发送", default: false) var send: Bool
  func perform() async throws -> some IntentResult {
    let all = SystemInbox.targets()
    guard let t = all["targets"].array.first(where: { $0["room"].string == room }) else {
      throw APIError(status: 409, code: "share_target")
    }
    try SystemInbox.store(
      SystemInboxItem(
        namespace: all["namespace"].string, actor: t["actor"].string, room: room, content: question,
        send: send))
    return .result()
  }
}
struct OpenEchoConversationIntent: AppIntent {
  static let title: LocalizedStringResource = "打开 Echo 对话"
  static let openAppWhenRun = true
  @Parameter(title: "对话 ID") var room: String
  func perform() async throws -> some IntentResult {
    let all = SystemInbox.targets()
    guard let t = all["targets"].array.first(where: { $0["room"].string == room }) else {
      throw APIError(status: 409, code: "share_target")
    }
    try SystemInbox.store(
      SystemInboxItem(
        namespace: all["namespace"].string, actor: t["actor"].string, room: room, content: "",
        openOnly: true))
    return .result()
  }
}
struct EchoShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: AskEchoIntent(), phrases: ["在 \(.applicationName) 中提问"], shortTitle: "提问",
      systemImageName: "bubble.left")
    AppShortcut(
      intent: OpenEchoConversationIntent(), phrases: ["打开 \(.applicationName) 对话"],
      shortTitle: "打开对话", systemImageName: "bubble.left.and.bubble.right")
  }
}
