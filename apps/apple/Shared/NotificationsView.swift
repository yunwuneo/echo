import CompanionCore
import SwiftUI
import UserNotifications

#if os(iOS)
  import UIKit
#else
  import AppKit
#endif

@Observable @MainActor final class PushCoordinator: NSObject, UNUserNotificationCenterDelegate {
  static let shared = PushCoordinator()
  var token = ""
  var registrationError: String?
  var event: JSONValue = .null
  var eventRevision = 0
  func start() {
    UNUserNotificationCenter.current().delegate = self
    Task {
      let settings = await UNUserNotificationCenter.current().notificationSettings()
      if settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
      {
        register()
      }
    }
  }
  func register() {
    #if os(iOS)
      UIApplication.shared.registerForRemoteNotifications()
    #else
      NSApplication.shared.registerForRemoteNotifications()
    #endif
  }
  func authorize() async throws {
    guard
      try await UNUserNotificationCenter.current().requestAuthorization(options: [
        .alert, .sound, .badge,
      ])
    else {
      throw NSError(
        domain: "EchoPush", code: 403,
        userInfo: [NSLocalizedDescriptionKey: String(localized: "请在系统设置中允许 Echo 通知")])
    }
    registrationError = nil
    register()
  }
  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification
  ) async -> UNNotificationPresentationOptions { [.banner, .sound] }
  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse
  ) async {
    let data = response.notification.request.content.userInfo
    let event = data["event_id"] as? String ?? ""
    let instance = data["server_instance_id"] as? String ?? ""
    let epoch = data["data_epoch"] as? String ?? ""
    guard UUID(uuidString: event) != nil, UUID(uuidString: instance) != nil,
      UUID(uuidString: epoch) != nil
    else { return }
    await MainActor.run {
      self.event = .object([
        "event_id": .string(event), "server_instance_id": .string(instance),
        "data_epoch": .string(epoch),
      ])
      self.eventRevision += 1
    }
  }
}
#if os(iOS)
  final class PushAppDelegate: NSObject, UIApplicationDelegate {
    func application(
      _ application: UIApplication,
      didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
      PushCoordinator.shared.start()
      SystemBackground.register()
      return true
    }
    func application(
      _ application: UIApplication,
      didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) { PushCoordinator.shared.token = deviceToken.map { String(format: "%02x", $0) }.joined() }
    func application(
      _ application: UIApplication,
      didFailToRegisterForRemoteNotificationsWithError error: any Error
    ) { PushCoordinator.shared.registrationError = String(localized: "无法注册系统推送，请检查网络与签名配置。") }
  }
#else
  final class PushAppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
      PushCoordinator.shared.start()
    }
    func application(
      _ application: NSApplication,
      didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) { PushCoordinator.shared.token = deviceToken.map { String(format: "%02x", $0) }.joined() }
    func application(
      _ application: NSApplication,
      didFailToRegisterForRemoteNotificationsWithError error: any Error
    ) { PushCoordinator.shared.registrationError = String(localized: "无法注册系统推送，请检查网络与签名配置。") }
  }
#endif

struct NotificationsView: View {
  var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var status: JSONValue = .null
  @State private var invitation = ""
  @State private var busy = false
  @State private var failure: String?
  private var push: PushCoordinator { .shared }
  var body: some View {
    NavigationStack {
      Form {
        Section(String(localized: "系统通知")) {
          if status == .null {
            if failure == nil { ProgressView(String(localized: "正在读取通知设置…")) }
          } else {
            Text(
              status["enabled"].bool ? String(localized: "此设备已开启通知") : String(localized: "此设备未开启通知")
            )
            Text(String(localized: "通知只显示通用文案。聊天与剧情始终保存在你的服务器，打开 App 后同步。")).font(EchoFont.caption)
            if status["available"].bool {
              Text(status["relay_url"].string).font(EchoFont.caption).textSelection(.enabled)
              Button(String(localized: "允许系统通知")) {
                Task {
                  do { try await push.authorize() } catch { failure = userFacingError(error) }
                }
              }
              if !push.token.isEmpty {
                Text(String(localized: "已取得设备推送地址")).foregroundStyle(.secondary)
              }
              if let error = push.registrationError {
                Label(error, systemImage: "exclamationmark.circle").foregroundStyle(
                  Color.echo.warning
                )
                .fixedSize(horizontal: false, vertical: true)
              }
              LabeledContent(String(localized: "中继一次性邀请")) {
                SecureField(String(localized: "填写邀请"), text: $invitation)
              }
              Button(String(localized: "绑定或续期此设备")) {
                busy = true
                Task {
                  defer { busy = false }
                  do {
                    try await model.bindPush(
                      invitation: invitation.trimmingCharacters(in: .whitespacesAndNewlines),
                      apnsToken: push.token, topic: Bundle.main.bundleIdentifier ?? "",
                      environment: Bundle.main.object(forInfoDictionaryKey: "EchoPushEnvironment")
                        as? String ?? "sandbox")
                    invitation = ""
                    status = try await model.operations(action: "notifications")
                  } catch { failure = userFacingError(error) }
                }
              }.disabled(busy || invitation.isEmpty || push.token.isEmpty)
              if status["enabled"].bool {
                Text(String(localized: "到期时间：\(status["expires_at"].string)")).font(
                  EchoFont.caption)
                Button(String(localized: "关闭此设备通知"), role: .destructive) {
                  Task {
                    do {
                      try await model.disablePush()
                      status = try await model.operations(action: "notifications")
                    } catch { failure = userFacingError(error) }
                  }
                }
              }
            } else {
              Text(String(localized: "服务器尚未配置通知中继，仍可正常聊天与同步。")).foregroundStyle(.secondary)
            }
          }
          Button(String(localized: "刷新通知设置")) { Task { await refresh() } }
        }
        Section(String(localized: "最近投递")) {
          Text(String(localized: "“已受理”表示中继取得 APNs 接受响应，不代表设备已显示。系统可能延迟或抑制通知。")).font(
            EchoFont.caption)
          ForEach(Array(status["deliveries"].array.enumerated()), id: \.offset) { _, item in
            LabeledContent(item["updated_at"].string, value: stateName(item["state"].string)).font(
              .caption)
          }
        }
        if let failure {
          Label(failure, systemImage: "exclamationmark.circle")
            .foregroundStyle(Color.echo.error).fixedSize(horizontal: false, vertical: true)
        }
      }.formStyle(.grouped).scrollContentBackground(.hidden)
        .background(Color.echo.surfaceSunken).navigationTitle(String(localized: "通知"))
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button(String(localized: "完成")) { dismiss() }.accessibilityIdentifier(
              "close-notifications")
          }
        }
        .task { await refresh() }
    }.frame(minWidth: 320, idealWidth: 560, minHeight: 460)
  }
  private func refresh() async {
    do {
      status = try await model.operations(action: "notifications")
      failure = nil
    } catch { failure = userFacingError(error) }
  }
  private func stateName(_ state: String) -> String {
    [
      "pending": String(localized: "待投递"), "sending": String(localized: "投递中"),
      "accepted": String(localized: "APNs 已受理"), "failed": String(localized: "投递失败"),
      "suppressed": String(localized: "已停止"), "unknown": String(localized: "结果未知"),
    ][state] ?? state
  }
}
