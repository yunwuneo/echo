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
  @State private var documents = false
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
              title: String(localized: "编辑 TA 的设定与玩家身份"),
              subtitle: String(localized: "设定背景，以及你在故事里的样子"),
              symbol: "globe.asia.australia", color: Color.echo.primary)
          }
          Button {
            story = true
          } label: {
            EchoSettingsRow(
              title: String(localized: "剧情与事件"), subtitle: String(localized: "看看故事走到了哪里"),
              symbol: "text.book.closed", color: Color.echo.gold)
          }
          Button {
            autonomy = true
          } label: {
            EchoSettingsRow(
              title: String(localized: "主动消息与自主互动"),
              subtitle: String(localized: "联系你的时机、角色互动与每日限额"),
              symbol: "moon.stars", color: Color.echo.mauve)
          }.accessibilityIdentifier("open-autonomy")
          Button {
            recaps = true
          } label: {
            EchoSettingsRow(
              title: String(localized: "离线回顾"), subtitle: String(localized: "你离开时，故事里发生了什么"),
              symbol: "clock.arrow.circlepath", color: Color.echo.gold)
          }.accessibilityIdentifier("open-recaps")
          Button {
            memory = true
          } label: {
            EchoSettingsRow(
              title: String(localized: "记忆与来源"), subtitle: String(localized: "查看、修正与保留共同的经历"),
              symbol: "book.closed", color: Color.echo.moss)
          }.accessibilityIdentifier("open-memory")
          Button {
            importing = true
          } label: {
            EchoSettingsRow(
              title: String(localized: "导入角色卡或设定集"), subtitle: String(localized: "把熟悉的人物与设定带进来"),
              symbol: "square.and.arrow.down", color: Color.echo.slate)
          }.accessibilityIdentifier("open-import")
        }.listRowBackground(Color.echo.surface)
        Button("项目与文档") { documents = true }
        Section(String(localized: "设定中的角色")) {
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
              title: String(localized: "从模板添加角色"), subtitle: String(localized: "让一位新朋友加入这段故事"),
              symbol: "person.badge.plus", color: Color.echo.primary)
          }
        }.listRowBackground(Color.echo.surface)
        Section(String(localized: "房间")) {
          ForEach(model.items("room").filter { $0["world_id"].string == world.id }) { room in
            Button {
              edit = EditTarget(resource: "rooms", record: room, world: world.id)
            } label: {
              EchoSettingsRow(
                title: room.name,
                subtitle: room["kind"].string == "direct"
                  ? String(localized: "私聊") : String(localized: "群聊"),
                symbol: room["kind"].string == "direct"
                  ? "bubble.left" : "bubble.left.and.bubble.right",
                color: Color.echo.mauve)
            }
          }
          Button {
            edit = EditTarget(resource: "rooms", world: world.id)
          } label: {
            EchoSettingsRow(
              title: String(localized: "新建私聊或群聊"), subtitle: String(localized: "选择这段对话的参与者"),
              symbol: "plus.bubble", color: Color.echo.mauve)
          }
        }.listRowBackground(Color.echo.surface)
        Section(String(localized: "设定集")) {
          ForEach(model.items("lore").filter { $0["world_id"].string == world.id }) { entry in
            Button {
              edit = EditTarget(resource: "lore", record: entry, world: world.id)
            } label: {
              EchoSettingsRow(
                title: entry.name, subtitle: String(localized: "故事里的设定与背景"),
                symbol: "book", color: Color.echo.moss)
            }
          }
          Button {
            edit = EditTarget(resource: "lore", world: world.id)
          } label: {
            EchoSettingsRow(
              title: String(localized: "新建设定条目"), subtitle: String(localized: "记录故事的规则、地点与关系"),
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
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button(String(localized: "完成")) { dismiss() }
        }
      }
      .sheet(item: $edit) { EntityEditor(model: model, target: $0) }
      .sheet(isPresented: $story) { StoryView(model: model, world: world.id) }
      .sheet(isPresented: $documents) { DocumentLibraryView(model: model, worldID: world.id) }
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
        Section(String(localized: "已确认剧情")) {
          LabeledContent(String(localized: "地点"), value: state?["data"]["location"].string ?? "")
          LabeledContent(String(localized: "剧情时间"), value: state?["data"]["time"].string ?? "")
          Text(state?["data"]["open_topics"].array.map(\.string).joined(separator: "\n") ?? "")
          Button(String(localized: "确认或纠正剧情")) { editing = true }.buttonStyle(.bordered)
        }.listRowBackground(Color.echo.surface)
        Section(String(localized: "来源事件")) {
          ForEach(events) { event in
            VStack(alignment: .leading, spacing: EchoSpacing.xs) {
              Text(
                [
                  "character_claim": String(localized: "角色声称"),
                  "user_message": String(localized: "玩家发言"),
                  "user_correction": String(localized: "玩家确认／纠正"),
                  "regeneration": String(localized: "换一种回答"),
                ][event["kind"].string] ?? event["kind"].string
              ).font(EchoFont.headline).foregroundStyle(Color.echo.textPrimary)
              if let message = model.items("message").first(where: {
                $0.id == event["message_id"].string
              }) {
                Text(message["content"].string).font(EchoFont.body)
                  .lineSpacing(EchoMetric.lineSpacing).textSelection(.enabled)
              }
              if event["invalidated"].bool {
                Text(String(localized: "已失效")).font(EchoFont.footnote).foregroundStyle(
                  Color.echo.textSecondary)
              }
            }.padding(.vertical, EchoSpacing.xs)
          }
          if events.isEmpty {
            Text(String(localized: "还没有剧情事件。开始聊天后，发生过的故事会保存在这里。"))
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
      .navigationTitle(String(localized: "剧情与来源"))
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button(String(localized: "完成")) { dismiss() }
        }
      }
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
  var embedded = false
  @AppStorage("echo.appearance") private var appearance = "system"
  @State private var selectedWorld: Record?
  @State private var memoryWorld: Record?
  @State private var importWorld: Record?
  @Environment(\.dismiss) private var dismiss
  @State private var edit: EditTarget?
  @State private var notifications = false
  @State private var operations = false
  @State private var revoking: Record?
  @State private var autonomy = false
  @State private var tools = false
  @State private var activity = false

  var body: some View {
    Group {
      if embedded {
        content
      } else {
        NavigationStack { content }
          .frame(minWidth: 320, idealWidth: EchoMetric.formWidth, minHeight: 460)
      }
    }.tint(Color.echo.primary)
  }

  private var content: some View {
    settingsList
      .buttonStyle(.plain)
      #if os(iOS)
        .listStyle(.insetGrouped)
      #else
        .listStyle(.inset)
      #endif
      .scrollContentBackground(.hidden)
      .background(Color.echo.surfaceSunken)
      .navigationTitle(embedded ? String(localized: "我") : String(localized: "设置"))
      .toolbar {
        if !embedded {
          ToolbarItem(placement: .cancellationAction) {
            Button(String(localized: "完成")) { dismiss() }.accessibilityIdentifier("close-settings")
          }
        }
      }
      .task { do { try await model.refreshSettings() } catch { model.report(error) } }
      .sheet(item: $selectedWorld) { WorldDetails(model: model, world: $0) }
      .sheet(item: $memoryWorld) { MemoryView(model: model, world: $0.id) }
      .sheet(item: $importWorld) { ImportView(model: model, world: $0.id) }
      .sheet(item: $edit) { EntityEditor(model: model, target: $0) }
      .sheet(isPresented: $notifications) { NotificationsView(model: model) }
      .sheet(isPresented: $operations) { OperationsView(model: model) }
      .sheet(isPresented: $autonomy) { AutonomyView(model: model, world: nil) }
      .sheet(isPresented: $tools) { MCPView(model: model) }
      .sheet(isPresented: $activity) { ToolActivityView(model: model) }
      .confirmationDialog(
        String(localized: "撤销设备后，需要新的配对码才能再次连接。"),
        isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }),
        titleVisibility: .visible
      ) {
        Button(String(localized: "撤销设备"), role: .destructive) {
          guard let device = revoking else { return }
          Task {
            do { try await model.revoke(id: device.id) } catch { model.report(error) }
            revoking = nil
          }
        }
      }
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
      Text(String(localized: "每个服务器分别保存聊天缓存、草稿和待发送内容。切换后，你可以继续回到原来的设定。"))
        .font(EchoFont.footnote).foregroundStyle(Color.echo.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
    }.listRowBackground(Color.echo.surface)
  }

  private var companionSection: some View {
    Section(String(localized: "日常陪伴")) {
      Button {
        notifications = true
      } label: {
        EchoSettingsRow(
          title: String(localized: "通知"), subtitle: String(localized: "不错过新的消息与需要你决定的事"),
          symbol: "bell.badge", color: Color.echo.gold)
      }.accessibilityIdentifier("open-notifications")
      Picker(selection: $appearance) {
        Text(String(localized: "跟随系统")).tag("system")
        Text(String(localized: "浅色")).tag("light")
        Text(String(localized: "深色")).tag("dark")
      } label: {
        EchoSettingsRow(
          title: String(localized: "外观"), subtitle: String(localized: "选择适合此刻的明暗"),
          symbol: "circle.lefthalf.filled", color: Color.echo.graphite, disclosure: false)
      }.accessibilityIdentifier("appearance-picker")
    }.listRowBackground(Color.echo.surface)
  }

  private var charactersSection: some View {
    Section(String(localized: "角色模板")) {
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
          title: String(localized: "新建角色模板"), subtitle: String(localized: "写下名字、性格与故事背景"),
          symbol: "person.badge.plus", color: Color.echo.primary)
      }
    }.listRowBackground(Color.echo.surface)
  }

  private var advancedSection: some View {
    Section(String(localized: "高级")) {
      Menu {
        ForEach(model.items("world")) { world in
          Button(world.name) { selectedWorld = world }
        }
        Button(String(localized: "新建 TA 的设定")) { edit = EditTarget(resource: "worlds") }
      } label: {
        EchoSettingsRow(
          title: String(localized: "TA 的设定与设定集"), subtitle: String(localized: "故事背景、共同设定与角色"),
          symbol: "book.closed", color: Color.echo.moss)
      }.accessibilityIdentifier("open-settings-worlds")
      Menu {
        ForEach(model.items("world")) { world in
          Button(world.name) { memoryWorld = world }
        }
      } label: {
        EchoSettingsRow(
          title: String(localized: "记忆与来源"), subtitle: String(localized: "核对原文、修正记忆与整理规则"),
          symbol: "text.book.closed", color: Color.echo.moss)
      }.disabled(model.items("world").isEmpty).accessibilityIdentifier("open-memory-sources")
      Menu {
        ForEach(model.items("world")) { world in
          Button(world.name) { importWorld = world }
        }
      } label: {
        EchoSettingsRow(
          title: String(localized: "导入角色与设定集"), subtitle: String(localized: "选择要导入的 TA 的设定"),
          symbol: "square.and.arrow.down", color: Color.echo.slate)
      }.disabled(model.items("world").isEmpty).accessibilityIdentifier("open-import")
      Button {
        autonomy = true
      } label: {
        EchoSettingsRow(
          title: String(localized: "自主总开关与预算"), subtitle: String(localized: "决定后台活动的范围和每日用量"),
          symbol: "moon.stars", color: Color.echo.mauve)
      }
      Button {
        operations = true
      } label: {
        EchoSettingsRow(
          title: String(localized: "数据与诊断"), subtitle: String(localized: "数据导出、设备缓存与运行情况"),
          symbol: "externaldrive", color: Color.echo.graphite)
      }.accessibilityIdentifier("open-operations")
      Button {
        tools = true
      } label: {
        EchoSettingsRow(
          title: String(localized: "MCP 连接与授权"), subtitle: String(localized: "管理外部工具及其可执行的操作"),
          symbol: "puzzlepiece.extension", color: Color.echo.slate)
      }.accessibilityIdentifier("open-mcp")
      Button {
        activity = true
      } label: {
        EchoSettingsRow(
          title: String(localized: "工具审批与运行记录"), subtitle: String(localized: "查看待你确认的操作和执行结果"),
          symbol: "checkmark.shield", color: Color.echo.moss)
      }.accessibilityIdentifier("open-activity")
    }.listRowBackground(Color.echo.surface)
  }

  private var providersSection: some View {
    Section(String(localized: "模型连接")) {
      ForEach(model.providers) { provider in
        Button {
          edit = EditTarget(resource: "providers", record: provider)
        } label: {
          EchoSettingsRow(
            title: provider.name, subtitle: provider["model"].string,
            symbol: "network", color: Color.echo.slate)
        }
      }
      Button {
        edit = EditTarget(resource: "providers")
      } label: {
        EchoSettingsRow(
          title: String(localized: "添加模型连接"), subtitle: String(localized: "使用你自己的服务地址与 API Key"),
          symbol: "plus", color: Color.echo.slate)
      }
    }.listRowBackground(Color.echo.surface)
  }

  private var devicesSection: some View {
    Section(String(localized: "已配对设备")) {
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
        Button(String(localized: "切换")) {
          model.switchServer()
          if !embedded { dismiss() }
        }.buttonStyle(.bordered).accessibilityLabel(String(localized: "切换服务器"))
      }
      Text(model.connection?.url ?? String(localized: "未连接"))
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
      Button(String(localized: "撤销"), role: .destructive) { revoking = device }
        .foregroundStyle(Color.echo.error)
        .accessibilityLabel(String(localized: "撤销设备「\(device.name)」"))
    } else {
      Text(String(localized: "已撤销")).font(EchoFont.footnote).foregroundStyle(
        Color.echo.textSecondary)
    }
  }
}
