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
      } catch { startupError = error.localizedDescription }
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
  var body: some View {
    Group {
      if model.connection == nil {
        ConnectionView(model: model)
      } else {
        NavigationSplitView {
          List(selection: $selectedRoom) {
            Section {
              HStack(alignment: .top) {
                Image(systemName: model.ready ? "checkmark.icloud" : "icloud.slash")
                  .accessibilityHidden(true)
                Text(model.status).fixedSize(horizontal: false, vertical: true)
              }.font(.caption).foregroundStyle(.secondary).accessibilityElement(children: .combine)
            }
            ForEach(model.items("world")) { world in
              Section {
                ForEach(model.items("room").filter { $0["world_id"].string == world.id }) { room in
                  NavigationLink(value: room.id) {
                    Label(
                      room.name,
                      systemImage: room["kind"].string == "direct" ? "person.bubble" : "person.3")
                  }
                }
                Button {
                  worldDetails = world
                } label: {
                  Label("管理「\(world.name)」", systemImage: "globe.asia.australia")
                }.font(.caption)
              } header: {
                Text(world.name)
              }
            }
            if model.items("world").isEmpty { Text("创建世界，添加角色，再开始对话。").foregroundStyle(.secondary) }
          }
          .navigationTitle("世界")
          .toolbar {
            ToolbarItem {
              Button {
                edit = EditTarget(resource: "worlds")
              } label: {
                Label("新建世界", systemImage: "plus")
              }
            }
            ToolbarItem {
              Button {
                settings = true
              } label: {
                Label("设置", systemImage: "gearshape")
              }
            }
          }
          .navigationSplitViewColumnWidth(min: 240, ideal: 280)
        } detail: {
          if let room = model.items("room").first(where: { $0.id == selectedRoom }) {
            ChatView(model: model, room: room, sourceMessage: notificationSource).id(
              room.id + (notificationSource ?? ""))
          } else {
            ContentUnavailableView(
              "一个世界，许多故事", systemImage: "bubble.left.and.bubble.right",
              description: Text("从侧栏选择私聊或群聊。所有回复由你的服务器保存和执行。"))
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
    .alert(
      "操作未完成",
      isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })
    ) {
      Button("好", role: .cancel) { model.error = nil }
    } message: {
      Text(model.error ?? "")
    }
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
        Image(systemName: "bubble.left.and.bubble.right.fill").font(.system(size: 44))
          .foregroundStyle(.tint).accessibilityHidden(true)
        Text("连接你的世界").font(.largeTitle.bold())
        Text("填写自部署服务器地址与一次性配对码。聊天、角色和剧情保存在服务器；离线时仍可阅读已同步内容。")
          .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      }
      Section("服务器与设备") {
        TextField("服务器 HTTPS URL", text: $url).textContentType(.URL).autocorrectionDisabled()
        TextField("设备名称", text: $device)
        SecureField("一次性配对码", text: $code)
        #if DEBUG
          Toggle("开发调试：允许本机 HTTP", isOn: $allowLocal)
        #endif
      }
      Section {
        Button("连接已配对的服务器") {
          do { try model.resume(url: url, allowLocal: allowLocal) } catch { model.report(error) }
        }
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
        .buttonStyle(.borderedProminent).disabled(busy || code.isEmpty || device.isEmpty)
      }
    }.formStyle(.grouped).frame(maxWidth: 620)
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
