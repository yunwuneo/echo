import CompanionCore
import SwiftUI

struct FoundationView: View {
  @State private var model: AppModel?
  @State private var startupError: String?
  @AppStorage("echo.appearance") private var appearance = "system"
  private var preferredAppearance: ColorScheme? {
    appearance == "dark" ? .dark : appearance == "light" ? .light : nil
  }
  var body: some View {
    Group {
      if let model {
        CompanionWorkspace(model: model)
      } else if let startupError {
        ContentUnavailableView(
          String(localized: "无法打开本地缓存"), systemImage: "externaldrive.badge.exclamationmark",
          description: Text(startupError))
      } else {
        ProgressView(String(localized: "打开聊天…"))
      }
    }
    .tint(Color.echo.primary)
    .foregroundStyle(Color.echo.textPrimary)
    .background(Color.echo.bg)
    #if DEBUG
      .preferredColorScheme(
        ProcessInfo.processInfo.environment["ECHO2_UI_TEST_DARK"] == "1"
          ? .dark : preferredAppearance)
    #else
      .preferredColorScheme(preferredAppearance)
    #endif
    .task {
      guard model == nil else { return }
      do {
        let app = AppModel(cache: try CacheStore())
        model = app
        #if os(iOS)
        SystemBackground.model = app
        #endif
        #if DEBUG
          if let raw = ProcessInfo.processInfo.environment["ECHO2_UI_TEST_PUSH"],
            let data = raw.data(using: .utf8),
            let event = try? JSONDecoder().decode(JSONValue.self, from: data)
          {
            PushCoordinator.shared.event = event
            PushCoordinator.shared.eventRevision += 1
          }
          if ProcessInfo.processInfo.environment["ECHO2_UI_TEST_RESET"] == "1" {
            app.switchServer()
          } else {
            await app.restore()
          }
        #else
          await app.restore()
        #endif
      } catch { startupError = userFacingError(error) }
    }
  }
}

struct CompanionWorkspace: View {
  @Environment(\.scenePhase) private var scenePhase
  @Bindable var model: AppModel
  @State private var notificationSource: String?
  @State private var selectedRoom: String?
  @State private var settings = false
  @State private var edit: EditTarget?
  @State private var worldDetails: Record?
  @State private var importingWorld: Record?
  var body: some View {
    Group {
      if model.connection == nil {
        ConnectionView(model: model)
      } else {
        #if os(iOS)
          RootView(
            model: model, selectedRoom: $selectedRoom, notificationSource: notificationSource)
        #else
          NavigationSplitView {
            sidebar
              .navigationTitle(String(localized: "聊天"))
              .toolbar {
                ToolbarItem {
                  Menu {
                    Button(String(localized: "新建 TA 的设定"), systemImage: "globe.asia.australia") {
                      edit = EditTarget(resource: "worlds")
                    }
                    Button(String(localized: "新建角色模板"), systemImage: "person.badge.plus") {
                      edit = EditTarget(resource: "characters")
                    }
                    ForEach(model.items("world")) { world in
                      Button(String(localized: "在「\(world.name)」开始聊天")) {
                        edit = EditTarget(resource: "rooms", world: world.id)
                      }
                      Button(String(localized: "TA 的设定 · \(world.name)")) { worldDetails = world }
                    }
                    if !model.items("world").isEmpty {
                      Menu(String(localized: "导入角色卡或设定集")) {
                        ForEach(model.items("world")) { world in
                          Button(world.name) { importingWorld = world }
                        }
                      }
                    }
                  } label: {
                    Label(String(localized: "新建"), systemImage: "plus")
                  }.help(String(localized: "新建 TA 的设定、角色，或导入角色卡"))
                }
                ToolbarItem {
                  Button {
                    settings = true
                  } label: {
                    Label(String(localized: "设置"), systemImage: "gearshape")
                  }.help(String(localized: "服务器、通知与设置"))
                }
              }
              .navigationSplitViewColumnWidth(min: 220, ideal: 260, max: 320)
          } detail: {
            if let room = model.items("room").first(where: { $0.id == selectedRoom }) {
              ChatView(model: model, room: room, sourceMessage: notificationSource).id(
                room.id + (notificationSource ?? ""))
            } else {
              VStack(spacing: EchoSpacing.xs) {
                if let world = model.items("world").first {
                  EchoEmptyState(
                    title: String(localized: "故事在这里继续"),
                    description: String(localized: "从左侧选一段私聊或群聊，也可以开启一段新的相遇。"),
                    actionTitle: String(localized: "新建私聊或群聊")
                  ) { edit = EditTarget(resource: "rooms", world: world.id) }
                  Button(String(localized: "导入角色卡或设定集")) { importingWorld = world }
                    .buttonStyle(.borderless)
                } else {
                  EchoEmptyState(
                    title: String(localized: "许多相遇，许多故事"),
                    description: String(localized: "为你们留下一片天地，认识角色，让故事从第一句话开始。"),
                    symbol: "globe.asia.australia", actionTitle: String(localized: "创建 TA 的设定")
                  ) { edit = EditTarget(resource: "worlds") }
                }
              }
              .frame(maxWidth: .infinity, maxHeight: .infinity)
              .background(Color.echo.bg)

            }
          }
        #endif
      }
    }
    .task(id: "\(model.connection?.namespace ?? ""):\(model.ready):\(PushCoordinator.shared.token)")
    {
      if model.ready && !PushCoordinator.shared.token.isEmpty {
        do { try await model.updatePushToken(PushCoordinator.shared.token) } catch {
          PushCoordinator.shared.registrationError = String(localized: "推送地址更新失败，请在通知设置中重新绑定。")
        }
      }
    }
    .task(
      id:
        "\(model.ready):\(PushCoordinator.shared.eventRevision):\(model.connection?.namespace ?? "")"
    ) {
      let push = PushCoordinator.shared
      guard model.ready, let saved = model.connection, push.event != .null else { return }
      guard push.event["server_instance_id"].string == saved.instance,
        push.event["data_epoch"].string == saved.epoch
      else {
        model.error = String(localized: "此通知来自其他服务器或旧恢复版本，请连接对应服务器后查看。")
        push.event = .null
        return
      }
      do {
        let route = try await model.operations(
          action: "resolvePush", id: push.event["event_id"].string)
        notificationSource = route["message_id"].string
        selectedRoom = route["room_id"].string
        push.event = .null
      } catch { model.report(error) }
    }
    .task(id: "inbox:\(model.connection?.namespace ?? ""):\(model.ready):\(scenePhase)") {
      guard model.ready, scenePhase == .active else { return }
      SystemInbox.publishTargets(model)
      do { try await DeviceSchedules.synchronize(model) } catch { model.report(error) }
      do { if let room = try await SystemInbox.consume(model) { selectedRoom = room } }
      catch { if (error as? APIError)?.code != "app_group_unavailable" { model.report(error) } }
    }
    .onChange(of: model.items("run")) { _, _ in SystemInbox.publishTargets(model) }
    .onChange(of: scenePhase) { _, phase in
      #if os(iOS)
      if phase == .background { SystemBackground.schedule() }
      #endif
    }
    .onChange(of: model.connection?.namespace) { _, _ in
      selectedRoom = nil
      notificationSource = nil
      settings = false
      edit = nil
      worldDetails = nil
      importingWorld = nil
    }
    .onChange(of: model.items("room").map(\.id)) { _, ids in
      if model.ready, let room = selectedRoom, !ids.contains(room) {
        selectedRoom = nil
        notificationSource = nil
      }
    }
    .onChange(of: selectedRoom) { old, new in
      if old != new && model.messages(room: new ?? "").allSatisfy({ $0.id != notificationSource }) {
        notificationSource = nil
      }
    }
    .sheet(isPresented: $settings) { SettingsView(model: model) }
    .sheet(item: $edit) { EntityEditor(model: model, target: $0) }
    .sheet(item: $worldDetails) { WorldDetails(model: model, world: $0) }
    .sheet(item: $importingWorld) { ImportView(model: model, world: $0.id) }
    .alert(
      String(localized: "操作未完成"),
      isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })
    ) {
      Button(String(localized: "好"), role: .cancel) { model.error = nil }
    } message: {
      Text(model.error ?? "")
    }
  }

  private var sidebar: some View {
    let latest = latestConversationMessages(model.records)
    return List(selection: $selectedRoom) {
      ForEach(
        model.items("room").sorted {
          if ($0["kind"].string == "direct") != ($1["kind"].string == "direct") {
            return $0["kind"].string == "direct"
          }
          return $0.name.localizedStandardCompare($1.name) == .orderedAscending
        }
      ) { room in
        NavigationLink(value: room.id) {
          SidebarConversationLabel(model: model, room: room, latest: latest[room.id]) {
            Button(String(localized: "聊天成员与回应方式")) {
              edit = EditTarget(resource: "rooms", record: room, world: room["world_id"].string)
            }
            if let world = model.items("world").first(where: { $0.id == room["world_id"].string }) {
              Button(String(localized: "TA 的设定与回忆")) { worldDetails = world }
            }
          }
        }
        .listRowBackground(selectedRoom == room.id ? Color.echo.primarySoft : Color.clear)
        .contextMenu {
          Button(String(localized: "聊天成员与回应方式")) {
            edit = EditTarget(resource: "rooms", record: room, world: room["world_id"].string)
          }
          if let world = model.items("world").first(where: { $0.id == room["world_id"].string }) {
            Button(String(localized: "TA 的设定与回忆")) { worldDetails = world }
          }
        }
      }
      if model.items("room").isEmpty, let world = model.items("world").first {
        Button(String(localized: "开启一段聊天")) {
          edit = EditTarget(resource: "rooms", world: world.id)
        }
      }
      if model.items("world").isEmpty {
        VStack(alignment: .leading, spacing: EchoSpacing.sm) {
          Text(String(localized: "为故事留个位置")).font(EchoFont.headline)
          Text(String(localized: "同一设定里可以有许多角色，也有属于你们的私聊与群聊。"))
            .font(EchoFont.callout).foregroundStyle(Color.echo.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
          Button(String(localized: "新建 TA 的设定")) { edit = EditTarget(resource: "worlds") }
            .buttonStyle(.borderedProminent)
        }.padding(.vertical, EchoSpacing.lg)
      }
    }
    .listStyle(.sidebar)
    .scrollContentBackground(.hidden)
    .background(Color.echo.bg)
    .safeAreaInset(edge: .bottom, spacing: 0) { sidebarConnection }
  }

  private var sidebarConnection: some View {
    Button {
      settings = true
    } label: {
      HStack(alignment: .top, spacing: EchoSpacing.xs) {
        Circle().fill(model.ready ? Color.echo.success : Color.echo.warning)
          .frame(width: EchoMetric.statusDot, height: EchoMetric.statusDot)
          .padding(.top, EchoSpacing.xxs)
        VStack(alignment: .leading, spacing: EchoSpacing.xxs) {
          Text(model.status).font(EchoFont.caption).foregroundStyle(Color.echo.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
          Text(connectionHost).font(EchoFont.caption).foregroundStyle(Color.echo.textSecondary)
            .lineLimit(1)
        }
        Spacer(minLength: 0)
        Image(systemName: "chevron.right").font(EchoFont.caption)
          .foregroundStyle(Color.echo.textTertiary)
      }.padding(EchoSpacing.md).contentShape(Rectangle())
    }
    .buttonStyle(.plain).help(String(localized: "打开连接设置"))
    .fixedSize(horizontal: false, vertical: true)
    .accessibilityIdentifier("sidebar-connection")
    .background(Color.echo.surfaceSunken)
    .overlay(alignment: .top) { Color.echo.separator.frame(height: EchoMetric.hairline) }
  }

  private var connectionHost: String {
    guard let url = model.connection?.url else { return String(localized: "未连接服务器") }
    return url.replacingOccurrences(of: "https://", with: "").replacingOccurrences(
      of: "http://", with: "")
  }

}

struct ConnectionView: View {
  var model: AppModel
  @State private var url = "https://"
  @State private var allowLocal = false
  @State private var code = ""
  @State private var device = String(localized: "我的设备")
  @State private var busy = false
  var body: some View {
    Form {
      Section {
        Image(systemName: "bubble.left.and.bubble.right")
          .font(EchoFont.title)
          .foregroundStyle(Color.echo.primary)
          .frame(width: EchoMetric.heroIcon, height: EchoMetric.heroIcon)
          .background(Color.echo.primarySoft, in: Circle()).accessibilityHidden(true)
        Text(String(localized: "连接你的 Echo")).font(EchoFont.display)
        Text(String(localized: "填写自部署服务器地址与一次性配对码。聊天、角色和剧情保存在服务器；离线时仍可阅读已同步内容。"))
          .foregroundStyle(Color.echo.textSecondary).fixedSize(horizontal: false, vertical: true)
      }
      Section(String(localized: "服务器与设备")) {
        VStack(alignment: .leading, spacing: EchoSpacing.xs) {
          Text(String(localized: "服务器地址")).font(EchoFont.footnote).foregroundStyle(
            Color.echo.textSecondary)
          TextField(String(localized: "服务器 HTTPS URL"), text: $url).textContentType(.URL)
            .autocorrectionDisabled()
            #if os(iOS)
              .textInputAutocapitalization(.never).keyboardType(.URL)
            #endif
        }.disabled(busy)
        VStack(alignment: .leading, spacing: EchoSpacing.xs) {
          Text(String(localized: "设备名称")).font(EchoFont.footnote).foregroundStyle(
            Color.echo.textSecondary)
          TextField(String(localized: "设备名称"), text: $device)
        }.disabled(busy)
        VStack(alignment: .leading, spacing: EchoSpacing.xs) {
          Text(String(localized: "一次性配对码")).font(EchoFont.footnote).foregroundStyle(
            Color.echo.textSecondary)
          SecureField(String(localized: "一次性配对码"), text: $code)
            #if os(iOS)
              .textInputAutocapitalization(.never)
            #endif
          Text(String(localized: "首次连接时，填写服务器提供的配对码。"))
            .font(EchoFont.caption).foregroundStyle(Color.echo.textSecondary)
        }.disabled(busy)
        #if DEBUG
          Toggle(String(localized: "开发调试：允许本机 HTTP"), isOn: $allowLocal)
        #endif
      }
      Section {
        Button(String(localized: "连接已配对的服务器")) {
          do { try model.resume(url: url, allowLocal: allowLocal) } catch { model.report(error) }
        }.disabled(busy).buttonStyle(.bordered)
        Button(busy ? String(localized: "正在配对…") : String(localized: "配对")) {
          busy = true
          Task {
            defer { busy = false }
            do {
              try await model.pair(url: url, code: code, device: device, allowLocal: allowLocal)
              code = ""
            } catch { model.report(error) }
          }
        }
        .buttonStyle(.borderedProminent)
        .disabled(
          busy || code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || device.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    }
    .formStyle(.grouped)
    .scrollContentBackground(.hidden)
    .background(Color.echo.surfaceSunken)
    .frame(maxWidth: EchoMetric.formWidth)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Color.echo.bg)
    .toggleStyle(.switch)
    #if DEBUG
      .onAppear {
        if let testURL = ProcessInfo.processInfo.environment["ECHO2_UI_TEST_URL"] {
          url = testURL
          allowLocal = true
          code = ProcessInfo.processInfo.environment["ECHO2_UI_TEST_CODE"] ?? ""
        }
      }
    #endif
  }
}

private struct SidebarConversationLabel<Actions: View>: View {
  var model: AppModel
  let room: Record
  let latest: Record?
  @ViewBuilder let actions: () -> Actions
  @State private var hovering = false
  var body: some View {
    HStack(spacing: EchoSpacing.xxs) {
      ConversationRow(model: model, room: room, latest: latest)
      Menu(content: actions) {
        Image(systemName: "ellipsis").frame(width: EchoSpacing.lg, height: EchoSpacing.lg)
      }
      #if os(macOS)
        .menuStyle(.borderlessButton).menuIndicator(.hidden)
      #endif
      .fixedSize().opacity(hovering ? 1 : 0)
      .help(String(localized: "聊天成员、TA 的设定与回忆"))
      .accessibilityLabel(String(localized: "聊天选项：\(room.name)"))
    }.onHover { hovering = $0 }
  }
}
