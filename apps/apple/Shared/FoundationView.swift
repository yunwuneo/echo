import CompanionCore
import SwiftUI

struct FoundationView: View {
  @State private var model: AppModel?
  @State private var startupError: String?
  var body: some View {
    Group {
      if let model {
        CompanionWorkspace(model: model)
      } else if let startupError {
        ContentUnavailableView(
          "无法打开本地缓存", systemImage: "externaldrive.badge.exclamationmark",
          description: Text(startupError))
      } else {
        ProgressView("打开世界…")
      }
    }
    .tint(Color.echo.primary)
    .foregroundStyle(Color.echo.textPrimary)
    .background(Color.echo.bg)
    #if DEBUG
      .preferredColorScheme(
        ProcessInfo.processInfo.environment["ECHO2_UI_TEST_DARK"] == "1" ? .dark : nil)
    #endif
    .task {
      guard model == nil else { return }
      do {
        let app = AppModel(cache: try CacheStore())
        model = app
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
        NavigationSplitView {
          sidebar
            .navigationTitle("消息与世界")
            .toolbar {
              ToolbarItem {
                Menu {
                  Button("新建世界", systemImage: "globe.asia.australia") {
                    edit = EditTarget(resource: "worlds")
                  }
                  Button("新建角色模板", systemImage: "person.badge.plus") {
                    edit = EditTarget(resource: "characters")
                  }
                  if !model.items("world").isEmpty {
                    Menu("导入角色卡或世界书") {
                      ForEach(model.items("world")) { world in
                        Button(world.name) { importingWorld = world }
                      }
                    }
                  }
                } label: {
                  Label("新建", systemImage: "plus")
                }.help("新建世界、角色，或导入角色卡")
              }
              ToolbarItem {
                Button {
                  settings = true
                } label: {
                  Label("设置", systemImage: "gearshape")
                }.help("服务器、通知与设置")
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
                  title: "故事在这里继续",
                  description: "从左侧选一段私聊或群聊，也可以为世界开启一段新的相遇。",
                  actionTitle: "新建私聊或群聊"
                ) { edit = EditTarget(resource: "rooms", world: world.id) }
                Button("导入角色卡或世界书") { importingWorld = world }
                  .buttonStyle(.borderless)
              } else {
                EchoEmptyState(
                  title: "一个世界，许多故事",
                  description: "为你们留下一片天地，认识角色，让故事从第一句话开始。",
                  symbol: "globe.asia.australia", actionTitle: "创建第一个世界"
                ) { edit = EditTarget(resource: "worlds") }
              }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.echo.bg)

          }
        }
      }
    }
    .task(id: "\(model.connection?.namespace ?? ""):\(model.ready):\(PushCoordinator.shared.token)")
    {
      if model.ready && !PushCoordinator.shared.token.isEmpty {
        do { try await model.updatePushToken(PushCoordinator.shared.token) } catch {
          PushCoordinator.shared.registrationError = "推送地址更新失败，请在通知设置中重新绑定。"
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
        model.error = "此通知来自其他服务器或旧恢复版本，请连接对应服务器后查看。"
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
      "操作未完成",
      isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })
    ) {
      Button("好", role: .cancel) { model.error = nil }
    } message: {
      Text(model.error ?? "")
    }
  }

  private var sidebar: some View {
    List(selection: $selectedRoom) {
      ForEach(model.items("world")) { world in
        Section {
          let rooms = model.items("room").filter { $0["world_id"].string == world.id }
          ForEach(rooms) { room in
            NavigationLink(value: room.id) {
              conversationRow(room)
            }
            .listRowBackground(selectedRoom == room.id ? Color.echo.primarySoft : Color.clear)
            .contextMenu {
              Button("聊天成员与回应方式") {
                edit = EditTarget(resource: "rooms", record: room, world: world.id)
              }
              Button("世界、角色与回忆") { worldDetails = world }
            }
          }
          if rooms.isEmpty {
            Button {
              edit = EditTarget(resource: "rooms", world: world.id)
            } label: {
              Label("开启一段聊天", systemImage: "bubble.left.and.bubble.right")
                .font(EchoFont.callout)
            }.padding(.vertical, EchoSpacing.xs)
          }
        } header: {
          HStack {
            Text(world.name).font(EchoFont.section).foregroundStyle(Color.echo.textSecondary)
            Spacer()
            Button {
              worldDetails = world
            } label: {
              Image(systemName: "ellipsis").font(EchoFont.headline)
                .frame(minWidth: EchoMetric.touchTarget, minHeight: EchoMetric.touchTarget)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("管理「\(world.name)」")
            .help("管理世界、角色、记忆与主动消息")
          }.textCase(nil)
        }
      }
      if model.items("world").isEmpty {
        VStack(alignment: .leading, spacing: EchoSpacing.sm) {
          Text("为故事留个位置").font(EchoFont.headline)
          Text("世界里可以有许多角色，也有属于你们的私聊与群聊。")
            .font(EchoFont.callout).foregroundStyle(Color.echo.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
          Button("新建世界") { edit = EditTarget(resource: "worlds") }
            .buttonStyle(.borderedProminent)
        }.padding(.vertical, EchoSpacing.lg)
      }
    }
    .listStyle(.sidebar)
    .scrollContentBackground(.hidden)
    .background(Color.echo.bg)
    .safeAreaInset(edge: .bottom, spacing: 0) {
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
      .buttonStyle(.plain).help("打开连接设置")
      .background(Color.echo.surfaceSunken)
      .overlay(alignment: .top) { Color.echo.separator.frame(height: EchoMetric.hairline) }
    }
  }

  private var connectionHost: String {
    guard let url = model.connection?.url else { return "未连接服务器" }
    return url.replacingOccurrences(of: "https://", with: "").replacingOccurrences(
      of: "http://", with: "")
  }

  private func conversationRow(_ room: Record) -> some View {
    let members = model.items("actor").filter { room["actor_ids"].array.contains(.string($0.id)) }
    let preview = model.messages(room: room.id).last?["content"].string ?? ""
    return HStack(spacing: EchoSpacing.sm) {
      if room["kind"].string == "direct" {
        EchoAvatar(
          name: members.first?.name ?? room.name, id: members.first?.id ?? room.id,
          size: EchoMetric.rowAvatar)
      } else {
        ZStack {
          EchoAvatar(
            name: members.dropFirst().first?.name ?? room.name,
            id: members.dropFirst().first?.id ?? room.id, size: EchoMetric.smallAvatar
          )
          .offset(x: EchoSpacing.xxs, y: -EchoSpacing.xxs)
          EchoAvatar(
            name: members.first?.name ?? room.name, id: members.first?.id ?? room.id,
            size: EchoMetric.smallAvatar
          )
          .overlay { Circle().stroke(Color.echo.bg, lineWidth: EchoMetric.border) }
          .offset(x: -EchoSpacing.xxs, y: EchoSpacing.xxs)
        }.frame(width: EchoMetric.rowAvatar, height: EchoMetric.rowAvatar)
      }
      VStack(alignment: .leading, spacing: EchoSpacing.xxs) {
        Text(room.name).font(EchoFont.headline).foregroundStyle(Color.echo.textPrimary)
          .lineLimit(2)
        Text(preview.isEmpty ? "还没有聊过天，先打个招呼吧" : preview)
          .font(EchoFont.footnote).foregroundStyle(Color.echo.textSecondary).lineLimit(1)
      }
      Spacer(minLength: 0)
    }
    .padding(.vertical, EchoSpacing.xs)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(room.name)
    .accessibilityValue(room["kind"].string == "direct" ? "私聊" : "群聊，\(members.count) 位角色")
  }

}

struct ConnectionView: View {
  var model: AppModel
  @State private var url = "https://"
  @State private var allowLocal = false
  @State private var code = ""
  @State private var device = "我的设备"
  @State private var busy = false
  var body: some View {
    Form {
      Section {
        Image(systemName: "bubble.left.and.bubble.right")
          .font(EchoFont.title)
          .foregroundStyle(Color.echo.primary)
          .frame(width: EchoMetric.heroIcon, height: EchoMetric.heroIcon)
          .background(Color.echo.primarySoft, in: Circle()).accessibilityHidden(true)
        Text("连接你的世界").font(EchoFont.display)
        Text("填写自部署服务器地址与一次性配对码。聊天、角色和剧情保存在服务器；离线时仍可阅读已同步内容。")
          .foregroundStyle(Color.echo.textSecondary).fixedSize(horizontal: false, vertical: true)
      }
      Section("服务器与设备") {
        VStack(alignment: .leading, spacing: EchoSpacing.xs) {
          Text("服务器地址").font(EchoFont.footnote).foregroundStyle(Color.echo.textSecondary)
          TextField("服务器 HTTPS URL", text: $url).textContentType(.URL).autocorrectionDisabled()
            #if os(iOS)
              .textInputAutocapitalization(.never).keyboardType(.URL)
            #endif
        }.disabled(busy)
        VStack(alignment: .leading, spacing: EchoSpacing.xs) {
          Text("设备名称").font(EchoFont.footnote).foregroundStyle(Color.echo.textSecondary)
          TextField("设备名称", text: $device)
        }.disabled(busy)
        VStack(alignment: .leading, spacing: EchoSpacing.xs) {
          Text("一次性配对码").font(EchoFont.footnote).foregroundStyle(Color.echo.textSecondary)
          SecureField("一次性配对码", text: $code)
            #if os(iOS)
              .textInputAutocapitalization(.never)
            #endif
          Text("首次连接时，填写服务器提供的配对码。")
            .font(EchoFont.caption).foregroundStyle(Color.echo.textSecondary)
        }.disabled(busy)
        #if DEBUG
          Toggle("开发调试：允许本机 HTTP", isOn: $allowLocal)
        #endif
      }
      Section {
        Button("连接已配对的服务器") {
          do { try model.resume(url: url, allowLocal: allowLocal) } catch { model.report(error) }
        }.disabled(busy).buttonStyle(.bordered)
        Button(busy ? "正在配对…" : "配对") {
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
