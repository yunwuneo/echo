#if os(iOS)
  @preconcurrency import BackgroundTasks
  import CompanionCore
  import Foundation

  @MainActor enum SystemBackground {
    static let identifier = "dev.echo2.companion.refresh-schedules"
    static weak var model: AppModel?
    static func register() {
      BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: .main) { task in
        let work = Task { @MainActor in
          let owned = model == nil
          do {
            let active = try model ?? AppModel(cache: CacheStore())
            if owned { await active.restore() }
            defer { if owned { active.suspendSynchronization() } }
            try Task.checkCancellation()
            try await DeviceSchedules.synchronize(active)
            try Task.checkCancellation()
            task.setTaskCompleted(success: true)
          } catch { task.setTaskCompleted(success: false) }
          schedule()
        }
        task.expirationHandler = { work.cancel() }
      }
    }
    static func schedule() {
      let request = BGAppRefreshTaskRequest(identifier: identifier)
      request.earliestBeginDate = Date().addingTimeInterval(900)
      do { try BGTaskScheduler.shared.submit(request) } catch {
        UserDefaults.standard.set("unavailable", forKey: "echo.backgroundOpportunity")
      }
    }
  }
#endif
