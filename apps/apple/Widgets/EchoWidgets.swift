import CompanionCore
import SwiftUI
import WidgetKit

struct StatusEntry: TimelineEntry {
  let date: Date
  let status: String
  let count: Int
  let updated: Date?
}
struct StatusProvider: TimelineProvider {
  func placeholder(in context: Context) -> StatusEntry {
    StatusEntry(date: Date(), status: "尚未同步", count: 0, updated: nil)
  }
  func getSnapshot(in context: Context, completion: @escaping (StatusEntry) -> Void) {
    completion(read())
  }
  func getTimeline(in context: Context, completion: @escaping (Timeline<StatusEntry>) -> Void) {
    completion(Timeline(entries: [read()], policy: .after(Date().addingTimeInterval(300))))
  }
  private func read() -> StatusEntry {
    guard
      let base = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: "group.dev.echo2.companion"),
      let data = try? Data(contentsOf: base.appendingPathComponent("status.json")),
      let value = try? JSONDecoder().decode(JSONValue.self, from: data),
      case .number(let t) = value["updated"]
    else { return StatusEntry(date: Date(), status: "尚未同步", count: 0, updated: nil) }
    let time = Date(timeIntervalSince1970: t)
    return StatusEntry(
      date: Date(), status: Date().timeIntervalSince(time) > 300 ? "状态待刷新" : value["status"].string,
      count: value["count"].int, updated: time)
  }
}
struct EchoStatusWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "EchoTaskStatus", provider: StatusProvider()) { e in
      VStack(alignment: .leading) {
        Text("Echo").font(.headline)
        Text(e.status)
        if e.updated != nil {
          Text("最近同步任务 \(e.count)")
          Text(e.updated!, style: .relative).font(.caption)
        }
      }.containerBackground(.fill.tertiary, for: .widget)
    }.configurationDisplayName("Echo 任务状态").description("显示最近一次确认的状态，过期时标记待刷新。").supportedFamilies([
      .systemSmall, .systemMedium,
    ])
  }
}
@main struct EchoWidgets: WidgetBundle { var body: some Widget { EchoStatusWidget() } }
