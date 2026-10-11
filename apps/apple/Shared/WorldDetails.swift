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
          if !world["description"].string.isEmpty {
            Text(world["description"].string).font(EchoFont.body)
              .foregroundStyle(Color.echo.textSecondary).lineSpacing(EchoMetric.lineSpacing)
              .fixedSize(horizontal: false, vertical: true)
          }
          Button {
            edit = EditTarget(
              resource: "worlds", record: model.items("world").first { $0.id == world.id } ?? world)
          } label: {
            EchoSettingsRow(
              title: "编辑世界与玩家身份", subtitle: "设定背景，以及你在故事里的样子",
              symbol: "globe.asia.australia", color: Color.echo.primary)
          }
          Button {
            story = true
          } label: {
            EchoSettingsRow(
              title: "剧情与事件", subtitle: "看看故事走到了哪里",
              symbol: "text.book.closed", color: Color.echo.gold)
          }
          Button {
            autonomy = true
          } label: {
            EchoSettingsRow(
              title: "主动消息与自主互动", subtitle: "联系你的时机、角色互动与每日限额",
              symbol: "moon.stars", color: Color.echo.mauve)
          }.accessibilityIdentifier("open-autonomy")
          Button {
            recaps = true
          } label: {
            EchoSettingsRow(
              title: "离线回顾", subtitle: "你离开时，这个世界发生了什么",
              symbol: "clock.arrow.circlepath", color: Color.echo.gold)
          }.accessibilityIdentifier("open-recaps")
          Button {
            memory = true
          } label: {
            EchoSettingsRow(
              title: "记忆与来源", subtitle: "查看、修正与保留共同的经历",
              symbol: "book.closed", color: Color.echo.moss)
          }.accessibilityIdentifier("open-memory")
          Button {
            importing = true
          } label: {
            EchoSettingsRow(
              title: "导入角色卡或世界书", subtitle: "把熟悉的人物与设定带进来",
              symbol: "square.and.arrow.down", color: Color.echo.slate)
          }.accessibilityIdentifier("open-import")
        }.listRowBackground(Color.echo.surface)
        Section("世界角色") {
          ForEach(model.items("actor").filter { $0["world_id"].string == world.id }) { actor in
            Button {
              edit = EditTarget(resource: "actors", record: actor, world: world.id)
            } label: {
              HStack(spacing: EchoSpacing.sm) {
                EchoAvatar(name: actor.name, id: actor.id)
                Text(actor.name).font(EchoFont.body).foregroundStyle(Color.echo.textPrimary)
                Spacer()
                Image(systemName: "chevron.right").font(EchoFont.caption)
                  .foregroundStyle(Color.echo.textTertiary).accessibilityHidden(true)
              }.padding(.vertical, EchoSpacing.xxs)
            }
          }
          Button {
            edit = EditTarget(resource: "actors", world: world.id)
          } label: {
            EchoSettingsRow(
              title: "从模板添加角色", subtitle: "让一位新朋友加入这个世界",
              symbol: "person.badge.plus", color: Color.echo.primary)
          }
        }.listRowBackground(Color.echo.surface)
        Section("房间") {
          ForEach(model.items("room").filter { $0["world_id"].string == world.id }) { room in
            Button {
              edit = EditTarget(resource: "rooms", record: room, world: world.id)
            } label: {
              EchoSettingsRow(
                title: room.name,
                subtitle: room["kind"].string == "direct" ? "私聊" : "群聊",
                symbol: room["kind"].string == "direct"
                  ? "bubble.left" : "bubble.left.and.bubble.right",
                color: Color.echo.mauve)
            }
          }
          Button {
            edit = EditTarget(resource: "rooms", world: world.id)
          } label: {
            EchoSettingsRow(
              title: "新建私聊或群聊", subtitle: "选择这段对话的参与者",
              symbol: "plus.bubble", color: Color.echo.mauve)
          }
        }.listRowBackground(Color.echo.surface)
        Section("世界书") {
          ForEach(model.items("lore").filter { $0["world_id"].string == world.id }) { entry in
            Button {
              edit = EditTarget(resource: "lore", record: entry, world: world.id)
            } label: {
              EchoSettingsRow(
                title: entry.name, subtitle: "故事里的设定与背景",
                symbol: "book", color: Color.echo.moss)
            }
          }
          Button {
            edit = EditTarget(resource: "lore", world: world.id)
          } label: {
            EchoSettingsRow(
              title: "新建设定条目", subtitle: "记录世界的规则、地点与关系",
              symbol: "plus", color: Color.echo.moss)
          }
        }.listRowBackground(Color.echo.surface)
      }
      .buttonStyle(.plain)
      .scrollContentBackground(.hidden)
      .background(Color.echo.surfaceSunken)
      #if os(iOS)
        .listStyle(.insetGrouped)
      #else
        .listStyle(.inset)
      #endif
      .navigationTitle(world.name)
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button("完成") { dismiss() } } }
      .sheet(item: $edit) { EntityEditor(model: model, target: $0) }
      .sheet(isPresented: $story) { StoryView(model: model, world: world.id) }
      .sheet(isPresented: $memory) { MemoryView(model: model, world: world.id) }
      .sheet(isPresented: $autonomy) { AutonomyView(model: model, world: world.id) }
      .sheet(isPresented: $recaps) { RecapView(model: model, world: world.id) }
      .sheet(isPresented: $importing) { ImportView(model: model, world: world.id) }
    }.tint(Color.echo.primary)
      .frame(minWidth: 320, idealWidth: EchoMetric.formWidth, minHeight: 460)
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
          Button("确认或纠正剧情") { editing = true }.buttonStyle(.bordered)
        }.listRowBackground(Color.echo.surface)
        Section("来源事件") {
          ForEach(events) { event in
            VStack(alignment: .leading, spacing: EchoSpacing.xs) {
              Text(
                [
                  "character_claim": "角色声称", "user_message": "玩家发言", "user_correction": "玩家确认／纠正",
                  "regeneration": "换一种回答",
                ][event["kind"].string] ?? event["kind"].string
              ).font(EchoFont.headline).foregroundStyle(Color.echo.textPrimary)
              if let message = model.items("message").first(where: {
                $0.id == event["message_id"].string
              }) {
                Text(message["content"].string).font(EchoFont.body)
                  .lineSpacing(EchoMetric.lineSpacing).textSelection(.enabled)
              }
              if event["invalidated"].bool {
                Text("已失效").font(EchoFont.footnote).foregroundStyle(Color.echo.textSecondary)
              }
            }.padding(.vertical, EchoSpacing.xs)
          }
          if events.isEmpty {
            Text("还没有剧情事件。开始聊天后，发生过的故事会保存在这里。")
              .font(EchoFont.callout).foregroundStyle(Color.echo.textSecondary)
          }
        }.listRowBackground(Color.echo.surface)
      }
      .scrollContentBackground(.hidden)
      .background(Color.echo.surfaceSunken)
      #if os(iOS)
        .listStyle(.insetGrouped)
      #else
        .listStyle(.inset)
      #endif
      .navigationTitle("剧情与来源")
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button("完成") { dismiss() } } }
      .sheet(isPresented: $editing) {
        EntityEditor(
          model: model, target: EditTarget(resource: "state", record: state, world: world))
      }
    }.tint(Color.echo.primary)
      .frame(minWidth: 320, idealWidth: EchoMetric.formWidth, minHeight: 460)
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
      settingsList
        .buttonStyle(.plain)
        #if os(iOS)
          .listStyle(.insetGrouped)
        #else
          .listStyle(.inset)
        #endif
        .scrollContentBackground(.hidden)
        .background(Color.echo.surfaceSunken)
        .navigationTitle("设置")
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
    }
    .tint(Color.echo.primary)
    .frame(minWidth: 320, idealWidth: EchoMetric.formWidth, minHeight: 460)
  }

  private var settingsList: some View {
    List {
      connectionSection
      companionSection
      charactersSection
      advancedSection
      providersSection
      devicesSection
    }
  }

  private var connectionSection: some View {
    Section {
      connectionCard
    } footer: {
      Text("每个服务器分别保存聊天缓存、草稿和待发送内容。切换后，你可以继续回到原来的世界。")
        .font(EchoFont.footnote).foregroundStyle(Color.echo.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
    }.listRowBackground(Color.echo.surface)
  }

  private var companionSection: some View {
    Section("日常陪伴") {
      Button {
        notifications = true
      } label: {
        EchoSettingsRow(
          title: "通知", subtitle: "不错过新的消息与需要你决定的事",
          symbol: "bell.badge", color: Color.echo.gold)
      }.accessibilityIdentifier("open-notifications")
      Button {
        autonomy = true
      } label: {
        EchoSettingsRow(
          title: "自主总开关与预算", subtitle: "决定后台活动的范围和每日用量",
          symbol: "moon.stars", color: Color.echo.mauve)
      }
    }.listRowBackground(Color.echo.surface)
  }

  private var charactersSection: some View {
    Section("角色模板") {
      ForEach(model.items("character")) { character in
        Button {
          edit = EditTarget(resource: "characters", record: character)
        } label: {
          HStack(spacing: EchoSpacing.sm) {
            EchoAvatar(name: character.name, id: character.id)
            Text(character.name).font(EchoFont.body).foregroundStyle(Color.echo.textPrimary)
            Spacer()
            Image(systemName: "chevron.right").font(EchoFont.caption)
              .foregroundStyle(Color.echo.textTertiary).accessibilityHidden(true)
          }.padding(.vertical, EchoSpacing.xxs)
        }
      }
      Button {
        edit = EditTarget(resource: "characters")
      } label: {
        EchoSettingsRow(
          title: "新建角色模板", subtitle: "写下名字、性格与故事背景",
          symbol: "person.badge.plus", color: Color.echo.primary)
      }
    }.listRowBackground(Color.echo.surface)
  }

  private var advancedSection: some View {
    Section("高级") {
      Button {
        operations = true
      } label: {
        EchoSettingsRow(
          title: "数据与诊断", subtitle: "数据导出、设备缓存与运行情况",
          symbol: "externaldrive", color: Color.echo.graphite)
      }.accessibilityIdentifier("open-operations")
      Button {
        tools = true
      } label: {
        EchoSettingsRow(
          title: "MCP 连接与授权", subtitle: "管理外部工具及其可执行的操作",
          symbol: "puzzlepiece.extension", color: Color.echo.slate)
      }.accessibilityIdentifier("open-mcp")
      Button {
        activity = true
      } label: {
        EchoSettingsRow(
          title: "工具审批与运行记录", subtitle: "查看待你确认的操作和执行结果",
          symbol: "checkmark.shield", color: Color.echo.moss)
      }.accessibilityIdentifier("open-activity")
    }.listRowBackground(Color.echo.surface)
  }

  private var providersSection: some View {
    Section("模型连接") {
      ForEach(model.providers) { provider in
        EchoSettingsRow(
          title: provider.name, subtitle: provider["model"].string,
          symbol: "network", color: Color.echo.slate, disclosure: false)
      }
      Button {
        edit = EditTarget(resource: "providers")
      } label: {
        EchoSettingsRow(
          title: "添加模型连接", subtitle: "使用你自己的服务地址与 API Key",
          symbol: "plus", color: Color.echo.slate)
      }
    }.listRowBackground(Color.echo.surface)
  }

  private var devicesSection: some View {
    Section("已配对设备") {
      ForEach(model.devices) { device in
        ViewThatFits(in: .horizontal) {
          HStack(spacing: EchoSpacing.sm) {
            deviceName(device)
            Spacer()
            deviceAction(device)
          }
          VStack(alignment: .leading, spacing: EchoSpacing.xs) {
            deviceName(device)
            deviceAction(device)
          }
        }.padding(.vertical, EchoSpacing.xxs)
      }
    }.listRowBackground(Color.echo.surface)
  }

  private var connectionCard: some View {
    VStack(alignment: .leading, spacing: EchoSpacing.sm) {
      HStack(alignment: .top, spacing: EchoSpacing.sm) {
        HStack(alignment: .firstTextBaseline, spacing: EchoSpacing.xs) {
          Circle().fill(model.ready ? Color.echo.success : Color.echo.warning)
            .frame(width: EchoMetric.statusDot, height: EchoMetric.statusDot).accessibilityHidden(
              true)
          Text(model.status).font(EchoFont.headline).foregroundStyle(Color.echo.textPrimary)
            .fixedSize(horizontal: false, vertical: true)
        }
        Spacer(minLength: 0)
        Button("切换") {
          model.switchServer()
          dismiss()
        }.buttonStyle(.bordered).accessibilityLabel("切换服务器")
      }
      Text(model.connection?.url ?? "未连接")
        .font(EchoFont.footnote).monospacedDigit().foregroundStyle(Color.echo.textSecondary)
        .textSelection(.enabled)
    }.padding(.vertical, EchoSpacing.xs)
  }

  private func deviceName(_ device: Record) -> some View {
    Label(device.name, systemImage: "laptopcomputer.and.iphone")
      .font(EchoFont.body).foregroundStyle(Color.echo.textPrimary)
  }

  @ViewBuilder private func deviceAction(_ device: Record) -> some View {
    if device["revoked_at"] == .null {
      Button("撤销", role: .destructive) { revoking = device }
        .foregroundStyle(Color.echo.error)
        .accessibilityLabel("撤销设备「\(device.name)」")
    } else {
      Text("已撤销").font(EchoFont.footnote).foregroundStyle(Color.echo.textSecondary)
    }
  }
}
