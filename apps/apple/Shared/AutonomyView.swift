import CompanionCore
import SwiftUI

struct AutonomyView: View {
  var model: AppModel
  let world: String?
  @Environment(\.dismiss) private var dismiss
  @State private var fields: [String: JSONValue] = [:]
  @State private var revision = 1
  @State private var globalOn = false
  @State private var loaded = false
  @State private var busy = false
  @State private var failure: String?
  @State private var usage: JSONValue = .null
  @State private var globalSettings = false
  var body: some View {
    NavigationStack {
      Form {
        if loaded {
          Section("执行范围") {
            Toggle(world == nil ? "自主总开关" : "允许这个世界后台运行", isOn: flag("enabled"))
              .accessibilityIdentifier("autonomy-enabled")
            if let world {
              Text(globalOn ? "总开关已开启" : "总开关已关闭，本世界后台任务暂停").foregroundStyle(.secondary)
              Button("查看总开关与预算") { globalSettings = true }
              Toggle("整理记忆与语义索引", isOn: flag("memory"))
              Toggle("主动联系玩家", isOn: flag("contact"))
              Toggle("角色之间互动", isOn: flag("interaction"))
              Picker("执行房间", selection: string("room_id")) {
                Text("选择房间").tag("")
                ForEach(model.items("room").filter { $0["world_id"].string == world }) {
                  Text($0.name).tag($0.id)
                }
              }
              Stepper(
                "每次最多 \(fields["max_turns"]?.int ?? 3) 条角色消息", value: integer("max_turns"),
                in: 1...3)
              Stepper(
                "每天主动联系最多 \(fields["contact_daily"]?.int ?? 3) 次", value: integer("contact_daily"),
                in: 0...3)
              Stepper(
                "每天互动最多 \(fields["interaction_daily"]?.int ?? 4) 次",
                value: integer("interaction_daily"), in: 0...4)
              Stepper(
                "间隔 \(fields["interval_minutes"]?.int ?? 120) 分钟",
                value: integer("interval_minutes"), in: 120...10080, step: 30)
              TextField("安静开始 HH:mm", text: string("quiet_start"))
              TextField("安静结束 HH:mm", text: string("quiet_end"))
              Toggle("安静时段仍可推进角色互动", isOn: flag("quiet_interaction"))
              Text("记忆还需在「记忆与来源」中开启自动整理。主动联系和互动在最近发消息后的十分钟内暂停。")
                .font(.caption).foregroundStyle(.secondary)
            } else {
              TextField("时区", text: string("timezone"))
              Text("各世界及各类别需要分别开启。关闭总开关会阻止后台新步骤和迟到剧情；已经发出的外部请求仍需查看实际结果。")
                .font(.caption).foregroundStyle(.secondary)
            }
          }
          Section("现实工具权限") {
            Toggle("允许已授权的读取工具", isOn: flag("tools_read"))
            Toggle("允许已授权的写入工具", isOn: flag("tools_write"))
            Text("还需为具体角色授权工具。前台工具使用这些独立开关，写入默认逐次批准。剧情中的许可不会授予现实权限。")
              .font(.caption).foregroundStyle(.secondary)
          }
          Section("每日后台预算") {
            TextField("请求次数", value: integer("request_limit"), format: .number)
            TextField("输入 token 上限", value: integer("input_limit"), format: .number)
            TextField("输出 token 上限", value: integer("output_limit"), format: .number)
            if world != nil {
              TextField("每个类别的请求上限", value: integer("category_limit"), format: .number)
            }
            Text("记忆、语义查询和自主剧情共享预算；按设定时区结算。未知用量保留预留额度，服务器环境上限仍有效。")
              .font(.caption).foregroundStyle(.secondary)
          }
          if !usage["daily"].array.isEmpty {
            Section("近期用量 · 保守预留") {
              ForEach(Array(usage["daily"].array.prefix(7).enumerated()), id: \.offset) { _, day in
                Text(
                  "\(day["day"].string.prefix(10)) · \(day["requests"].int) 次 · 输入 \(day["input_tokens"].int) / 输出 \(day["output_tokens"].int)"
                ).font(.caption)
              }
              ForEach(Array(usage["items"].array.prefix(10).enumerated()), id: \.offset) {
                _, item in
                Text(
                  "\(item["kind"].string) · \(item["state"].string) · \(item["error_code"].string)"
                ).font(.caption)
              }
            }
          }
        } else {
          ProgressView()
        }
        if let failure { Text(failure).foregroundStyle(.red) }
      }
      .navigationTitle(world == nil ? "自主总开关与预算" : "世界自主行动")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button("保存") { Task { await save() } }.disabled(!loaded || busy).accessibilityIdentifier(
            "save-autonomy")
        }
      }
      .task { await load() }
      .sheet(isPresented: $globalSettings, onDismiss: { Task { await load() } }) {
        AutonomyView(model: model, world: nil)
      }
    }.frame(minWidth: 320, idealWidth: 600, minHeight: 480)
  }
  private func flag(_ key: String) -> Binding<Bool> {
    .init(get: { fields[key]?.bool ?? false }, set: { fields[key] = .bool($0) })
  }
  private func string(_ key: String) -> Binding<String> {
    .init(get: { fields[key]?.string ?? "" }, set: { fields[key] = .string($0) })
  }
  private func integer(_ key: String) -> Binding<Int> {
    .init(get: { fields[key]?.int ?? 0 }, set: { fields[key] = .number(Double($0)) })
  }
  private func load() async {
    do {
      let response = try await model.autonomy(
        action: world == nil ? "global" : "policy", id: world ?? "")
      let record = world == nil ? response : response["world"]
      fields = record.object
      revision = record["revision"].int
      globalOn = response["global"]["enabled"].bool
      usage = try await model.autonomy(action: "usage")
      loaded = true
    } catch { failure = error.localizedDescription }
  }
  private func save() async {
    busy = true
    defer { busy = false }
    var body = fields
    for key in [
      "id", "world_id", "revision", "last_status", "next_contact_at", "next_interaction_at",
      "recap_revision",
    ] { body.removeValue(forKey: key) }
    if world != nil && body["room_id"]?.string.isEmpty == true { body["room_id"] = .null }
    do {
      _ = try await model.autonomy(
        action: world == nil ? "saveGlobal" : "savePolicy", id: world ?? "", revision: revision,
        body: .object(body))
      dismiss()
    } catch { failure = error.localizedDescription }
  }
}

struct RecapView: View {
  var model: AppModel
  let world: String
  @Environment(\.dismiss) private var dismiss
  @State private var items: [Record] = []
  @State private var cursor = 0
  @State private var more = false
  @State private var source: Record?
  @State private var failure: String?
  var body: some View {
    NavigationStack {
      List {
        Text("以下是已经保存的角色发言，按实际发生顺序摘录。点击可跳到原文。").font(.caption).foregroundStyle(.secondary)
        if items.isEmpty { Text("还没有后台剧情或主动消息。") }
        ForEach(items) { item in
          Button {
            source = item
          } label: {
            VStack(alignment: .leading, spacing: 6) {
              Text(item["actor_name"].string + (item["unread"].bool ? " · 未读" : "")).font(.headline)
              Text(displayDate(item["created_at"].string)).font(.caption).foregroundStyle(
                .secondary)
              Text(item["content"].string).foregroundStyle(.primary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
          }.buttonStyle(.plain).accessibilityIdentifier("recap-item")
        }
        if more { Button("加载更多") { Task { await load() } } }
        if let failure { Text(failure).foregroundStyle(.red) }
      }.navigationTitle("离线回顾")
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("完成") { dismiss() } }
          ToolbarItem {
            Button("标记已读") {
              Task {
                do {
                  _ = try await model.autonomy(action: "readRecaps", id: world, revision: cursor)
                  items = []
                  cursor = 0
                  await load()
                } catch { failure = error.localizedDescription }
              }
            }.disabled(items.isEmpty)
          }
        }
        .task { await load() }
        .sheet(item: $source) { item in
          NavigationStack {
            if let room = model.items("room").first(where: { $0.id == item["room_id"].string }) {
              ChatView(model: model, room: room, sourceMessage: item.id)
                .toolbar {
                  ToolbarItem(placement: .cancellationAction) { Button("返回回顾") { source = nil } }
                }
            }
          }
        }
    }.frame(minWidth: 320, idealWidth: 640, minHeight: 480)
  }
  private func load() async {
    do {
      let page = try await model.autonomy(
        action: "recaps", id: world, body: .object(["after": .number(Double(cursor))]))
      items += page["items"].array.map { Record(kind: "recap", value: $0) }
      cursor = page["next_revision"].int
      more = page["has_more"].bool
    } catch { failure = error.localizedDescription }
  }
}
