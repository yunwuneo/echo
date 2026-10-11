import CompanionCore
import SwiftUI

struct WorldDetails: View {
  var model: AppModel
  let world: Record
  @Environment(\.dismiss) private var dismiss
  @State private var edit: EditTarget?
  @State private var story = false
  @State private var memory = false
  @State private var importing = false
  @State private var autonomy = false
  @State private var recaps = false
  var body: some View {
    NavigationStack {
      List {
        Section {
          Text(world["description"].string)
          Button("编辑世界与玩家身份") {
            edit = EditTarget(
              resource: "worlds", record: model.items("world").first { $0.id == world.id } ?? world)
          }
          Button("查看剧情与事件") { story = true }
          Button("自主行动与限额") { autonomy = true }.accessibilityIdentifier("open-autonomy")
          Button("离线回顾") { recaps = true }.accessibilityIdentifier("open-recaps")
          Button("记忆与来源") { memory = true }.accessibilityIdentifier("open-memory")
          Button("导入角色卡或世界书") { importing = true }.accessibilityIdentifier("open-import")
        }
        Section("世界角色") {
          ForEach(model.items("actor").filter { $0["world_id"].string == world.id }) { actor in
            Button(actor.name) {
              edit = EditTarget(resource: "actors", record: actor, world: world.id)
            }
          }
          Button("从模板添加角色") { edit = EditTarget(resource: "actors", world: world.id) }
        }
        Section("房间") {
          ForEach(model.items("room").filter { $0["world_id"].string == world.id }) { room in
            Button(room.name) {
              edit = EditTarget(resource: "rooms", record: room, world: world.id)
            }
          }
          Button("新建私聊或群聊") { edit = EditTarget(resource: "rooms", world: world.id) }
        }
        Section("世界书") {
          ForEach(model.items("lore").filter { $0["world_id"].string == world.id }) { entry in
            Button(entry.name) {
              edit = EditTarget(resource: "lore", record: entry, world: world.id)
            }
          }
          Button("新建设定条目") { edit = EditTarget(resource: "lore", world: world.id) }
        }
      }.navigationTitle(world.name)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("完成") { dismiss() } } }
        .sheet(item: $edit) { EntityEditor(model: model, target: $0) }
        .sheet(isPresented: $story) { StoryView(model: model, world: world.id) }
        .sheet(isPresented: $memory) { MemoryView(model: model, world: world.id) }
        .sheet(isPresented: $autonomy) { AutonomyView(model: model, world: world.id) }
        .sheet(isPresented: $recaps) { RecapView(model: model, world: world.id) }
        .sheet(isPresented: $importing) { ImportView(model: model, world: world.id) }
    }.frame(minWidth: 320, idealWidth: 560, minHeight: 460)
  }
}
struct StoryView: View {
  var model: AppModel
  let world: String
  @Environment(\.dismiss) private var dismiss
  @State private var editing = false
  private var state: Record? { model.items("state").first { $0.id == world } }
  private var events: [Record] {
    model.items("world_event").filter { $0["world_id"].string == world }.sorted {
      $0["revision"].int > $1["revision"].int
    }
  }
  var body: some View {
    NavigationStack {
      List {
        Section("已确认剧情") {
          LabeledContent("地点", value: state?["data"]["location"].string ?? "")
          LabeledContent("剧情时间", value: state?["data"]["time"].string ?? "")
          Text(state?["data"]["open_topics"].array.map(\.string).joined(separator: "\n") ?? "")
          Button("确认或纠正剧情") { editing = true }
        }
        Section("来源事件") {
          ForEach(events) { event in
            VStack(alignment: .leading, spacing: 5) {
              Text(
                [
                  "character_claim": "角色声称", "user_message": "玩家发言", "user_correction": "玩家确认／纠正",
                  "regeneration": "受限重生成",
                ][event["kind"].string] ?? event["kind"].string
              ).font(.headline)
              if let message = model.items("message").first(where: {
                $0.id == event["message_id"].string
              }) {
                Text(message["content"].string).textSelection(.enabled)
              }
              if event["invalidated"].bool { Text("已失效").foregroundStyle(.secondary) }
            }
          }
        }
      }.navigationTitle("剧情与来源")
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("完成") { dismiss() } } }
        .sheet(isPresented: $editing) {
          EntityEditor(
            model: model, target: EditTarget(resource: "state", record: state, world: world))
        }
    }.frame(minWidth: 320, idealWidth: 560, minHeight: 460)
  }
}
struct SettingsView: View {
  var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var edit: EditTarget?
  @State private var notifications = false
  @State private var operations = false
  @State private var revoking: Record?
  @State private var autonomy = false
  @State private var tools = false
  @State private var activity = false
  var body: some View {
    NavigationStack {
      List {
        Section("服务器") {
          Text(model.connection?.url ?? "").textSelection(.enabled)
          Text(model.status).foregroundStyle(.secondary)
          Button("切换服务器") {
            model.switchServer()
            dismiss()
          }
          Text("各服务器的缓存、草稿和待发送内容分别保存。切换后不会发送到其他实例。").font(.caption)
        }
        Section("通知与数据") {
          Button("通知") { notifications = true }.accessibilityIdentifier("open-notifications")
          Button("数据与诊断") { operations = true }.accessibilityIdentifier("open-operations")
        }
        Section("后台与工具") {
          Button("自主总开关与预算") { autonomy = true }
          Button("MCP 连接与授权") { tools = true }.accessibilityIdentifier("open-mcp")
          Button("工具审批与运行记录") { activity = true }.accessibilityIdentifier("open-activity")
        }
        Section("模型连接") {
          ForEach(model.providers) { provider in
            VStack(alignment: .leading) {
              Text(provider.name)
              Text(provider["model"].string).font(.caption).foregroundStyle(.secondary)
            }
          }
          Button("添加模型连接") { edit = EditTarget(resource: "providers") }
        }
        Section("角色模板") {
          ForEach(model.items("character")) { character in
            Button(character.name) { edit = EditTarget(resource: "characters", record: character) }
          }
          Button("新建角色模板") { edit = EditTarget(resource: "characters") }
        }
        Section("已配对设备") {
          ForEach(model.devices) { device in
            HStack {
              Text(device.name)
              Spacer()
              if device["revoked_at"] == .null {
                Button("撤销", role: .destructive) { revoking = device }
              } else {
                Text("已撤销").foregroundStyle(.secondary)
              }
            }
          }
        }
      }.navigationTitle("设置")
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("完成") { dismiss() }.accessibilityIdentifier("close-settings")
          }
        }
        .task { do { try await model.refreshSettings() } catch { model.report(error) } }
        .sheet(item: $edit) { EntityEditor(model: model, target: $0) }
        .sheet(isPresented: $notifications) { NotificationsView(model: model) }
        .sheet(isPresented: $operations) { OperationsView(model: model) }
        .sheet(isPresented: $autonomy) { AutonomyView(model: model, world: nil) }
        .sheet(isPresented: $tools) { MCPView(model: model) }
        .sheet(isPresented: $activity) { ToolActivityView(model: model) }
        .confirmationDialog(
          "撤销设备后，需要新的配对码才能再次连接。",
          isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }),
          titleVisibility: .visible
        ) {
          Button("撤销设备", role: .destructive) {
            guard let device = revoking else { return }
            Task {
              do { try await model.revoke(id: device.id) } catch { model.report(error) }
              revoking = nil
            }
          }
        }
    }.frame(minWidth: 320, idealWidth: 560, minHeight: 460)
  }
}
