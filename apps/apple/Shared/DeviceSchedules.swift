import CompanionCore
import Foundation
import UserNotifications

@MainActor enum DeviceSchedules {
  static func synchronize(_ model: AppModel) async throws {
    guard let connection = model.connection else { return }
    let library = try await featureCall(model, "scheduleLibrary")
    guard model.connection?.namespace == connection.namespace else { return }
    let schedules = library["schedules"].array.filter {
      $0["executor"].string == "device"
        && $0["device_id"].string == connection.credentials.device_id
    }
    let center = UNUserNotificationCenter.current()
    let permission = await center.notificationSettings()
    for s in schedules {
      try Task.checkCancellation()
      guard model.connection?.namespace == connection.namespace else { return }
      let id = SystemActionInput.notificationID(
        namespace: connection.namespace, scheduleID: s["id"].string)
      if !s["enabled"].bool {
        center.removePendingNotificationRequests(withIdentifiers: [id])
        continue
      }
      if [.authorized, .provisional].contains(permission.authorizationStatus),
        let date = ChatPresentation.parseDate(s["next_at"].string), date > Date()
      {
        let content = UNMutableNotificationContent()
        content.title = "Echo 定时任务"
        content.body = s["name"].string
        content.sound = .default
        let seconds = max(1, date.timeIntervalSinceNow)
        do {
          try await center.add(
            UNNotificationRequest(
              identifier: id, content: content,
              trigger: UNTimeIntervalNotificationTrigger(timeInterval: seconds, repeats: false)))
          guard model.connection?.namespace == connection.namespace, !Task.isCancelled else {
            center.removePendingNotificationRequests(withIdentifiers: [id])
            return
          }
          _ = try await featureCall(
            model, "reportScheduleNotification",
            ["id": s["id"], "state": .string("scheduled"), "notification_id": .string(id)],
            revision: s["revision"].int)
        } catch {
          guard model.connection?.namespace == connection.namespace, !Task.isCancelled else {
            return
          }
          _ = try await featureCall(
            model, "reportScheduleNotification", ["id": s["id"], "state": .string("failed")],
            revision: s["revision"].int)
        }
      } else if permission.authorizationStatus == .denied {
        _ = try await featureCall(
          model, "reportScheduleNotification", ["id": s["id"], "state": .string("denied")],
          revision: s["revision"].int)
      }
    }
    // Only a genuine foreground or OS background execution opportunity starts pending occurrences. Missed single runs remain a user decision.
    for o in library["occurrences"].array
    where o["state"].string == "pending"
      && schedules.contains(where: { $0["id"] == o["schedule_id"] })
    {
      try Task.checkCancellation()
      guard model.connection?.namespace == connection.namespace else { return }
      _ = try await featureCall(
        model, "runOccurrence",
        ["id": o["schedule_id"], "slot": o["slot"], "allow_missed": .bool(false)])
    }
  }
}
