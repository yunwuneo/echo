import CompanionCore
@preconcurrency import Contacts
@preconcurrency import CoreLocation
import CryptoKit
@preconcurrency import EventKit
@preconcurrency import Photos
import SwiftUI
@preconcurrency import UserNotifications

#if os(iOS)
  import HealthKit
  import WeatherKit
#endif

struct SystemOutcome {
  var state = "completed"
  var externalID: String?
  var value: JSONValue
}
@MainActor
final class SystemServices: NSObject, @preconcurrency CLLocationManagerDelegate {
  let events = EKEventStore()
  let contacts = CNContactStore()
  let location = CLLocationManager()
  private var locationWaiter: CheckedContinuation<CLLocation, Error>?
  private var locationTimeout: Task<Void, Never>?
  #if os(iOS)
    let health = HKHealthStore()
  #endif
  static let capabilities = [
    "calendar", "reminders", "contacts", "health", "photos", "location", "weather", "battery",
    "notifications", "timer", "shortcut",
  ]
  override init() {
    super.init()
    location.delegate = self
  }
  func state(_ capability: String) async -> String {
    switch capability {
    case "calendar", "reminders":
      switch EKEventStore.authorizationStatus(for: capability == "calendar" ? .event : .reminder) {
      case .fullAccess: return "authorized"
      case .writeOnly: return "limited"
      case .denied, .restricted: return "denied"
      default: return "not_determined"
      }
    case "contacts":
      switch CNContactStore.authorizationStatus(for: .contacts) {
      case .authorized: return "authorized"
      case .limited: return "limited"
      case .denied, .restricted: return "denied"
      default: return "not_determined"
      }
    case "photos":
      switch PHPhotoLibrary.authorizationStatus(for: .readWrite) {
      case .authorized: return "authorized"
      case .limited: return "limited"
      case .denied, .restricted: return "denied"
      default: return "not_determined"
      }
    case "location", "weather":
      #if os(macOS)
        if capability == "weather" { return "unavailable" }
      #endif
      switch location.authorizationStatus {
      case .authorizedAlways, .authorizedWhenInUse: return "authorized"
      case .denied, .restricted: return "denied"
      default: return "not_determined"
      }
    case "notifications", "timer":
      let s = await UNUserNotificationCenter.current().notificationSettings()
      switch s.authorizationStatus {
      case .authorized, .provisional, .ephemeral: return "authorized"
      case .denied: return "denied"
      default: return "not_determined"
      }
    case "battery":
      #if os(iOS)
        return "authorized"
      #else
        return "unavailable"
      #endif
    case "health":
      #if os(iOS)
        return HKHealthStore.isHealthDataAvailable() ? "limited" : "unavailable"
      #else
        return "unavailable"
      #endif
    case "shortcut": return "authorized"
    default: return "unavailable"
    }
  }
  func request(_ capability: String) async throws {
    switch capability {
    case "calendar": _ = try await events.requestFullAccessToEvents()
    case "reminders": _ = try await events.requestFullAccessToReminders()
    case "contacts": _ = try await contacts.requestAccess(for: .contacts)
    case "photos": _ = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
    case "location", "weather": location.requestWhenInUseAuthorization()
    case "notifications", "timer":
      _ = try await UNUserNotificationCenter.current().requestAuthorization(options: [
        .alert, .sound, .badge,
      ])
    #if os(iOS)
      case "health":
        let types: Set<HKSampleType> = Set([
          HKQuantityType.quantityType(forIdentifier: .stepCount)!,
          HKQuantityType.quantityType(forIdentifier: .bodyMass)!,
          HKQuantityType.quantityType(forIdentifier: .heartRate)!,
        ])
        try await health.requestAuthorization(toShare: types, read: Set(types))
    #endif
    default: break
    }
  }
  private func denied(_ code: String = "system_permission_denied") -> APIError {
    APIError(status: 409, code: code)
  }
  private func date(_ v: JSONValue, _ fallback: Date? = nil) throws -> Date {
    try SystemActionInput.date(v, default: fallback)
  }
  private nonisolated func instant(_ d: Date?) -> JSONValue {
    d.map { .string(ISO8601DateFormatter().string(from: $0)) } ?? .null
  }
  private nonisolated func hash(_ value: JSONValue) -> String {
    let e = JSONEncoder()
    e.outputFormatting = [.sortedKeys]
    return SHA256.hash(data: (try? e.encode(value)) ?? Data()).map { String(format: "%02x", $0) }
      .joined()
  }
  private nonisolated func event(_ e: EKEvent) -> JSONValue {
    .object([
      "id": .string(e.eventIdentifier ?? ""), "title": .string(e.title ?? ""),
      "start": instant(e.startDate), "end": instant(e.endDate),
      "modified": instant(e.lastModifiedDate), "source": .string(e.calendar.title),
    ])
  }
  private nonisolated func reminder(_ e: EKReminder) -> JSONValue {
    .object([
      "id": .string(e.calendarItemIdentifier), "title": .string(e.title ?? ""),
      "completed": .bool(e.isCompleted), "modified": instant(e.lastModifiedDate),
      "source": .string(e.calendar.title),
    ])
  }
  private nonisolated func tagged(_ v: JSONValue) -> JSONValue {
    var o = v.object
    o["base_hash"] = .string(hash(v))
    return .object(o)
  }
  private func check(_ value: JSONValue, _ input: JSONValue) throws {
    if hash(value) != input["base_hash"].string { throw denied("external_conflict") }
  }
  func execute(_ action: String, _ p: JSONValue, id: String) async throws -> SystemOutcome {
    let capability = String(action.split(separator: ".")[0])
    let s = await state(capability)
    guard ["authorized", "limited"].contains(s) else {
      throw denied(s == "unavailable" ? "capability_unavailable" : "system_permission_denied")
    }
    if action.hasPrefix("calendar.") {
      if action != "calendar.create" && EKEventStore.authorizationStatus(for: .event) != .fullAccess
      {
        throw denied()
      }
      if action == "calendar.query" {
        let start = try date(p["start"], Date())
        let end = try date(p["end"], start.addingTimeInterval(86400))
        guard end > start, end.timeIntervalSince(start) <= 366 * 86400 else {
          throw denied("invalid_range")
        }
        return SystemOutcome(
          value: .array(
            events.events(
              matching: events.predicateForEvents(withStart: start, end: end, calendars: nil)
            ).prefix(500).map { tagged(event($0)) }))
      }
      let existing =
        action == "calendar.create" ? nil : events.event(withIdentifier: p["id"].string)
      if action != "calendar.create" {
        guard let existing else { throw denied("external_missing") }
        try check(event(existing), p)
      }
      let e = existing ?? EKEvent(eventStore: events)
      if action == "calendar.delete" {
        try events.remove(e, span: .thisEvent, commit: true)
        return SystemOutcome(externalID: p["id"].string, value: .object(["deleted": .bool(true)]))
      }
      guard !p["title"].string.isEmpty else { throw denied("invalid_request") }
      e.title = p["title"].string
      e.startDate = try date(p["start"])
      e.endDate = try date(p["end"], e.startDate.addingTimeInterval(3600))
      guard e.endDate > e.startDate else { throw denied("invalid_range") }
      if existing == nil { e.calendar = events.defaultCalendarForNewEvents }
      e.notes = "Echo 操作 " + id
      try events.save(e, span: .thisEvent, commit: true)
      return SystemOutcome(externalID: e.eventIdentifier, value: tagged(event(e)))
    }
    if action.hasPrefix("reminders.") {
      if action == "reminders.query" {
        let result: [JSONValue] = await withCheckedContinuation { c in
          events.fetchReminders(matching: events.predicateForReminders(in: nil)) { rows in
            c.resume(returning: (rows ?? []).prefix(500).map { self.tagged(self.reminder($0)) })
          }
        }
        return SystemOutcome(value: .array(result))
      }
      let existing =
        action == "reminders.create"
        ? nil : events.calendarItem(withIdentifier: p["id"].string) as? EKReminder
      if action != "reminders.create" {
        guard let existing else { throw denied("external_missing") }
        try check(reminder(existing), p)
      }
      let e = existing ?? EKReminder(eventStore: events)
      if action == "reminders.delete" {
        try events.remove(e, commit: true)
        return SystemOutcome(
          externalID: e.calendarItemIdentifier, value: .object(["deleted": .bool(true)]))
      }
      if action == "reminders.complete" {
        e.isCompleted = true
      } else {
        guard !p["title"].string.isEmpty else { throw denied("invalid_request") }
        e.title = p["title"].string
        if !p["due"].string.isEmpty {
          e.dueDateComponents = Calendar.current.dateComponents(
            [.year, .month, .day, .hour, .minute], from: try date(p["due"]))
        }
      }
      if existing == nil {
        e.calendar = events.defaultCalendarForNewReminders()
        e.notes = "Echo 操作 " + id
      }
      try events.save(e, commit: true)
      return SystemOutcome(externalID: e.calendarItemIdentifier, value: tagged(reminder(e)))
    }
    if action == "contacts.search" {
      guard !p["name"].string.isEmpty else { throw denied("invalid_request") }
      let rows = try contacts.unifiedContacts(
        matching: CNContact.predicateForContacts(matchingName: p["name"].string),
        keysToFetch: [
          CNContactIdentifierKey as CNKeyDescriptor, CNContactGivenNameKey as CNKeyDescriptor,
          CNContactFamilyNameKey as CNKeyDescriptor, CNContactPhoneNumbersKey as CNKeyDescriptor,
        ])
      return SystemOutcome(
        value: .array(
          rows.prefix(100).map {
            .object([
              "id": .string($0.identifier), "name": .string($0.familyName + $0.givenName),
              "phones": .array($0.phoneNumbers.map { .string($0.value.stringValue) }),
            ])
          }))
    }
    if action == "contacts.create" {
      guard !p["name"].string.isEmpty else { throw denied("invalid_request") }
      let c = CNMutableContact()
      c.givenName = p["name"].string
      if !p["phone"].string.isEmpty {
        c.phoneNumbers = [
          CNLabeledValue(
            label: CNLabelPhoneNumberMain, value: CNPhoneNumber(stringValue: p["phone"].string))
        ]
      }
      let request = CNSaveRequest()
      request.add(c, toContainerWithIdentifier: nil)
      try contacts.execute(request)
      return SystemOutcome(externalID: c.identifier, value: .object(["id": .string(c.identifier)]))
    }
    if action == "photos.query" {
      let options = PHFetchOptions()
      options.fetchLimit = 100
      options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
      let rows = PHAsset.fetchAssets(with: options)
      var values: [JSONValue] = []
      rows.enumerateObjects { a, _, _ in
        values.append(
          .object([
            "id": .string(a.localIdentifier),
            "created": a.creationDate.map { .string(ISO8601DateFormatter().string(from: $0)) }
              ?? .null, "width": .number(Double(a.pixelWidth)),
            "height": .number(Double(a.pixelHeight)),
          ]))
      }
      return SystemOutcome(value: .array(values))
    }
    if action == "location.query" || action == "weather.query" {
      let l = try await currentLocation()
      #if os(iOS)
        if action == "weather.query" {
          let w = try await WeatherService.shared.weather(for: l)
          return SystemOutcome(
            value: .object([
              "temperature_c": .number(w.currentWeather.temperature.converted(to: .celsius).value),
              "condition": .string(w.currentWeather.condition.rawValue),
              "source": .string("Apple Weather"),
            ]))
        }
      #endif
      return SystemOutcome(
        value: .object([
          "latitude": .number(l.coordinate.latitude), "longitude": .number(l.coordinate.longitude),
          "accuracy": .number(l.horizontalAccuracy),
        ]))
    }
    #if os(iOS)
      if action == "battery.query" {
        UIDevice.current.isBatteryMonitoringEnabled = true
        let level = UIDevice.current.batteryLevel
        guard level >= 0 else { throw denied("battery_unavailable") }
        return SystemOutcome(
          value: .object([
            "level": .number(Double(level)),
            "charging": .bool(UIDevice.current.batteryState == .charging),
          ]))
      }
      if action.hasPrefix("health.") { return try await healthAction(action, p, id: id) }
    #endif
    if ["notifications.create", "timer.create"].contains(action) {
      let c = UNMutableNotificationContent()
      c.title = p["title"].string
      c.body = p["body"].string
      c.sound = .default
      let seconds = Double(p["seconds"].int)
      guard seconds >= 1, seconds <= 31_536_000 else { throw denied("invalid_range") }
      let identifier = "echo-system-" + id
      try await UNUserNotificationCenter.current().add(
        UNNotificationRequest(
          identifier: identifier, content: c,
          trigger: UNTimeIntervalNotificationTrigger(timeInterval: seconds, repeats: false)))
      return SystemOutcome(
        externalID: identifier,
        value: .object([
          "notification_state": .string("scheduled"), "generation_state": .string("not_started"),
        ]))
    }
    if ["notifications.delete", "timer.delete"].contains(action) {
      guard p["id"].string.hasPrefix("echo-system-") else { throw denied("external_scope") }
      UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [
        p["id"].string
      ])
      UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [
        p["id"].string
      ])
      return SystemOutcome(externalID: p["id"].string, value: .object(["removed": .bool(true)]))
    }
    if action == "shortcut.run" {
      let registered = UserDefaults.standard.stringArray(forKey: "echo.registeredShortcuts") ?? []
      guard registered.contains(p["name"].string) else { throw denied("shortcut_unregistered") }
      var u = URLComponents()
      u.scheme = "shortcuts"
      u.host = "run-shortcut"
      u.queryItems = [
        URLQueryItem(name: "name", value: p["name"].string),
        URLQueryItem(name: "input", value: "text"),
        URLQueryItem(name: "text", value: p["input"].string),
      ]
      guard let url = u.url else { throw denied("invalid_request") }
      #if os(iOS)
        let opened = await UIApplication.shared.open(url)
      #else
        let opened = NSWorkspace.shared.open(url)
      #endif
      guard opened else { throw denied("shortcut_launch_failed") }
      return SystemOutcome(
        state: "unknown", externalID: id,
        value: .object(["launched": .bool(true), "completion": .string("unverified")]))
    }
    throw denied("capability_unavailable")
  }
  private func currentLocation() async throws -> CLLocation {
    guard locationWaiter == nil else { throw denied("location_busy") }
    return try await withCheckedThrowingContinuation { c in
      locationWaiter = c
      #if os(iOS)
        location.requestLocation()
      #else
        location.startUpdatingLocation()
      #endif
      locationTimeout = Task {
        try? await Task.sleep(for: .seconds(10))
        if Task.isCancelled { return }
        self.locationWaiter?.resume(throwing: self.denied("location_timeout"))
        self.locationWaiter = nil
        self.location.stopUpdatingLocation()
      }
    }
  }
  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    guard let l = locations.last else { return }
    locationTimeout?.cancel()
    locationWaiter?.resume(returning: l)
    locationWaiter = nil
    location.stopUpdatingLocation()
  }
  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    locationTimeout?.cancel()
    locationWaiter?.resume(throwing: error)
    locationWaiter = nil
    location.stopUpdatingLocation()
  }
  #if os(iOS)
    private func healthAction(_ action: String, _ p: JSONValue, id: String) async throws
      -> SystemOutcome
    {
      let spec: [String: (HKQuantityTypeIdentifier, HKUnit)] = [
        "steps": (.stepCount, .count()), "weight": (.bodyMass, .gramUnit(with: .kilo)),
        "heart_rate": (.heartRate, HKUnit.count().unitDivided(by: .minute())),
      ]
      guard let (identifier, unit) = spec[p["metric"].string],
        let type = HKQuantityType.quantityType(forIdentifier: identifier)
      else { throw denied("health_metric_unsupported") }
      if action == "health.write" {
        guard health.authorizationStatus(for: type) == .sharingAuthorized else { throw denied() }
        guard case .number(let v) = p["value"], v.isFinite, v >= 0 else {
          throw denied("invalid_request")
        }
        let sampleDate = try date(p["date"])
        let sample = HKQuantitySample(
          type: type, quantity: HKQuantity(unit: unit, doubleValue: v), start: sampleDate,
          end: sampleDate, metadata: [HKMetadataKeyExternalUUID: id])
        try await health.save(sample)
        return SystemOutcome(
          externalID: sample.uuid.uuidString,
          value: .object(["id": .string(sample.uuid.uuidString)]))
      }
      let predicate: NSPredicate
      if action == "health.delete" {
        guard let uuid = UUID(uuidString: p["id"].string) else { throw denied("invalid_request") }
        predicate = HKQuery.predicateForObject(with: uuid)
      } else {
        let start = try date(p["start"], Date().addingTimeInterval(-86400))
        let end = try date(p["end"], Date())
        guard end > start, end.timeIntervalSince(start) <= 366 * 86400 else {
          throw denied("invalid_range")
        }
        predicate = HKQuery.predicateForSamples(withStart: start, end: end)
      }
      let samples: [HKQuantitySample] = try await withCheckedThrowingContinuation { c in
        health.execute(
          HKSampleQuery(sampleType: type, predicate: predicate, limit: 100, sortDescriptors: nil) {
            _, rows, error in
            if let error {
              c.resume(throwing: error)
            } else {
              c.resume(returning: (rows as? [HKQuantitySample]) ?? [])
            }
          })
      }
      if action == "health.delete" {
        guard let sample = samples.first,
          sample.sourceRevision.source.bundleIdentifier == Bundle.main.bundleIdentifier,
          health.authorizationStatus(for: type) == .sharingAuthorized
        else { throw denied("health_delete_scope") }
        try await health.delete(sample)
        return SystemOutcome(
          externalID: sample.uuid.uuidString, value: .object(["deleted": .bool(true)]))
      }
      // HealthKit intentionally conceals read denials; an empty result is not evidence of zero.
      guard !samples.isEmpty else { throw denied("health_empty_or_denied") }
      return SystemOutcome(
        value: .array(
          samples.map {
            .object([
              "id": .string($0.uuid.uuidString),
              "value": .number($0.quantity.doubleValue(for: unit)), "date": instant($0.startDate),
              "source": .string($0.sourceRevision.source.name),
            ])
          }))
    }
  #endif
}
