@preconcurrency import AVFoundation
import CompanionCore
import CoreText
import Observation
@preconcurrency import Speech
import SwiftUI
import UniformTypeIdentifiers
import WebKit

struct OwnerArchive: FileDocument {
  static var readableContentTypes: [UTType] { [.json, .plainText, .pdf] }
  var data: Data
  init(data: Data) { self.data = data }
  init(configuration: ReadConfiguration) throws {
    data = configuration.file.regularFileContents ?? Data()
  }
  func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
    FileWrapper(regularFileWithContents: data)
  }
}
struct OperationsView: View {
  var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var diagnostics: JSONValue = .null
  @State private var archive = OwnerArchive(data: Data())
  @State private var filename = "echo-export.json"
  @State private var exporting = false
  @State private var busy = false
  @State private var failure: String?
  var body: some View {
    NavigationStack {
      Form {
        NavigationLink("系统与今日") { PlatformView(model: model) }
        NavigationLink("定时任务与 Host") { ContinuationView(model: model) }
        NavigationLink("知识、创作与群协作") { FeatureHubView(model: model) }
        NavigationLink("预设与请求配置") { PromptSettingsView(model: model) }
        NavigationLink("新对话默认行为") { ConversationSettingsView(model: model) }
        NavigationLink("文件、恢复点与存储") { StorageView(model: model) }
        NavigationLink("加密备份与恢复") { PortableBackupView(model: model) }
        Section(String(localized: "数据导出")) {
          Text(String(localized: "导出包含 TA 的设定、角色、消息、记忆与原始导入文件，可能含私人内容，请妥善保管。模型 Key 与设备凭据不会导出。"))
            .font(EchoFont.caption)
          Button(busy ? String(localized: "正在准备…") : String(localized: "导出我的数据")) {
            busy = true
            Task {
              defer { busy = false }
              do {
                let value = try await model.operations(action: "export")
                archive = OwnerArchive(data: try JSONEncoder().encode(value))
                filename = "echo-data-\(UUID().uuidString.prefix(8)).json"
                exporting = true
              } catch { failure = userFacingError(error) }
            }
          }.disabled(busy)
          Text(String(localized: "整实例备份与恢复由服务器管理员在维护模式下执行。")).font(EchoFont.caption)
            .foregroundStyle(.secondary)
        }
        Section(String(localized: "服务器状态")) {
          if diagnostics == .null {
            if failure == nil { ProgressView(String(localized: "正在读取服务器状态…")) }
          } else {
            LabeledContent(String(localized: "版本"), value: diagnostics["version"].string)
            LabeledContent(
              String(localized: "后台进程"),
              value: diagnostics["worker"]["healthy"].bool
                ? String(localized: "运行中") : String(localized: "未检测到近期心跳"))
            LabeledContent(String(localized: "实例"), value: diagnostics["server_instance_id"].string)
              .font(EchoFont.caption)
            LabeledContent(String(localized: "恢复版本"), value: diagnostics["data_epoch"].string).font(
              EchoFont.caption)
            Button(String(localized: "导出诊断信息")) {
              do {
                archive = OwnerArchive(data: try JSONEncoder().encode(diagnostics))
                filename = "echo-diagnostics-\(UUID().uuidString.prefix(8)).json"
                exporting = true
              } catch { failure = userFacingError(error) }
            }
          }
          Button(String(localized: "刷新服务器状态")) { Task { await refresh() } }
          Text(String(localized: "诊断仅包含版本、迁移校验和、任务状态数量与后台心跳，不包含正文、密钥或工具返回。")).font(EchoFont.caption)
        }
        if let failure {
          Label(failure, systemImage: "exclamationmark.circle")
            .foregroundStyle(Color.echo.error).fixedSize(horizontal: false, vertical: true)
        }
      }.formStyle(.grouped).scrollContentBackground(.hidden)
        .background(Color.echo.surfaceSunken).navigationTitle(String(localized: "数据与诊断"))
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button(String(localized: "完成")) { dismiss() }.accessibilityIdentifier(
              "close-operations")
          }
        }
        .task { await refresh() }
        .fileExporter(
          isPresented: $exporting, document: archive, contentType: .json, defaultFilename: filename
        ) { result in if case .failure(let error) = result { failure = userFacingError(error) } }
    }.frame(minWidth: 320, idealWidth: 560, minHeight: 460)
  }
  private func refresh() async {
    do {
      diagnostics = try await model.operations(action: "diagnostics")
      failure = nil
    } catch { failure = userFacingError(error) }
  }
}

// Native forms share the existing model, connection namespace and design tokens.
@MainActor
func milestoneCall(
  _ model: AppModel, _ action: String, _ fields: [String: JSONValue] = [:],
  command: Bool = false
) async throws -> JSONValue {
  let namespace = model.connection?.namespace
  let key =
    "milestone/" + action + "/" + fields["command", default: .null].string + "/"
    + fields["id", default: .null].string
  var body = fields
  body["action"] = .string(action)
  if command {
    let saved = model.draft(room: key)
    var previous: JSONValue = .null
    if let data = saved.data(using: .utf8) {
      previous = (try? JSONDecoder().decode(JSONValue.self, from: data)) ?? .null
    }
    var old = previous.object
    let operation = old.removeValue(forKey: "operation_id")
    body["operation_id"] =
      old == body ? operation ?? .string(UUID().uuidString) : .string(UUID().uuidString)
    let data = try JSONEncoder().encode(JSONValue.object(body))
    model.saveDraft(room: key, content: String(decoding: data, as: UTF8.self))
  }
  let result = try await model.operations(action: "milestone", body: .object(body))
  guard namespace == model.connection?.namespace else {
    throw APIError(status: 409, code: "connection_changed")
  }
  if command, let data = model.draft(room: key).data(using: .utf8),
    let pending = try? JSONDecoder().decode(JSONValue.self, from: data), pending == .object(body)
  {
    model.saveDraft(room: key, content: "")
  }
  return result
}

struct PortableBackupView: View {
  var model: AppModel
  @State private var password = ""
  @State private var archive = OwnerArchive(data: Data())
  @State private var imported: JSONValue = .null
  @State private var preview: JSONValue = .null
  @State private var health: JSONValue = .null
  @State private var keepLocal = false
  @State private var exporting = false
  @State private var importing = false
  @State private var busy = false
  @State private var status = ""
  @State private var confirm = false
  @State private var namespace: String?
  var body: some View {
    Form {
      Section("加密业务备份") {
        Text(
          "包含身份、对话版本、文档、原始资源和引用关系。排除模型及 MCP 密钥、设备登录、推送和执行队列。恢复后连接与授权需重新检查。当前上限 16 MiB；更大实例使用服务器维护备份。"
        ).font(EchoFont.caption)
        SecureField("备份密码（至少 12 个字符）", text: $password)
        Button("生成加密备份") { Task { await export() } }
        Button("选择备份文件") { importing = true }
        if imported != .null { Button("验证密码并预览恢复") { Task { await inspect() } } }
      }
      if preview != .null {
        Section("恢复预览") {
          LabeledContent("新增", value: String(preview["counts"]["insert"].int))
          LabeledContent("更新", value: String(preview["counts"]["update"].int))
          LabeledContent("冲突", value: String(preview["counts"]["conflict"].int))
          ForEach(preview["items"].array.filter { $0["state"].string == "conflict" }, id: \.self) {
            item in
            Text(item["table"].string + " · " + String(describing: item["key"])).font(
              EchoFont.caption)
          }
          Toggle("保留存在冲突的本地内容", isOn: $keepLocal)
          Text("整张数据关系图一次提交。中断后重新选择相同备份即可续导；不会重放历史模型调用、工具或计划。").font(EchoFont.caption)
          Button("恢复此备份") { confirm = true }
        }
      }
      Section("数据健康") {
        Button("检查正文与资源哈希") { Task { await checkHealth() } }
        if health != .null {
          Text(health["healthy"].bool ? "检查通过" : "发现损坏，请保留原件并检查备份")
          LabeledContent("原始资源字节", value: health["asset_bytes"].string)
          ForEach(health["issues"].array, id: \.self) { issue in
            Text(issue["kind"].string + " " + issue["id"].string)
          }
        }
      }
      if !status.isEmpty { Text(status).textSelection(.enabled) }
    }.formStyle(.grouped).scrollContentBackground(.hidden).background(Color.echo.surfaceSunken)
      .navigationTitle("备份与恢复").disabled(busy)
      .task { namespace = model.connection?.namespace }
      .confirmationDialog("将按预览恢复业务数据，所有恢复任务保持暂停。", isPresented: $confirm) {
        Button("确认恢复") { Task { await restore() } }
        Button("取消", role: .cancel) {}
      }
      .fileExporter(
        isPresented: $exporting, document: archive, contentType: .json,
        defaultFilename: "echo-encrypted-backup.json"
      ) { result in
        if case .failure(let e) = result { status = userFacingError(e) }
      }
      .fileImporter(isPresented: $importing, allowedContentTypes: [.json]) { result in
        do {
          let url = try result.get()
          let access = url.startAccessingSecurityScopedResource()
          defer { if access { url.stopAccessingSecurityScopedResource() } }
          let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
          guard size <= 24 * 1024 * 1024 else { throw APIError(status: 413, code: "backup_size") }
          imported = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
          preview = .null
          status = "文件已读取，输入密码后验证。"
        } catch { status = userFacingError(error) }
      }
  }
  private func check() throws {
    guard namespace == model.connection?.namespace else {
      throw APIError(status: 409, code: "connection_changed")
    }
  }
  private func export() async {
    busy = true
    defer { busy = false }
    do {
      try check()
      let value = try await milestoneCall(model, "exportBackup", ["password": .string(password)])
      archive = OwnerArchive(data: try JSONEncoder().encode(value["archive"]))
      exporting = true
      status = "加密完成，请保存文件。"
    } catch { status = userFacingError(error) }
  }
  private func inspect() async {
    busy = true
    defer { busy = false }
    do {
      try check()
      preview = try await milestoneCall(
        model, "previewRestore", ["archive": imported, "password": .string(password)])
      status = "验证完成；确认前不会写入业务数据。"
    } catch { status = userFacingError(error) }
  }
  private func restore() async {
    busy = true
    defer { busy = false }
    do {
      try check()
      _ = try await milestoneCall(
        model, "restoreBackup",
        [
          "id": preview["id"], "preview_token": preview["preview_token"],
          "keep_local": .bool(keepLocal),
        ])
      status = "恢复已提交。请重新配置密钥并检查连接、授权与暂停的计划。"
      preview = .null
      imported = .null
      password = ""
    } catch { status = userFacingError(error) }
  }
  private func checkHealth() async {
    busy = true
    defer { busy = false }
    do {
      try check()
      health = try await milestoneCall(model, "dataHealth")
    } catch { status = userFacingError(error) }
  }
}

struct DocumentLibraryView: View {
  var model: AppModel
  var worldID: String
  @State private var library: JSONValue = .null
  @State private var projectName = ""
  @State private var projectID = ""
  @State private var detail: JSONValue = .null
  @State private var title = ""
  @State private var content = ""
  @State private var kind = "artifact"
  @State private var assetIDs: [String] = []
  @State private var status = ""
  @State private var busy = false
  @State private var namespace: String?
  @State private var restoreVersion: JSONValue = .null
  @State private var confirmRestore = false
  @Environment(\.dismiss) private var dismiss
  private var projects: [JSONValue] {
    library["projects"].array.filter { $0["world_id"].string == worldID }
  }
  var body: some View {
    NavigationStack {
      Form {
        Section("项目") {
          Picker("当前项目", selection: $projectID) {
            Text("请选择").tag("")
            ForEach(projects, id: \.self) { p in Text(p["name"].string).tag(p["id"].string) }
          }
          TextField("新项目名称", text: $projectName)
          Button("创建项目") { Task { await create() } }
          Button("启用内部文档工具目录") {
            Task {
              await perform {
                _ = try await milestoneCall(model, "enableInternalTools", command: true)
                status = "工具已注册。请在工具权限中选择角色并授权；写入仍需审批。"
              }
            }
          }
        }
        Section("文档") {
          ForEach(
            library["documents"].array.filter { $0["project_id"].string == projectID }, id: \.self
          ) { d in
            Button(d["title"].string) { Task { await load(d["id"].string) } }
          }
          Button("新建文档") {
            detail = .null
            assetIDs = []
            title = ""
            content = ""
            kind = "artifact"
          }
          TextField("标题", text: $title)
          Picker("用途", selection: $kind) {
            Text("可编辑作品").tag("artifact")
            Text("角色只读参考资料").tag("reference")
          }.disabled(detail != .null)
          TextEditor(text: $content).frame(minHeight: 160).accessibilityLabel("文档正文")
          Button("保存文档") { Task { await save() } }
          Text("保存会检查读取时的版本及正文哈希；冲突不会覆盖服务器内容。").font(EchoFont.caption)
        }
        Section("文档附件引用") {
          ForEach(assetIDs, id: \.self) { id in
            HStack {
              Text(id).font(EchoFont.caption)
              Button("移除此处引用") { assetIDs.removeAll { $0 == id } }
            }
          }
          Menu("引用已有资源") {
            ForEach(
              model.items("asset").filter {
                $0["world_id"].string == worldID && !assetIDs.contains($0.id)
              }
            ) { asset in
              Button(asset["mime"].string + " · " + String(asset.id.prefix(8))) {
                assetIDs.append(asset.id)
              }
            }
          }
          Text("点击保存后更新引用。旧版本和其他文档仍保留原件。").font(EchoFont.caption)
        }
        if detail != .null {
          Section("历史版本") {
            ForEach(detail["versions"].array, id: \.self) { v in
              DisclosureGroup("版本 \(v["revision"].int) · \(v["title"].string)") {
                Text(v["content"].string).textSelection(.enabled)
                Button("恢复为新版本") {
                  restoreVersion = v
                  confirmRestore = true
                }
              }
            }
          }
        }
        if !status.isEmpty { Text(status).textSelection(.enabled) }
        Button("刷新列表") { Task { await refresh() } }
      }.formStyle(.grouped).scrollContentBackground(.hidden).background(Color.echo.surfaceSunken)
        .navigationTitle("项目与文档").disabled(busy)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("完成") { dismiss() } } }
        .task {
          namespace = model.connection?.namespace
          await refresh()
        }
        .confirmationDialog("将保留所有旧版本，并用所选内容创建新版本。", isPresented: $confirmRestore) {
          Button("确认恢复") { Task { await save(version: restoreVersion["revision"]) } }
          Button("取消", role: .cancel) {}
        }
    }.frame(minWidth: 320, idealWidth: 650, minHeight: 500)
  }
  private func perform(_ work: () async throws -> Void) async {
    busy = true
    defer { busy = false }
    do {
      guard namespace == model.connection?.namespace else {
        throw APIError(status: 409, code: "connection_changed")
      }
      try await work()
    } catch { status = userFacingError(error) }
  }
  private func refresh() async {
    await perform {
      library = try await milestoneCall(model, "contentLibrary")
      if projectID.isEmpty { projectID = projects.first?["id"].string ?? "" }
    }
  }
  private func create() async {
    await perform {
      let p = try await milestoneCall(
        model, "createProject", ["world_id": .string(worldID), "name": .string(projectName)],
        command: true)
      projectID = p["id"].string
      projectName = ""
      library = try await milestoneCall(model, "contentLibrary")
    }
  }
  private func load(_ id: String) async {
    await perform {
      detail = try await milestoneCall(model, "documentDetails", ["id": .string(id)])
      assetIDs = detail["asset_ids"].array.map(\.string)
      title = detail["document"]["title"].string
      content = detail["document"]["content"].string
      kind = detail["document"]["kind"].string
      status = ""
    }
  }
  private func save(version: JSONValue = .null) async {
    await perform {
      var input: [String: JSONValue] = [
        "project_id": .string(projectID), "title": .string(title), "content": .string(content),
        "kind": .string(kind), "expected_revision": .number(0),
      ]
      if detail != .null {
        input["id"] = detail["document"]["id"]
        input["expected_revision"] = detail["document"]["revision"]
        input["base_hash"] = detail["document"]["content_hash"]
      }
      if version != .null {
        input["restore_revision"] = version
      } else {
        input["asset_ids"] = .strings(assetIDs)
      }
      let result = try await milestoneCall(model, "saveDocument", input, command: true)
      detail = try await milestoneCall(model, "documentDetails", ["id": result["id"]])
      content = detail["document"]["content"].string
      title = detail["document"]["title"].string
      assetIDs = detail["asset_ids"].array.map(\.string)
      library = try await milestoneCall(model, "contentLibrary")
      status = "已保存版本 \(detail["document"]["revision"].int)"
    }
  }
}

struct ProviderProbeView: View {
  var model: AppModel
  var provider: Record
  @State private var probes: [JSONValue] = []
  @State private var confirm = false
  @State private var status = ""
  @State private var busy = false
  var body: some View {
    Form {
      Text("测试会向此连接发送一条短模型请求，可能产生供应商费用。保存配置本身不会发送请求。未知结果不自动重试。").font(EchoFont.caption)
      Button("测试此连接") { confirm = true }
      Button("刷新测试结果") { Task { await load() } }
      ForEach(probes, id: \.self) { p in
        VStack(alignment: .leading) {
          Text(p["state"].string)
          Text(p["created_at"].string).font(EchoFont.caption)
          if !p["error_code"].string.isEmpty { Text(p["error_code"].string).font(EchoFont.caption) }
        }
      }
      if !status.isEmpty { Text(status) }
    }.navigationTitle("连接测试").disabled(busy).task { await load() }
      .confirmationDialog("允许向所选连接发送一次可能收费的测试请求？", isPresented: $confirm) {
        Button("发送一次测试") { Task { await probe() } }
        Button("取消", role: .cancel) {}
      }
  }
  private func load() async {
    do {
      probes = try await milestoneCall(model, "providerProbes", ["id": .string(provider.id)])[
        "items"
      ].array
    } catch { status = userFacingError(error) }
  }
  private func probe() async {
    busy = true
    defer { busy = false }
    do {
      _ = try await milestoneCall(
        model, "probeProvider",
        [
          "id": .string(provider.id), "expected_revision": provider["revision"],
          "confirm_billable": .bool(true),
        ], command: true)
      await load()
    } catch { status = userFacingError(error) }
  }
}

struct ConversationSettingsView: View {
  var model: AppModel
  var room: Record?
  @State private var revision = 0
  @State private var mode = "all"
  @State private var count = 20
  @State private var tokens = 8192
  @State private var images = "recent_two"
  @State private var anchor = ""
  @State private var status = ""
  @State private var busy = false
  @State private var exporting = false
  @State private var archive = OwnerArchive(data: Data())
  @State private var exportType: UTType = .json
  @State private var exportName = "echo-conversation.json"
  @State private var namespace: String?
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    NavigationStack {
      Form {
        Section("历史窗口") {
          Picker("窗口", selection: $mode) {
            Text("全部历史").tag("all")
            Text("最近条数（完整回合）").tag("recent")
            Text("按输入预算").tag("tokens")
            Text("从指定消息开始").tag("start")
          }
          if mode == "recent" { Stepper("条数：\(count)", value: $count, in: 1...1000) }
          if mode == "tokens" { TextField("历史预算", value: $tokens, format: .number) }
          if mode == "start", let room {
            Picker("起点", selection: $anchor) {
              Text("未指定，使用全部").tag("")
              ForEach(model.messages(room: room.id).filter { $0["status"].string == "completed" }) {
                message in
                Text(String(message["content"].string.prefix(50))).tag(message.id)
              }
            }
          }
          Picker("图片历史", selection: $images) {
            Text("仅当前消息").tag("current")
            Text("最近两条带图消息").tag("recent_two")
            Text("窗口内全部图片").tag("all")
          }
          Text("历史会按完整回合对齐，并受模型总预算限制。图片需要连接声明支持视觉；不会静默丢弃当前图片。").font(EchoFont.caption)
          Button("保存设置") { Task { await save() } }
        }
        if let room {
          Section("可读导出") {
            Button("导出当前版本 JSON") { Task { await export(room.id, format: "json") } }
            Button("导出当前版本 Markdown") { Task { await export(room.id, format: "md") } }
            NavigationLink("请求快照与回顾用量") { RequestSnapshotView(model: model, room: room) }
            Button("导出当前版本 PDF") { Task { await export(room.id, format: "pdf") } }
            Text("JSON 包含选中正文和去重附件原件；Markdown 与 PDF 为正文导出。所有旧版本使用加密备份保存。").font(EchoFont.caption)
          }
        } else {
          Text("默认行为只用于新建对话，不改动已有对话。").font(EchoFont.caption)
        }
        if !status.isEmpty { Text(status) }
      }.formStyle(.grouped).navigationTitle("对话历史与导出").disabled(busy)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("完成") { dismiss() } } }
        .task {
          namespace = model.connection?.namespace
          await load()
        }
        .fileExporter(
          isPresented: $exporting, document: archive, contentType: exportType,
          defaultFilename: exportName
        ) { result in
          if case .failure(let error) = result { status = userFacingError(error) }
        }
    }.frame(minWidth: 320, idealWidth: 600, minHeight: 460)
  }
  private func load() async {
    do {
      let value: JSONValue
      if let room {
        let current = model.items("room").first { $0.id == room.id } ?? room
        value = current.value
      } else {
        value = try await milestoneCall(model, "behaviorDefaults")
      }
      revision = value["revision"].int
      let b = value["behavior"]
      mode = b["history_mode"].string.isEmpty ? "all" : b["history_mode"].string
      count = max(1, b["history_count"].int)
      tokens = max(1, b["history_tokens"].int)
      images = b["image_history"].string.isEmpty ? "recent_two" : b["image_history"].string
      anchor = b["start_message_id"].string
    } catch { status = userFacingError(error) }
  }
  private func save() async {
    busy = true
    defer { busy = false }
    do {
      guard namespace == model.connection?.namespace else {
        throw APIError(status: 409, code: "connection_changed")
      }
      _ = try await milestoneCall(
        model, "saveBehavior",
        [
          "id": room.map { .string($0.id) } ?? .null,
          "expected_revision": .number(Double(revision)),
          "behavior": .object([
            "history_mode": .string(mode), "history_count": .number(Double(count)),
            "history_tokens": .number(Double(tokens)), "image_history": .string(images),
            "start_message_id": anchor.isEmpty ? .null : .string(anchor),
          ]),
        ], command: true)
      status = "已保存"
      await load()
    } catch { status = userFacingError(error) }
  }
  private func export(_ id: String, format: String) async {
    busy = true
    defer { busy = false }
    do {
      let value = try await model.operations(action: "exportConversation", id: id)
      exportName = "echo-conversation." + format
      exportType = format == "pdf" ? .pdf : format == "md" ? .plainText : .json
      if format != "json" {
        let text = value["messages"].array.map {
          "## " + ($0["role"].string == "user" ? "我" : $0["actor_name"].string) + "\n\n"
            + $0["content"].string
        }.joined(separator: "\n\n")
        archive = OwnerArchive(data: format == "pdf" ? try conversationPDF(text) : Data(text.utf8))
      } else {
        archive = OwnerArchive(data: try JSONEncoder().encode(value))
      }
      exporting = true
    } catch { status = userFacingError(error) }
  }
}

struct PromptSettingsView: View {
  var model: AppModel
  @State private var library: JSONValue = .null
  @State private var subject = ""
  @State private var profile: JSONValue = .null
  @State private var inheritPresets = true
  @State private var selection: Set<String> = []
  @State private var instructions = ""
  @State private var temperature = ""
  @State private var advanced = "{}"
  @State private var recapEnabled = false
  @State private var inheritInstructions = true
  @State private var instructionImport = false
  @State private var preset: JSONValue = .null
  @State private var presetName = ""
  @State private var presetBody = ""
  @State private var status = ""
  @State private var busy = false
  @State private var namespace: String?
  private var owner: String { model.connection?.credentials.owner_id ?? "" }
  var body: some View {
    Form {
      Section("回应配置") {
        Picker("作用范围", selection: $subject) {
          Text("全局默认").tag(owner)
          ForEach(model.items("actor")) { a in Text(a.name).tag(a.id) }
        }.onChange(of: subject) { _, _ in loadProfile() }
        Text("未填写的参数继承全局。共享预设按引用使用，修改后在下一次请求生效；已开始的请求保持原配置。").font(EchoFont.caption)
        TextField("温度（空白继承）", text: $temperature)
        Toggle("继承全局额外指令", isOn: $inheritInstructions)
        Toggle("离开超过两小时后生成辅助回顾", isOn: $recapEnabled)
        Text("回顾会单独请求模型并计入用量；成功后仅用于两轮，失败不阻止普通对话。").font(EchoFont.caption)
        Button("从 Markdown 导入指令") { instructionImport = true }
        TextEditor(text: $instructions).frame(minHeight: 80).accessibilityLabel("额外指令")
        Toggle("继承全局预设", isOn: $inheritPresets)
        if !inheritPresets {
          ForEach(library["presets"].array, id: \.self) { p in
            Toggle(
              p["name"].string,
              isOn: Binding(
                get: { selection.contains(p["id"].string) },
                set: {
                  if $0 {
                    selection.insert(p["id"].string)
                  } else {
                    selection.remove(p["id"].string)
                  }
                }))
          }
        }
        DisclosureGroup("高级配置与外部变量") {
          Text(
            "可填写 parameters、body、variables。变量声明包含 name、url、method、required、json_path；凭据仅使用 credential_ref。保留字段如 model、messages、tools 由服务器拒绝。"
          ).font(EchoFont.caption)
          JSONSourceEditor(
            text: $advanced, accessibilityTitle: "高级回应配置", identifier: "prompt-advanced"
          ).frame(minHeight: 140)
        }
        Button("保存回应配置") { Task { await saveProfile() } }
      }
      Section("共享预设库") {
        ForEach(library["presets"].array, id: \.self) { p in
          Button(p["name"].string) {
            preset = p
            presetName = p["name"].string
            presetBody = p["data"]["entries"].array.first?["content"].string ?? ""
          }
        }
        Button("新建预设") {
          preset = .null
          presetName = ""
          presetBody = ""
        }
        TextField("预设名称", text: $presetName)
        TextEditor(text: $presetBody).frame(minHeight: 120).accessibilityLabel("预设首条指令")
        Text("支持 {{char}}、{{user}}、{{content}}、{{date}}、{{time}} 和已声明变量。此处编辑第一条指令，保留其余条目及参数。").font(
          EchoFont.caption)
        Button(preset == .null ? "创建预设" : "保存共享预设") { Task { await savePreset() } }
        if preset != .null { Button("复制为独立预设") { Task { await clone() } } }
      }
      if !status.isEmpty { Text(status) }
    }.formStyle(.grouped).navigationTitle("预设与请求配置").disabled(busy)
      .task {
        namespace = model.connection?.namespace
        subject = owner
        await refresh()
        loadProfile()
      }
      .fileImporter(
        isPresented: $instructionImport,
        allowedContentTypes: [.plainText, UTType(filenameExtension: "md") ?? .plainText]
      ) { result in
        do {
          let url = try result.get()
          let access = url.startAccessingSecurityScopedResource()
          defer { if access { url.stopAccessingSecurityScopedResource() } }
          guard (try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) <= 64000 else {
            throw APIError(status: 413, code: "invalid_request")
          }
          instructions = try String(contentsOf: url, encoding: .utf8)
          inheritInstructions = false
        } catch { status = userFacingError(error) }
      }
  }
  private func perform(_ work: () async throws -> Void) async {
    busy = true
    defer { busy = false }
    do {
      guard namespace == model.connection?.namespace else {
        throw APIError(status: 409, code: "connection_changed")
      }
      try await work()
    } catch { status = userFacingError(error) }
  }
  private func refresh() async {
    await perform { library = try await milestoneCall(model, "promptLibrary") }
  }
  private func loadProfile() {
    profile = library["profiles"].array.first { $0["subject_id"].string == subject } ?? .null
    let data = profile["data"]
    instructions = data["instructions"].string
    inheritInstructions = data["instructions"] == .null
    recapEnabled = data["time_recap"].bool
    if case .number(let number) = data["parameters"]["temperature"] {
      temperature = String(number)
    } else {
      temperature = ""
    }
    inheritPresets = data["preset_ids"] == .null
    selection = Set(data["preset_ids"].array.map(\.string))
    var rest = data.object
    rest.removeValue(forKey: "instructions")
    rest.removeValue(forKey: "preset_ids")
    var parameters = rest["parameters"]?.object ?? [:]
    parameters.removeValue(forKey: "temperature")
    rest["parameters"] = .object(parameters)
    if let encoded = try? JSONEncoder().encode(JSONValue.object(rest)) {
      advanced = String(decoding: encoded, as: UTF8.self)
    }
  }
  private func saveProfile() async {
    await perform {
      var data = try JSONDecoder().decode(JSONValue.self, from: Data(advanced.utf8)).object
      if !inheritInstructions { data["instructions"] = .string(instructions) }
      data["time_recap"] = .bool(recapEnabled)
      if !temperature.isEmpty {
        guard let value = Double(temperature) else {
          throw APIError(status: 400, code: "invalid_request")
        }
        var params = data["parameters"]?.object ?? [:]
        params["temperature"] = .number(value)
        data["parameters"] = .object(params)
      }
      if !inheritPresets { data["preset_ids"] = .strings(selection.sorted()) }
      _ = try await milestoneCall(
        model, "saveProfile",
        [
          "subject_id": .string(subject),
          "expected_revision": .number(Double(profile["revision"].int)), "data": .object(data),
        ], command: true)
      library = try await milestoneCall(model, "promptLibrary")
      loadProfile()
      status = "回应配置已保存"
    }
  }
  private func savePreset() async {
    await perform {
      var data = preset["data"].object
      var entries = data["entries"]?.array ?? []
      var first =
        entries.first?.object ?? [
          "enabled": .bool(true), "role": .string("system"),
          "position": .string("before_character"), "depth": .number(0),
        ]
      first["content"] = .string(presetBody)
      if entries.isEmpty { entries.append(.object(first)) } else { entries[0] = .object(first) }
      data["entries"] = .array(entries)
      var body: [String: JSONValue] = [
        "name": .string(presetName), "expected_revision": .number(Double(preset["revision"].int)),
        "data": .object(data),
      ]
      if preset != .null { body["id"] = preset["id"] }
      let result = try await milestoneCall(model, "savePreset", body, command: true)
      library = try await milestoneCall(model, "promptLibrary")
      preset = library["presets"].array.first { $0["id"] == result["id"] } ?? .null
      status = "预设已保存；所有引用将在下一轮使用新版本"
    }
  }
  private func clone() async {
    await perform {
      _ = try await milestoneCall(
        model, "clonePreset", ["id": preset["id"], "name": .string(presetName + " 副本")],
        command: true)
      library = try await milestoneCall(model, "promptLibrary")
      status = "已创建独立副本"
    }
  }
}

private func conversationPDF(_ text: String) throws -> Data {
  let data = NSMutableData()
  guard let consumer = CGDataConsumer(data: data as CFMutableData) else {
    throw APIError(status: 500, code: "pdf_failed")
  }
  var page = CGRect(x: 0, y: 0, width: 595, height: 842)
  guard let context = CGContext(consumer: consumer, mediaBox: &page, nil) else {
    throw APIError(status: 500, code: "pdf_failed")
  }
  let font = CTFontCreateWithName("Helvetica" as CFString, 12, nil)
  let attributes = [NSAttributedString.Key(kCTFontAttributeName as String): font]
  let attributed = NSAttributedString(string: text, attributes: attributes)
  let framesetter = CTFramesetterCreateWithAttributedString(attributed)
  var location = 0
  repeat {
    context.beginPDFPage(nil)
    let path = CGPath(rect: page.insetBy(dx: 40, dy: 40), transform: nil)
    let frame = CTFramesetterCreateFrame(
      framesetter, CFRange(location: location, length: 0), path, nil)
    CTFrameDraw(frame, context)
    let visible = CTFrameGetVisibleStringRange(frame)
    context.endPDFPage()
    if visible.length == 0 { break }
    location += visible.length
  } while location < attributed.length
  context.closePDF()
  return data as Data
}

struct AttachmentComposerView: View {
  var model: AppModel
  var room: Record
  @State private var picker = false
  @State private var bytes: Data?
  @State private var mime = ""
  @State private var filename = ""
  @State private var content = ""
  @State private var asset: JSONValue = .null
  @State private var operation = UUID().uuidString
  @State private var imageInputMode = "original"
  @State private var preparedMode = "original"
  @State private var visionJob: JSONValue = .null
  @State private var uploadOperation = UUID().uuidString
  @State private var namespace: String?
  @State private var status = ""
  @State private var busy = false
  @Environment(\.dismiss) private var dismiss
  private var draftKey: String { room.id + "/attachment-message" }
  var body: some View {
    NavigationStack {
      Form {
        Text("选择图片只准备附件，明确发送后才会请求模型。每张最多 1 MiB；支持 PNG、JPEG、WebP 和 GIF。").font(EchoFont.caption)
        Button("选择图片") { picker = true }
        Picker(
          "发送方式",
          selection: Binding(
            get: { imageInputMode },
            set: {
              imageInputMode = $0
              operation = UUID().uuidString
              persist()
            })
        ) {
          Text("原图").tag("original")
          Text("提取文字").tag("text")
          Text("原图与文字").tag("both")
          Text("仅元数据").tag("metadata")
        }
        Text("文字提取会使用此对话首位成员的视觉服务；仅元数据不会把原图发给模型。").font(EchoFont.caption)
        if !filename.isEmpty { Text(filename) }
        TextEditor(
          text: Binding(
            get: { content },
            set: {
              content = $0
              operation = UUID().uuidString
              persist()
            })
        )
        .frame(minHeight: 130).accessibilityLabel("图片附言")
        Button("发送图片与文字") { Task { await send() } }
        if !status.isEmpty { Text(status) }
      }.formStyle(.grouped).navigationTitle("图片消息").disabled(busy)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("完成") { dismiss() } } }
        .task {
          namespace = model.connection?.namespace
          if let data = model.draft(room: draftKey).data(using: .utf8),
            let saved = try? JSONDecoder().decode(JSONValue.self, from: data)
          {
            content = saved["content"].string
            asset = saved["asset"]
            filename = saved["filename"].string
            imageInputMode =
              saved["input_mode"].string.isEmpty ? "original" : saved["input_mode"].string
            preparedMode =
              saved["prepared_mode"].string.isEmpty ? "original" : saved["prepared_mode"].string
            visionJob = saved["vision_job"]
            if !saved["operation"].string.isEmpty { operation = saved["operation"].string }
          }
        }
        .fileImporter(
          isPresented: $picker,
          allowedContentTypes: [.png, .jpeg, .gif, UTType(filenameExtension: "webp") ?? .image]
        ) { result in
          do {
            let url = try result.get()
            let access = url.startAccessingSecurityScopedResource()
            defer { if access { url.stopAccessingSecurityScopedResource() } }
            let values = try url.resourceValues(forKeys: [.fileSizeKey, .contentTypeKey])
            guard (values.fileSize ?? 0) <= 1_048_576 else {
              throw APIError(status: 413, code: "invalid_asset")
            }
            bytes = try Data(contentsOf: url)
            mime = values.contentType?.preferredMIMEType ?? ""
            filename = url.lastPathComponent
            asset = .null
            preparedMode = "original"
            visionJob = .null
            operation = UUID().uuidString
            uploadOperation = UUID().uuidString
            persist()
          } catch { status = userFacingError(error) }
        }
    }.frame(minWidth: 320, idealWidth: 560, minHeight: 400)
  }
  private func persist() {
    guard namespace == model.connection?.namespace else { return }
    let value: JSONValue = .object([
      "content": .string(content), "asset": asset, "filename": .string(filename),
      "operation": .string(operation),
      "input_mode": .string(imageInputMode), "prepared_mode": .string(preparedMode),
      "vision_job": visionJob,
    ])
    if let data = try? JSONEncoder().encode(value) {
      model.saveDraft(room: draftKey, content: String(decoding: data, as: UTF8.self))
    }
  }
  private func send() async {
    busy = true
    defer { busy = false }
    do {
      guard namespace == model.connection?.namespace else {
        throw APIError(status: 409, code: "connection_changed")
      }
      guard ChatPresentation.canSend(content) else {
        throw APIError(status: 400, code: "invalid_request")
      }
      if asset == .null {
        guard let bytes else { throw APIError(status: 400, code: "resource_missing") }
        asset = try await model.operations(
          action: "createAsset",
          body: .object([
            "operation_id": .string(uploadOperation), "world_id": room["world_id"],
            "mime": .string(mime), "content_base64": .string(bytes.base64EncodedString()),
          ]))
        persist()
      }
      if imageInputMode != preparedMode, let actorID = room["actor_ids"].array.first {
        var p: [String: JSONValue] = [
          "id": asset["id"], "actor_id": actorID, "mode": .string(imageInputMode),
        ]
        if imageInputMode == "text" || imageInputMode == "both" {
          if visionJob == .null {
            visionJob = try await featureCall(
              model, "createMediaJob",
              [
                "actor_id": actorID, "kind": .string("vision"), "prompt": .string("提取图片中的文字与可见内容"),
                "asset_id": asset["id"],
              ])
            persist()
          }
          let result = try await featureCall(model, "refreshMediaJob", ["id": visionJob["id"]])
          guard result["state"].string == "completed" else {
            throw APIError(status: 409, code: "vision_required")
          }
          p["vision_job_id"] = visionJob["id"]
        }
        let prepared = try await featureCall(
          model, "prepareImage", p, revision: asset["revision"].int)
        var a = asset.object
        a["revision"] = prepared["revision"]
        asset = .object(a)
        preparedMode = imageInputMode
        persist()
      }
      _ = try await model.operations(
        action: "sendAttached", id: room.id,
        body: .object([
          "client_command_id": .string(operation), "content": .string(content),
          "asset_ids": .array([asset["id"]]),
        ]))
      model.saveDraft(room: draftKey, content: "")
      dismiss()
    } catch { status = userFacingError(error) }
  }
}

struct RequestSnapshotView: View {
  var model: AppModel
  var room: Record
  @State private var selected = ""
  @State private var snapshots: [JSONValue] = []
  @State private var recaps: [JSONValue] = []
  @State private var failure = ""
  var body: some View {
    Form {
      Picker("轮次", selection: $selected) {
        Text("请选择").tag("")
        ForEach(model.items("run").filter { $0["room_id"].string == room.id }) { run in
          Text(run["created_at"].string + " · " + run["state"].string).tag(run.id)
        }
      }.onChange(of: selected) { _, _ in Task { await load() } }
      ForEach(snapshots, id: \.self) { item in
        DisclosureGroup("请求 \(item["attempt"].int)") {
          Text(item["payload_hash"].string).font(EchoFont.caption).textSelection(.enabled)
          Text(pretty(item["payload"])).font(EchoFont.caption).textSelection(.enabled)
        }
      }
      Section("单独计费的辅助回顾") {
        ForEach(recaps, id: \.self) { item in
          Text(item["state"].string + " · " + item["created_at"].string)
          Text(pretty(item["usage"])).font(EchoFont.caption)
        }
      }
      if !failure.isEmpty { Text(failure) }
    }.navigationTitle("实际请求记录").task { await load() }
  }
  private func pretty(_ value: JSONValue) -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    return (try? String(decoding: encoder.encode(value), as: UTF8.self)) ?? ""
  }
  private func load() async {
    do {
      recaps = try await milestoneCall(model, "recapHistory", ["id": .string(room.id)])["items"]
        .array
      if !selected.isEmpty {
        snapshots = try await milestoneCall(model, "requestSnapshots", ["id": .string(selected)])[
          "items"
        ].array
      }
      failure = ""
    } catch { failure = userFacingError(error) }
  }
}

@MainActor
func featureCall(
  _ model: AppModel, _ name: String, _ payload: [String: JSONValue] = [:], revision: Int = 0
) async throws -> JSONValue {
  try await milestoneCall(
    model, "feature",
    [
      "command": .string(name), "payload": .object(payload),
      "expected_revision": .number(Double(revision)),
    ], command: true)
}
func featureJSON(_ value: JSONValue) -> String {
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
  return (try? String(decoding: encoder.encode(value), as: UTF8.self)) ?? "{}"
}
struct FeatureHubView: View {
  var model: AppModel
  @State private var actor = ""
  var body: some View {
    Form {
      Picker("角色", selection: $actor) {
        Text("请选择").tag("")
        ForEach(model.items("actor")) { Text($0.name).tag($0.id) }
      }
      if let a = model.items("actor").first(where: { $0.id == actor }) {
        NavigationLink("记忆模式与资料") { MemoryMaterialsView(model: model, actor: a) }
        NavigationLink("设定书库") { BookLibraryView(model: model, actor: a) }
        NavigationLink("图像、视频与语音服务") { MediaWorkbenchView(model: model, actor: a) }
        NavigationLink("扩展与技能") { ExtensionLibraryView(model: model, actor: a) }
        NavigationLink("可运行作品") { MiniAppLibraryView(model: model, actor: a) }
      }
      Section("对话") {
        ForEach(model.items("room").filter { $0["kind"].string == "group" }) { room in
          NavigationLink(room.name + " · 群配置") { GroupPolicyView(model: model, room: room) }
        }
        ForEach(model.items("room").filter { $0["kind"].string == "direct" }) { room in
          NavigationLink(room.name + " · 语音") { VoiceConversationView(model: model, room: room) }
        }
      }
    }.navigationTitle("知识与创作").formStyle(.grouped)
      .task { if actor.isEmpty { actor = model.items("actor").first?.id ?? "" } }
  }
}
struct MemoryMaterialsView: View {
  var model: AppModel
  var actor: Record
  @State private var library: JSONValue = .null
  @State private var mode = "structured"
  @State private var recall = "standard"
  @State private var vector = "both"
  @State private var interval = 300
  @State private var kind = "fact"
  @State private var title = ""
  @State private var content = ""
  @State private var summary = ""
  @State private var room = ""
  @State private var status = ""
  @State private var editing: JSONValue = .null
  @State private var correction: JSONValue = .null
  var body: some View {
    Form {
      Section("模式与召回") {
        Picker("整理模式", selection: $mode) {
          Text("结构化").tag("structured")
          Text("日记").tag("diary")
        }
        Picker("召回", selection: $recall) {
          Text("轻量").tag("light")
          Text("标准").tag("standard")
          Text("深入").tag("deep")
        }
        Picker("向量来源", selection: $vector) {
          Text("用户消息").tag("user")
          Text("双方消息").tag("both")
        }
        Stepper("整理间隔 \(interval) 秒", value: $interval, in: 60...86400, step: 60)
        Button("保存模式") {
          perform {
            _ = try await featureCall(
              model, "setMemoryPolicy",
              [
                "actor_id": .string(actor.id), "mode": .string(mode), "recall": .string(recall),
                "vector_scope": .string(vector), "interval_seconds": .number(Double(interval)),
              ], revision: library["policy"]["revision"].int)
            await load()
          }
        }
        Text("切换模式保留原有资料。资料目录只提供简介，正文须明确读取。")
        Picker("来源对话", selection: $room) {
          Text("请选择").tag("")
          ForEach(model.items("room").filter { $0["world_id"] == actor["world_id"] }) {
            Text($0.name).tag($0.id)
          }
        }
        Button("立即整理（使用模型服务）") {
          perform {
            let r = try await featureCall(
              model, "organizeMemory", ["actor_id": .string(actor.id), "room_id": .string(room)])
            status = featureJSON(r)
            await load()
          }
        }
        if let r = model.items("room").first(where: { $0.id == room }) {
          Button("允许此对话参与记忆") { participation(r, true) }
          Button("停止此对话参与记忆") { participation(r, false) }
        }
      }
      ForEach(["source_shards", "index_shards"], id: \.self) { kind in
        if !library[kind].array.isEmpty {
          Section(kind == "source_shards" ? "原话索引待处理片段" : "事实索引待处理片段") {
            ForEach(library[kind].array, id: \.self) { shard in
              Text(shard["state"].string + " · " + shard["error_code"].string)
              HStack {
                Button("重试此片段") { handleShard(shard, kind, false) }
                Button("本次重建跳过") { handleShard(shard, kind, true) }
              }
            }
          }
        }
      }
      Section("资料编辑") {
        Picker("类型", selection: $kind) {
          ForEach(["fact", "profile", "diary", "structured", "info", "event"], id: \.self) {
            Text($0).tag($0)
          }
        }
        TextField("标题", text: $title)
        TextField("简介", text: $summary)
        TextEditor(text: $content).frame(minHeight: 140).accessibilityLabel("资料正文")
        Button(editing == .null ? "新增资料" : "保存修改") {
          perform {
            var p: [String: JSONValue] = [
              "actor_id": .string(actor.id), "kind": .string(kind), "title": .string(title),
              "content": .string(content), "summary": .string(summary),
            ]
            if editing != .null { p["id"] = editing["id"] }
            _ = try await featureCall(model, "saveMaterial", p, revision: editing["revision"].int)
            editing = .null
            content = ""
            await load()
          }
        }
        if editing != .null {
          Button("预览纠正") {
            perform {
              correction = try await featureCall(
                model, "previewMemoryCorrection",
                [
                  "actor_id": .string(actor.id),
                  "changes": .array([.object(["id": editing["id"], "content": .string(content)])]),
                ])
            }
          }
        }
        if correction != .null {
          Text(featureJSON(correction)).font(.caption).textSelection(.enabled)
          Button("应用此纠正") { correct("applyMemoryCorrection") }
          Button("撤销此纠正") { correct("undoMemoryCorrection") }
        }
      }
      Section("已保存资料") {
        ForEach(library["materials"].array, id: \.self) { m in
          VStack(alignment: .leading) {
            Button(m["title"].string) {
              editing = m
              title = m["title"].string
              kind = m["kind"].string
              content = m["content"].string
              summary = m["summary"].string
            }
            Text(m["summary"].string)
            if m["source_missing"].bool { Text("来源已失效，保留资料供人工检查").foregroundStyle(.secondary) }
            HStack {
              Button("减少使用") { feedback(m, "less") }
              Button("已过时") { feedback(m, "outdated") }
              Button("正常使用") { feedback(m, "normal") }
            }
          }
        }
      }
      Text(status).textSelection(.enabled)
    }.navigationTitle("记忆与资料").formStyle(.grouped).task { await load() }
  }
  private func handleShard(_ shard: JSONValue, _ kind: String, _ skip: Bool) {
    perform {
      _ = try await featureCall(
        model, kind == "source_shards" ? "sourceIndexShard" : "indexShard",
        [
          "actor_id": .string(actor.id),
          "id": shard[kind == "source_shards" ? "message_id" : "memory_id"], "skip": .bool(skip),
        ])
      await load()
    }
  }
  private func perform(_ body: @escaping @MainActor () async throws -> Void) {
    Task { do { try await body() } catch { status = userFacingError(error) } }
  }
  private func load() async {
    do {
      library = try await featureCall(model, "memoryLibrary", ["actor_id": .string(actor.id)])
      let p = library["policy"]
      mode = p["mode"].string
      recall = p["recall"].string
      vector = p["vector_scope"].string
      interval = p["interval_seconds"].int
    } catch { status = userFacingError(error) }
  }
  private func participation(_ r: Record, _ enabled: Bool) {
    perform {
      _ = try await featureCall(
        model, "setMemoryParticipation",
        ["actor_id": .string(actor.id), "room_id": .string(r.id), "enabled": .bool(enabled)],
        revision: r["revision"].int)
      try await model.refreshSettings()
    }
  }
  private func feedback(_ m: JSONValue, _ value: String) {
    perform {
      _ = try await featureCall(
        model, "memoryFeedback",
        ["actor_id": .string(actor.id), "id": m["id"], "feedback": .string(value)],
        revision: m["revision"].int)
      await load()
    }
  }
  private func correct(_ name: String) {
    perform {
      _ = try await featureCall(
        model, name, ["actor_id": .string(actor.id), "id": correction["id"]])
      await load()
    }
  }
}
struct BookLibraryView: View {
  var model: AppModel
  var actor: Record
  @State private var library: JSONValue = .null
  @State private var entry: JSONValue = .null
  @State private var book = ""
  @State private var name = ""
  @State private var advanced = "{}"
  @State private var bodyText = ""
  @State private var keys = ""
  @State private var exclude = ""
  @State private var scope = "actor"
  @State private var target = ""
  @State private var status = ""
  @State private var constant = false
  var body: some View {
    Form {
      TextField("书名 / 条目名", text: $name)
      Button("创建设定书") {
        run {
          let b = try await featureCall(
            model, "createBook", ["world_id": actor["world_id"], "name": .string(name)])
          book = b["id"].string
          await load()
        }
      }
      Picker("设定书", selection: $book) {
        Text("请选择").tag("")
        ForEach(library["books"].array, id: \.self) { Text($0["name"].string).tag($0["id"].string) }
      }
      Section("绑定") {
        Picker("范围", selection: $scope) {
          Text("角色").tag("actor")
          Text("对话").tag("room")
          Text("群成员").tag("group_member")
          Text("当前设定集全局").tag("global")
        }
        if scope == "room" || scope == "group_member" {
          Picker("对话", selection: $target) {
            Text("请选择").tag("")
            ForEach(model.items("room").filter { $0["world_id"] == actor["world_id"] }) {
              Text($0.name).tag($0.id)
            }
          }
        }
        Button("绑定选中范围") { bind(true) }
        Button("解除选中范围") { bind(false) }
      }
      Section("条目") {
        Toggle("常驻", isOn: $constant)
        TextField("关键词，用逗号分隔", text: $keys)
        TextField("排除词，用逗号分隔", text: $exclude)
        TextEditor(text: $bodyText).frame(minHeight: 160).accessibilityLabel("设定正文")
        DisclosureGroup("高级触发与注入规则") {
          Text(
            "可设置 required_groups、whole_word、scan_depth、sticky_turns / cooldown_turns / delay_turns（均按消息数）、probability、priority、exclusion_group、weight、keyword_scoring、recursion、max_recursion、insertion_slot、injection_depth、injection_role。零递归上限仍受预算和工作量硬限制。"
          ).font(EchoFont.caption)
          TextEditor(text: $advanced).frame(minHeight: 120).accessibilityLabel("高级世界书规则 JSON")
        }
        Button("保存条目") {
          run {
            var data: [String: JSONValue] = [
              "name": .string(name), "content": .string(bodyText), "enabled": .bool(true),
              "constant": .bool(constant),
              "keys": .array(keys.split(separator: ",").map { .string(String($0)) }),
              "exclude_keys": .array(exclude.split(separator: ",").map { .string(String($0)) }),
              "case_sensitive": .bool(false), "scan_depth": .number(8), "priority": .number(0),
              "insertion_slot": .string("before_history"), "injection_depth": .number(0),
              "audience_actor_ids": .array([]),
            ]
            if entry != .null { data = entry["data"].object.merging(data) { _, new in new } }
            let extra = try JSONDecoder().decode(JSONValue.self, from: Data(advanced.utf8))
            data = data.merging(extra.object) { _, new in new }
            var p: [String: JSONValue] = [
              "world_id": actor["world_id"], "book_id": .string(book), "data": .object(data),
            ]
            if entry != .null { p["id"] = entry["id"] }
            _ = try await featureCall(model, "saveBookEntry", p, revision: entry["revision"].int)
            entry = .null
            await load()
          }
        }
        ForEach(library["entries"].array.filter { $0["book_id"].string == book }, id: \.self) { e in
          Button(e["data"]["name"].string) {
            entry = e
            let basic: Set<String> = [
              "name", "content", "enabled", "constant", "keys", "exclude_keys",
              "audience_actor_ids",
            ]
            advanced = featureJSON(.object(e["data"].object.filter { !basic.contains($0.key) }))
            exclude = e["data"]["exclude_keys"].array.map(\.string).joined(separator: ",")
            name = e["data"]["name"].string
            bodyText = e["data"]["content"].string
            constant = e["data"]["constant"].bool
            keys = e["data"]["keys"].array.map(\.string).joined(separator: ",")
          }
        }
      }
      Text(status)
    }.navigationTitle("设定书库").formStyle(.grouped).task { await load() }
  }
  private func run(_ body: @escaping @MainActor () async throws -> Void) {
    Task { do { try await body() } catch { status = userFacingError(error) } }
  }
  private func load() async {
    do {
      library = try await featureCall(model, "bookLibrary", ["world_id": actor["world_id"]])
    } catch { status = userFacingError(error) }
  }
  private func bind(_ enabled: Bool) {
    run {
      let targetID =
        scope == "actor"
        ? actor.id : scope == "global" ? model.connection?.credentials.owner_id ?? "" : target
      let old =
        library["bindings"].array.first {
          $0["book_id"].string == book && $0["scope"].string == scope
            && $0["target_id"].string == targetID
            && (scope != "group_member" || $0["actor_id"].string == actor.id)
        } ?? .null
      var p: [String: JSONValue] = [
        "world_id": actor["world_id"], "book_id": .string(book), "scope": .string(scope),
        "target_id": .string(targetID), "enabled": .bool(enabled),
      ]
      if scope == "group_member" { p["actor_id"] = .string(actor.id) }
      _ = try await featureCall(model, "bindBook", p, revision: old["revision"].int)
      await load()
    }
  }
}

struct MediaWorkbenchView: View {
  var model: AppModel
  var actor: Record
  @State private var providerOptions = "{}"
  @State private var configProvider = ""
  @State private var library: JSONValue = .null
  @State private var kind = "image"
  @State private var prompt = ""
  @State private var asset = ""
  @State private var status = ""
  @State private var mode = "original"
  @State private var visionJob = ""
  @State private var externalID = ""
  var body: some View {
    Form {
      NavigationLink("配置各能力服务") {
        ChatModelRouteView(
          model: model, members: [actor], capability: kind == "edit" ? "image" : kind)
      }
      Section("供应商参数（保存不调用服务）") {
        Picker("连接", selection: $configProvider) {
          Text("请选择").tag("")
          ForEach(library["providers"].array, id: \.self) {
            Text($0["name"].string).tag($0["id"].string)
          }
        }.onChange(of: configProvider) { _, id in
          providerOptions = featureJSON(
            library["providers"].array.first { $0["id"].string == id }?["media_options"]
              ?? .object([:]))
        }
        Text("可设置 image.size、video.seconds / size、tts.voice。音色克隆仅在后续供应商适配器确认支持后开放。").font(
          EchoFont.caption)
        TextEditor(text: $providerOptions).frame(minHeight: 90).accessibilityLabel("媒体服务参数 JSON")
        Button("保存媒体参数") {
          run {
            let value = try JSONDecoder().decode(JSONValue.self, from: Data(providerOptions.utf8))
            let provider =
              library["providers"].array.first { $0["id"].string == configProvider } ?? .null
            _ = try await featureCall(
              model, "mediaConfig", ["id": .string(configProvider), "options": value],
              revision: provider["revision"].int)
            await load()
          }
        }
      }
      Picker("能力", selection: $kind) {
        Text("生图").tag("image")
        Text("编辑图片").tag("edit")
        Text("图片转文字").tag("vision")
        Text("视频").tag("video")
        Text("语音转文字").tag("stt")
        Text("文字转语音").tag("tts")
      }
      TextEditor(text: $prompt).frame(minHeight: 120).accessibilityLabel("创作内容")
      Picker("输入资源（需要时选择）", selection: $asset) {
        Text("无").tag("")
        ForEach(
          model.items("asset").filter {
            $0["world_id"] == actor["world_id"]
              && ($0["actor_id"].string.isEmpty || $0["actor_id"].string == actor.id)
          }
        ) { Text($0["mime"].string + " · " + $0.id.prefix(8)).tag($0.id) }
      }
      Button("提交任务（使用所选服务）") {
        run {
          var p: [String: JSONValue] = [
            "actor_id": .string(actor.id), "kind": .string(kind), "prompt": .string(prompt),
          ]
          if !asset.isEmpty { p["asset_id"] = .string(asset) }
          _ = try await featureCall(model, "createMediaJob", p)
          await load()
        }
      }
      Section("图片输入方式") {
        Picker("发送方式", selection: $mode) {
          Text("原图").tag("original")
          Text("提取文字").tag("text")
          Text("原图与文字").tag("both")
          Text("仅元数据").tag("metadata")
        }
        Picker("文字提取结果", selection: $visionJob) {
          Text("请选择").tag("")
          ForEach(
            library["jobs"].array.filter {
              $0["kind"].string == "vision" && $0["state"].string == "completed"
            }, id: \.self
          ) { Text($0["result"]["text"].string.prefix(60)).tag($0["id"].string) }
        }
        Button("保存资源的输入方式") {
          run {
            var p: [String: JSONValue] = [
              "id": .string(asset), "actor_id": .string(actor.id), "mode": .string(mode),
            ]
            if !visionJob.isEmpty { p["vision_job_id"] = .string(visionJob) }
            let a = model.items("asset").first { $0.id == asset }
            _ = try await featureCall(model, "prepareImage", p, revision: a?["revision"].int ?? 0)
          }
        }
      }
      Section("持久任务") {
        TextField("服务端视频任务编号（结果未知时核对）", text: $externalID)
        ForEach(library["jobs"].array.filter { $0["actor_id"].string == actor.id }, id: \.self) {
          job in
          VStack(alignment: .leading) {
            Text(job["kind"].string + " · " + job["state"].string)
            Text(job["error_code"].string)
            Text(featureJSON(job["result"])).textSelection(.enabled)
            Button("刷新原任务") {
              run {
                _ = try await featureCall(model, "refreshMediaJob", ["id": job["id"]])
                await load()
              }
            }
            if job["state"].string == "unknown" && job["kind"].string == "video" {
              Button("按此编号核对，继续查询") {
                run {
                  _ = try await featureCall(
                    model, "reconcileMediaJob",
                    ["id": job["id"], "external_id": .string(externalID)])
                  await load()
                }
              }
            }
          }
        }
      }
      Text(status)
    }.navigationTitle("媒体创作").formStyle(.grouped).task { await load() }
  }
  private func run(_ body: @escaping @MainActor () async throws -> Void) {
    Task { do { try await body() } catch { status = userFacingError(error) } }
  }
  private func load() async {
    do { library = try await featureCall(model, "mediaLibrary") } catch {
      status = userFacingError(error)
    }
  }
}
struct ExtensionLibraryView: View {
  var model: AppModel
  var actor: Record
  @State private var library: JSONValue = .null
  @State private var preview: JSONValue = .null
  @State private var package: JSONValue = .null
  @State private var uninstall: JSONValue = .null
  @State private var skillRoom = ""
  @State private var skillMessage = ""
  @State private var source = ""
  @State private var status = ""
  @State private var importing = false
  @State private var connections = false
  var body: some View {
    Form {
      Picker("使用技能的对话", selection: $skillRoom) {
        Text("请选择").tag("")
        ForEach(model.items("room").filter { $0["actor_ids"].array.contains(.string(actor.id)) }) {
          Text($0.name).tag($0.id)
        }
      }
      TextField("本轮内容", text: $skillMessage)
      Toggle("导入 MCP 连接整库", isOn: $connections)
      Button("选择扩展包 / 连接 JSON") { importing = true }
      TextEditor(text: $source).frame(minHeight: 140).accessibilityLabel("扩展包 JSON")
      Button("验证并预览") {
        run {
          package = try JSONDecoder().decode(JSONValue.self, from: Data(source.utf8))
          preview = try await featureCall(
            model, connections ? "previewConnectionImport" : "previewExtension", payload())
        }
      }
      if preview != .null {
        Text(featureJSON(preview)).textSelection(.enabled)
        Button("按预览安装 / 替换") {
          run {
            var p = payload()
            p["preview_token"] = preview["preview_token"]
            _ = try await featureCall(
              model, connections ? "applyConnectionImport" : "installExtension", p)
            preview = .null
            await load()
          }
        }
      }
      Text("导入包不含密钥；安装不自动授予工具或网络权限。网页会话按扩展隔离。")
      ForEach(library["installs"].array, id: \.self) { item in
        Section(item["manifest"]["name"].string) {
          Text(item["state"].string)
          if !item["late_receipts"].array.isEmpty {
            Text("取消后的远端回执：" + featureJSON(item["late_receipts"])).textSelection(.enabled)
          }
          if item["state"].string == "installed" {
            if ["python", "card"].contains(item["manifest"]["runtime"].string) {
              Button("创建可运行作品（默认不允许运行）") {
                run {
                  _ = try await featureCall(
                    model, "createAppFromExtension",
                    ["id": item["id"], "actor_id": .string(actor.id)])
                  status = "已保存到可运行作品，请单独设置运行权限"
                }
              }
            }
            if item["manifest"]["runtime"].string == "instructions" {
              Button("本轮明确使用此技能") {
                run {
                  _ = try await featureCall(
                    model, "sendWithSkill",
                    [
                      "id": item["id"], "actor_id": .string(actor.id),
                      "room_id": .string(skillRoom), "content": .string(skillMessage),
                    ])
                  skillMessage = ""
                }
              }
              ForEach(["off", "manual", "candidate", "auto"], id: \.self) { mode in
                Button(mode) {
                  run {
                    let b =
                      library["bindings"].array.first {
                        $0["install_id"] == item["id"] && $0["actor_id"].string == actor.id
                      } ?? .null
                    _ = try await featureCall(
                      model, "setSkillMode",
                      ["id": item["id"], "actor_id": .string(actor.id), "mode": .string(mode)],
                      revision: b["revision"].int)
                    await load()
                  }
                }
              }
            }
            if item["manifest"]["runtime"].string == "web",
              let url = URL(string: item["manifest"]["url"].string)
            {
              NavigationLink("打开独立网页会话") {
                IsolatedExtensionWebView(url: url).navigationTitle(item["manifest"]["name"].string)
              }
            }
            Button("预览卸载") {
              run {
                uninstall = try await featureCall(model, "previewUninstall", ["id": item["id"]])
              }
            }
          }
        }
      }
      if uninstall != .null {
        Text(featureJSON(uninstall))
        Button("确认卸载") {
          run {
            _ = try await featureCall(
              model, "uninstallExtension",
              ["id": uninstall["id"], "preview_token": uninstall["preview_token"]],
              revision: uninstall["revision"].int)
            uninstall = .null
            await load()
          }
        }
      }
      Text(status)
    }.navigationTitle("扩展与技能").formStyle(.grouped).task { await load() }.fileImporter(
      isPresented: $importing, allowedContentTypes: [.json]
    ) { r in
      do {
        let url = try r.get()
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        guard (try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) <= 1_048_576 else {
          throw APIError(status: 413, code: "invalid_manifest")
        }
        source = try String(contentsOf: url, encoding: .utf8)
      } catch { status = userFacingError(error) }
    }
  }
  private func payload() -> [String: JSONValue] {
    connections
      ? ["connections": package]
      : [
        "manifest": package["manifest"], "resources": package["resources"],
        "connection_ids": package["connection_ids"] == .null
          ? .array([]) : package["connection_ids"],
        "new_connections": package["new_connections"] == .null
          ? .array([]) : package["new_connections"],
      ]
  }
  private func run(_ body: @escaping @MainActor () async throws -> Void) {
    Task { do { try await body() } catch { status = userFacingError(error) } }
  }
  private func load() async {
    do { library = try await featureCall(model, "extensionLibrary") } catch {
      status = userFacingError(error)
    }
  }
}
struct GroupPolicyView: View {
  var model: AppModel
  var room: Record
  @State private var policy: JSONValue = .null
  @State private var preview: JSONValue = .null
  @State private var instruction = ""
  @State private var reply = "turns"
  @State private var image = ""
  @State private var actor = ""
  @State private var privateText = ""
  @State private var status = ""
  @State private var memory = false
  @State private var connections: Set<String> = []
  var body: some View {
    Form {
      TextEditor(text: $instruction).frame(minHeight: 100).accessibilityLabel("群额外指令")
      Picker("回应方式", selection: $reply) {
        Text("轮流").tag("turns")
        Text("随机一人").tag("random")
        Text("静默").tag("silence")
      }
      Toggle("群可读取各成员少量私有记忆", isOn: $memory)
      Picker("群生图服务", selection: $image) {
        Text("关闭").tag("")
        ForEach(model.providers) { Text($0.name).tag($0.id) }
      }
      Section("群工具（默认不选择）") {
        ForEach(model.items("mcp_connection")) { c in
          Toggle(
            c.name,
            isOn: Binding(
              get: { connections.contains(c.id) },
              set: { if $0 { connections.insert(c.id) } else { connections.remove(c.id) } }))
        }
      }
      Button("保存群配置") {
        run {
          var p: [String: JSONValue] = [
            "room_id": .string(room.id), "instruction": .string(instruction),
            "reply_policy": .string(reply), "memory_enabled": .bool(memory),
            "mcp_ids": .array(connections.sorted().map { .string($0) }),
          ]
          if !image.isEmpty { p["image_provider_id"] = .string(image) }
          _ = try await featureCall(model, "saveGroupPolicy", p, revision: policy["revision"].int)
          await load()
        }
      }
      ForEach(model.items("actor").filter { room["actor_ids"].array.contains(.string($0.id)) }) {
        a in
        let member = policy["members"].array.first { $0["actor_id"].string == a.id } ?? .null
        Section(a.name) {
          Button(member["tools_enabled"].bool ? "关闭成员群工具" : "允许成员群工具") {
            memberChange(a, member, !member["tools_enabled"].bool, member["memory_enabled"].bool)
          }
          Button(member["memory_enabled"].bool ? "关闭成员群记忆" : "允许成员群记忆") {
            memberChange(a, member, member["tools_enabled"].bool, !member["memory_enabled"].bool)
          }
        }
      }
      Section("私密支线") {
        Picker("只对这位成员发送", selection: $actor) {
          Text("请选择").tag("")
          ForEach(model.items("actor").filter { room["actor_ids"].array.contains(.string($0.id)) })
          { Text($0.name).tag($0.id) }
        }
        TextField("私密内容", text: $privateText)
        Button("发送到私密支线") {
          run {
            _ = try await featureCall(
              model, "sendPrivateLane",
              [
                "room_id": .string(room.id), "actor_id": .string(actor),
                "content": .string(privateText),
              ])
            privateText = ""
            status = "已发送到独立支线"
          }
        }
      }
      Button("预览解散与隐私擦除", role: .destructive) {
        run {
          preview = try await featureCall(model, "previewDisband", ["room_id": .string(room.id)])
        }
      }
      if preview != .null {
        Text(featureJSON(preview))
        Button("确认解散并擦除群对话", role: .destructive) {
          run {
            _ = try await featureCall(
              model, "disbandGroup",
              ["room_id": .string(room.id), "preview_token": preview["preview_token"]],
              revision: preview["revision"].int)
            status = "群已解散"
          }
        }
      }
      Text(status)
    }.navigationTitle(room.name).formStyle(.grouped).task { await load() }
  }
  private func run(_ body: @escaping @MainActor () async throws -> Void) {
    Task { do { try await body() } catch { status = userFacingError(error) } }
  }
  private func memberChange(_ a: Record, _ m: JSONValue, _ tools: Bool, _ memory: Bool) {
    run {
      _ = try await featureCall(
        model, "setGroupMember",
        [
          "room_id": .string(room.id), "actor_id": .string(a.id), "tools_enabled": .bool(tools),
          "memory_enabled": .bool(memory),
          "instruction": m["instruction"] == .null ? .string("") : m["instruction"],
        ], revision: m["revision"].int)
      await load()
    }
  }
  private func load() async {
    do {
      policy = try await featureCall(model, "groupPolicy", ["room_id": .string(room.id)])
      instruction = policy["instruction"].string
      reply = policy["reply_policy"].string
      image = policy["image_provider_id"].string
      memory = policy["memory_enabled"].bool
      connections = Set(policy["mcp_ids"].array.map(\.string))
    } catch { status = userFacingError(error) }
  }
}

struct MiniAppLibraryView: View {
  var model: AppModel
  var actor: Record
  @State private var library: JSONValue = .null
  @State private var editing: JSONValue = .null
  @State private var session: JSONValue = .null
  @State private var preview: JSONValue = .null
  @State private var title = ""
  @State private var source = ""
  @State private var language = "html"
  @State private var status = ""
  @State private var input = "null"
  @State private var origin = ""
  @State private var ai = "none"
  @State private var enabled = false
  @State private var persistence = true
  @State private var exporting = false
  @State private var importing = false
  @State private var archive = OwnerArchive(data: Data())
  var body: some View {
    Form {
      Section("源码（保存不运行）") {
        TextField("作品名", text: $title)
        Picker("语言", selection: $language) {
          Text("HTML / JavaScript").tag("html")
          Text("Python").tag("python")
        }
        TextEditor(text: $source).font(.system(.body, design: .monospaced)).frame(minHeight: 220)
          .accessibilityLabel("作品源码")
        Button("保存源码") {
          run {
            var p: [String: JSONValue] = [
              "actor_id": .string(actor.id), "title": .string(title), "language": .string(language),
              "source": .string(source),
              "resources": editing["resources"] == .null ? .object([:]) : editing["resources"],
            ]
            if editing != .null { p["id"] = editing["id"] }
            editing = try await featureCall(
              model, "saveMiniApp", p, revision: editing["revision"].int)
            await load()
          }
        }
        Button("导入作品") { importing = true }
      }
      ForEach(library["apps"].array.filter { $0["actor_id"].string == actor.id }, id: \.self) {
        app in
        Button(app["title"].string) {
          editing = app
          title = app["title"].string
          source = app["source"].string
          language = app["language"].string
          enabled = app["run_enabled"].bool
          persistence = app["persistence"].bool
          ai = app["ai_state"].string
          session = .null
        }
      }
      ForEach(library["conflicts"].array.filter { $0["app_id"] == editing["id"] }, id: \.self) {
        conflict in
        Section("保留的状态冲突副本") { Text(featureJSON(conflict["state"])).textSelection(.enabled) }
      }
      if editing != .null {
        let recoveryKey = "runtime-state/" + editing["id"].string
        let recovery = model.draft(room: recoveryKey)
        if !recovery.isEmpty {
          Section("尚未确认保存的状态") {
            Text(recovery).font(EchoFont.caption).textSelection(.enabled)
            Button("核对并恢复状态") {
              run {
                let saved = try JSONDecoder().decode(JSONValue.self, from: Data(recovery.utf8))
                let reopened = try await featureCall(
                  model, "openRuntime", ["id": editing["id"], "principal": .string("owner")])
                do {
                  let result = try await featureCall(
                    model, "commitRuntimeState",
                    ["session_id": reopened["id"], "state": saved["state"]],
                    revision: saved["revision"].int)
                  if result["saved"].bool || result["conflict_id"] != .null {
                    model.saveDraft(room: recoveryKey, content: "")
                    status = result["saved"].bool ? "状态已恢复" : "已有更新，恢复内容已保存为冲突副本"
                  }
                } catch {
                  _ = try? await featureCall(model, "closeRuntime", ["session_id": reopened["id"]])
                  throw error
                }
                _ = try await featureCall(model, "closeRuntime", ["session_id": reopened["id"]])
                await load()
              }
            }
          }
        }
        Section("权限与数据") {
          Toggle("允许运行", isOn: $enabled)
          Toggle("持久保存状态", isOn: $persistence)
          Picker("AI 状态权限", selection: $ai) {
            Text("无").tag("none")
            Text("只读").tag("read")
            Text("可读写").tag("write")
          }
          Button("保存权限") {
            run {
              editing = try await featureCall(
                model, "setAppPermissions",
                [
                  "id": editing["id"], "run_enabled": .bool(enabled),
                  "persistence": .bool(persistence), "ai_state": .string(ai),
                ], revision: editing["revision"].int)
              session = .null
              await load()
            }
          }
          Button("导出源码和素材") {
            run {
              let value = try await featureCall(model, "exportMiniApp", ["id": editing["id"]])
              archive = OwnerArchive(data: try JSONEncoder().encode(value))
              exporting = true
            }
          }
          Button("预览重置状态") {
            run {
              preview = try await featureCall(
                model, "previewResetState", ["id": editing["id"]], revision: editing["revision"].int
              )
            }
          }
          if preview != .null {
            Button("确认只清除状态", role: .destructive) {
              run {
                _ = try await featureCall(
                  model, "resetRuntimeState",
                  ["id": editing["id"], "preview_token": preview["preview_token"]],
                  revision: editing["revision"].int)
                preview = .null
                await load()
              }
            }
          }
        }
        Section("运行") {
          Button("打开新的离线会话") {
            run {
              session = try await featureCall(
                model, "openRuntime", ["id": editing["id"], "principal": .string("owner")])
            }
          }
          if session != .null {
            TextField("本次允许的 HTTPS 来源，例如 https://example.com", text: $origin)
            Button("仅本次授权该来源") {
              run {
                _ = try await featureCall(
                  model, "grantSessionNetwork",
                  ["session_id": session["id"], "origins": .array([.string(origin)])])
              }
            }
            if session["language"].string == "html" {
              RuntimeCardView(model: model, session: session).id(session["id"].string).frame(
                minHeight: 300)
            } else {
              TextEditor(text: $input).frame(minHeight: 70).accessibilityLabel("Python 输入 JSON")
              Button("执行 Python") {
                run {
                  let value = try JSONDecoder().decode(JSONValue.self, from: Data(input.utf8))
                  status = featureJSON(
                    try await featureCall(
                      model, "runPython", ["session_id": session["id"], "input": value]))
                }
              }
            }
            Button("退出并撤销本次网络权限") {
              run {
                if session["language"].string != "html" {
                  _ = try await featureCall(model, "closeRuntime", ["session_id": session["id"]])
                }
                session = .null
              }
            }
          }
        }
      }
      Text(status).textSelection(.enabled)
    }.navigationTitle("可运行作品").formStyle(.grouped).task { await load() }
      .onDisappear {
        let id = session["id"]
        if id != .null && session["language"].string != "html" {
          Task { _ = try? await featureCall(model, "closeRuntime", ["session_id": id]) }
        }
      }
      .fileExporter(
        isPresented: $exporting, document: archive, contentType: .json,
        defaultFilename: "echo-miniapp.json"
      ) { if case .failure(let e) = $0 { status = userFacingError(e) } }
      .fileImporter(isPresented: $importing, allowedContentTypes: [.json]) { r in
        run {
          let url = try r.get()
          let access = url.startAccessingSecurityScopedResource()
          defer { if access { url.stopAccessingSecurityScopedResource() } }
          guard (try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) <= 1_048_576 else {
            throw APIError(status: 413, code: "invalid_manifest")
          }
          let data = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
          guard data["format"].string == "echo-miniapp", data["version"].int == 1 else {
            throw APIError(status: 400, code: "invalid_manifest")
          }
          editing = try await featureCall(
            model, "importMiniApp",
            [
              "actor_id": .string(actor.id), "title": data["title"], "language": data["language"],
              "source": data["source"], "resources": data["resources"],
            ])
          title = editing["title"].string
          source = editing["source"].string
          language = editing["language"].string
          await load()
        }
      }
  }
  private func run(_ body: @escaping @MainActor () async throws -> Void) {
    Task { do { try await body() } catch { status = userFacingError(error) } }
  }
  private func load() async {
    do { library = try await featureCall(model, "appLibrary") } catch {
      status = userFacingError(error)
    }
  }
}

#if os(macOS)
  typealias EchoWebRepresentable = NSViewRepresentable
#else
  typealias EchoWebRepresentable = UIViewRepresentable
#endif
struct IsolatedExtensionWebView: EchoWebRepresentable {
  let url: URL
  func makeCoordinator() -> WebNavigationGuard { WebNavigationGuard(origin: url.originString) }
  private func make(_ coordinator: WebNavigationGuard) -> WKWebView {
    let c = WKWebViewConfiguration()
    c.websiteDataStore = .nonPersistent()
    let w = WKWebView(frame: .zero, configuration: c)
    w.navigationDelegate = coordinator
    w.load(URLRequest(url: url))
    return w
  }
  #if os(macOS)
    func makeNSView(context: Context) -> WKWebView { make(context.coordinator) }
    func updateNSView(_ view: WKWebView, context: Context) {}
  #else
    func makeUIView(context: Context) -> WKWebView { make(context.coordinator) }
    func updateUIView(_ view: WKWebView, context: Context) {}
  #endif
}
extension URL {
  var originString: String {
    (scheme ?? "") + "://" + (host ?? "") + (port.map { ":" + String($0) } ?? "")
  }
}
@MainActor
final class WebNavigationGuard: NSObject, WKNavigationDelegate {
  let origin: String
  init(origin: String) { self.origin = origin }
  func webView(
    _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
  ) {
    guard let url = navigationAction.request.url else {
      decisionHandler(.cancel)
      return
    }
    decisionHandler(url.scheme == "https" && url.originString == origin ? .allow : .cancel)
  }
}
struct RuntimeCardView: EchoWebRepresentable {
  var model: AppModel
  var session: JSONValue
  func makeCoordinator() -> RuntimeBridge { RuntimeBridge(model: model, session: session) }
  private func make(_ bridge: RuntimeBridge) -> WKWebView {
    let c = WKWebViewConfiguration()
    c.websiteDataStore = .nonPersistent()
    c.userContentController.add(bridge, name: "echoRuntime")
    let state = featureJSON(session["state"]).replacingOccurrences(of: "</", with: "<\\/")
    let script = """
      (()=>{const saved=\(state); const pending=new Map();let next=0;let store={...(saved.storage||{})};
      const bridge=window.webkit.messageHandlers.echoRuntime;
      const key=(e,i)=>e.id||e.name||('field-'+i);
      Object.defineProperty(window,'localStorage',{value:{getItem:k=>store[k]??null,setItem:(k,v)=>{store[k]=String(v);snapshot()},removeItem:k=>{delete store[k];snapshot()},clear:()=>{store={};snapshot()},key:i=>Object.keys(store)[i]??null,get length(){return Object.keys(store).length}}});
      function snapshot(){const fields={};document.querySelectorAll('input,textarea,select,[contenteditable]').forEach((e,i)=>{fields[key(e,i)]={value:e.value,text:e.isContentEditable?e.textContent:undefined,checked:e.checked}});bridge.postMessage({type:'state',state:{fields,storage:store}})}
      window.echoRuntime={request:url=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});bridge.postMessage({type:'request',id,url})})};
      window.__echoReply=(id,value,error)=>{const p=pending.get(id);if(!p)return;pending.delete(id);error?p.reject(new Error(error)):p.resolve(value)};
      document.addEventListener('DOMContentLoaded',()=>{document.querySelectorAll('input,textarea,select,[contenteditable]').forEach((e,i)=>{const f=saved.fields?.[key(e,i)];if(!f)return;if(f.value!==undefined)e.value=f.value;if(f.checked!==undefined)e.checked=f.checked;if(f.text!==undefined)e.textContent=f.text});document.addEventListener('input',snapshot);document.addEventListener('change',snapshot)});
      setInterval(()=>bridge.postMessage({type:'heartbeat'}),500);
      })();
      """
    c.userContentController.addUserScript(
      WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    let w = WKWebView(frame: .zero, configuration: c)
    w.navigationDelegate = bridge
    bridge.web = w
    // HTTP, sockets, frames, workers, forms and remote assets are all denied by CSP.
    let csp =
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
    var source = session["source"].string
    for (path, value) in session["resources"].object {
      let mime = path.hasSuffix(".css") ? "text/css" : "text/plain"
      let data = Data(value.string.utf8).base64EncodedString()
      source = source.replacingOccurrences(
        of: "\"" + path + "\"", with: "\"data:" + mime + ";base64," + data + "\"")
    }
    w.loadHTMLString(
      "<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"" + csp + "\">"
        + source, baseURL: nil)
    bridge.startWatch()
    return w
  }
  #if os(macOS)
    func makeNSView(context: Context) -> WKWebView { make(context.coordinator) }
    func updateNSView(_ view: WKWebView, context: Context) {}
    static func dismantleNSView(_ view: WKWebView, coordinator: RuntimeBridge) {
      coordinator.close()
    }
  #else
    func makeUIView(context: Context) -> WKWebView { make(context.coordinator) }
    func updateUIView(_ view: WKWebView, context: Context) {}
    static func dismantleUIView(_ view: WKWebView, coordinator: RuntimeBridge) {
      coordinator.close()
    }
  #endif
}
@MainActor
final class RuntimeBridge: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
  let model: AppModel
  let session: JSONValue
  let namespace: String?
  weak var web: WKWebView?
  var revision: Int
  var heartbeat = Date()
  var watchdog: Task<Void, Never>?
  var pending: JSONValue?
  var saving = false
  var closed = false
  var closing = false
  private var recoveryKey: String { "runtime-state/" + session["app_id"].string }
  init(model: AppModel, session: JSONValue) {
    self.model = model
    self.session = session
    revision = session["state_revision"].int
    namespace = model.connection?.namespace
  }
  func userContentController(
    _ userContentController: WKUserContentController, didReceive message: WKScriptMessage
  ) {
    guard !closed, !closing, namespace == model.connection?.namespace,
      message.frameInfo.isMainFrame,
      message.webView === web, let body = message.body as? [String: Any],
      let type = body["type"] as? String
    else { return }
    if type == "heartbeat" { heartbeat = Date() }
    if type == "state",
      let data = try? JSONSerialization.data(withJSONObject: body["state"] ?? [:]),
      data.count <= 1_048_576, let state = try? JSONDecoder().decode(JSONValue.self, from: data)
    {
      pending = state
      preserve(state)
      Task { await save() }
    }
    if type == "request", let id = body["id"] as? Int, let url = body["url"] as? String {
      Task {
        do {
          let result = try await featureCall(
            model, "runtimeRequest", ["session_id": session["id"], "url": .string(url)])
          guard !closed else { return }
          _ = try await web?.callAsyncJavaScript(
            "window.__echoReply(id,value,null)", arguments: ["id": id, "value": result.string],
            in: nil, contentWorld: .page)
        } catch {
          _ = try? await web?.callAsyncJavaScript(
            "window.__echoReply(id,null,'network_denied')", arguments: ["id": id], in: nil,
            contentWorld: .page)
        }
      }
    }
  }
  func save() async {
    guard !saving, !closed, namespace == model.connection?.namespace else { return }
    saving = true
    defer { saving = false }
    while let state = pending {
      pending = nil
      preserve(state)
      do {
        let result = try await featureCall(
          model, "commitRuntimeState", ["session_id": session["id"], "state": state],
          revision: revision)
        if result["saved"].bool {
          revision = result["state_revision"].int
          if pending == nil { model.saveDraft(room: recoveryKey, content: "") }
        } else if result["conflict_id"] != .null {
          model.saveDraft(room: recoveryKey, content: "")
          pending = nil
          close()
          return
        }
      } catch {
        if pending == nil { pending = state }
        preserve(pending ?? state)
        model.report(error)
        return
      }
    }
  }
  private func preserve(_ state: JSONValue) {
    guard namespace == model.connection?.namespace, session["persistence"].bool else { return }
    model.saveDraft(
      room: recoveryKey,
      content: featureJSON(
        .object([
          "state": state, "revision": .number(Double(revision)),
        ])))
  }
  func startWatch() {
    watchdog = Task {
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(1))
        if Task.isCancelled { return }
        if Date().timeIntervalSince(heartbeat) > 4 {
          close()
          return
        }
      }
    }
  }
  func close() {
    guard !closed, !closing else { return }
    closing = true
    watchdog?.cancel()
    watchdog = nil
    web?.stopLoading()
    web?.configuration.userContentController.removeScriptMessageHandler(forName: "echoRuntime")
    web?.loadHTMLString("<p>运行已结束。状态冲突会保留副本。</p>", baseURL: nil)
    Task {
      while saving { try? await Task.sleep(for: .milliseconds(20)) }
      await save()
      closed = true
      guard namespace == model.connection?.namespace else { return }
      _ = try? await featureCall(model, "closeRuntime", ["session_id": session["id"]])
    }
  }
  func webView(
    _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
    decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
  ) { decisionHandler(action.request.url?.absoluteString == "about:blank" ? .allow : .cancel) }
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { close() }
}

@MainActor @Observable
final class VoiceCapture: NSObject, AVAudioPlayerDelegate {
  var text = ""
  var error = ""
  var recording = false
  var playing = false
  var playedMS = 0
  var wav = Data()
  var rate = 16000
  private var samples = Data()
  private var engine = AVAudioEngine()
  private var tapInstalled = false
  private var recognition: SFSpeechRecognitionTask?
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var player: AVAudioPlayer?
  func start(allowWithoutSpeech: Bool = false) async {
    stop()
    error = ""
    text = ""
    samples = Data()
    guard await AVCaptureDevice.requestAccess(for: .audio) else {
      error = "麦克风权限未开启"
      return
    }
    let speech = await withCheckedContinuation {
      (c: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Never>) in
      SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) }
    }
    let recognizer = speech == .authorized ? SFSpeechRecognizer(locale: Locale.current) : nil
    guard allowWithoutSpeech || recognizer?.isAvailable == true else {
      error = "系统语音识别暂不可用；可手动编辑文本或选择自定义语音服务"
      return
    }
    #if os(iOS)
      do {
        try AVAudioSession.sharedInstance().setCategory(
          .playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP])
        try AVAudioSession.sharedInstance().setActive(true)
      } catch {
        self.error = userFacingError(error)
        return
      }
    #endif
    let req = SFSpeechAudioBufferRecognitionRequest()
    req.shouldReportPartialResults = true
    request = req
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    rate = Int(format.sampleRate)
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
      req.append(buffer)
      guard let channel = buffer.floatChannelData?[0] else { return }
      var bytes = Data(capacity: Int(buffer.frameLength) * 2)
      for i in 0..<Int(buffer.frameLength) {
        var sample = Int16(max(-1, min(1, channel[i])) * 32767).littleEndian
        withUnsafeBytes(of: &sample) { bytes.append(contentsOf: $0) }
      }
      Task { @MainActor [weak self] in
        guard let self, self.recording else { return }
        if self.samples.count + bytes.count > 1_000_000 {
          self.stop()
          self.error = "本段已达到录音大小上限，请发送或开始下一段"
        } else {
          self.samples.append(bytes)
        }
      }
    }
    tapInstalled = true
    recognition = recognizer?.recognitionTask(with: req) { [weak self] result, error in
      let value = result?.bestTranscription.formattedString
      let failed = error != nil
      Task { @MainActor [weak self] in
        if let value, self?.recording == true { self?.text = value }
        if failed && self?.recording == true { self?.stop() }
      }
    }
    do {
      engine.prepare()
      try engine.start()
      recording = true
    } catch {
      self.error = userFacingError(error)
      stop()
    }
  }
  func stop() {
    engine.stop()
    if tapInstalled {
      engine.inputNode.removeTap(onBus: 0)
      tapInstalled = false
    }
    request?.endAudio()
    recognition?.cancel()
    recognition = nil
    request = nil
    recording = false
    if !samples.isEmpty {
      var d = Data()
      func ascii(_ s: String) { d.append(Data(s.utf8)) }
      func n32(_ n: Int) {
        var v = UInt32(n).littleEndian
        withUnsafeBytes(of: &v) { d.append(contentsOf: $0) }
      }
      func n16(_ n: Int) {
        var v = UInt16(n).littleEndian
        withUnsafeBytes(of: &v) { d.append(contentsOf: $0) }
      }
      ascii("RIFF")
      n32(samples.count + 36)
      ascii("WAVEfmt ")
      n32(16)
      n16(1)
      n16(1)
      n32(rate)
      n32(rate * 2)
      n16(2)
      n16(16)
      ascii("data")
      n32(samples.count)
      d.append(samples)
      wav = d
    }
  }
  func play(_ data: Data) throws {
    stopPlayback()
    player = try AVAudioPlayer(data: data)
    player?.delegate = self
    playedMS = 0
    player?.prepareToPlay()
    playing = player?.play() ?? false
  }
  func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
    guard player === self.player else { return }
    if flag { playedMS = max(playedMS, Int(player.duration * 1000)) }
    playing = false
  }
  func stopPlayback() {
    playedMS = max(playedMS, Int((player?.currentTime ?? 0) * 1000))
    player?.stop()
    playing = false
  }
  func snapshotPlayback() -> Int {
    playedMS = max(playedMS, Int((player?.currentTime ?? 0) * 1000))
    return playedMS
  }
}
struct VoiceConversationView: View {
  var model: AppModel
  var room: Record
  @State private var audio = VoiceCapture()
  @State private var session: JSONValue = .null
  @State private var turn: JSONValue = .null
  @State private var tts: JSONValue = .null
  @State private var library: JSONValue = .null
  @State private var actor = ""
  @State private var status = ""
  @State private var turnID = UUID().uuidString
  @State private var customSTT = false
  @State private var fallback = true
  @State private var muted = false
  @State private var greeting = false
  @State private var quiet = 1500
  @State private var autoSend = false
  @State private var quietTask: Task<Void, Never>?
  var body: some View {
    Form {
      Picker("对话成员", selection: $actor) {
        Text("请选择").tag("")
        ForEach(model.items("actor").filter { room["actor_ids"].array.contains(.string($0.id)) }) {
          Text($0.name).tag($0.id)
        }
      }
      Toggle("开场问候", isOn: $greeting)
      Toggle("静音", isOn: $muted).onChange(of: muted) { _, value in
        if value {
          audio.stop()
          quietTask?.cancel()
        }
      }
      Toggle("使用自定义转写服务", isOn: $customSTT)
      Toggle("转写失败保留系统文本", isOn: $fallback)
      Toggle("安静后自动发送", isOn: $autoSend)
      Stepper("安静等待 \(quiet) 毫秒", value: $quiet, in: 500...10000, step: 500)
      if session == .null { Button("开始语音会话") { run { try await start(nil) } } }
      ForEach(
        library["invites"].array.filter {
          $0["room_id"].string == room.id && $0["state"].string == "pending"
        }, id: \.self
      ) { invite in
        Button("接听邀请（有效期 15 分钟）") {
          run {
            actor = invite["actor_id"].string
            try await start(invite["id"])
          }
        }
      }
      if session != .null {
        TextEditor(text: $audio.text).frame(minHeight: 140).accessibilityLabel("实时字幕与待发送文本")
        Button(audio.recording ? "停止录音" : "开始录音") {
          Task {
            quietTask?.cancel()
            if audio.recording {
              audio.stop()
            } else if !muted {
              await recordPlayback()
              audio.stopPlayback()
              turnID = UUID().uuidString
              turn = .null
              tts = .null
              await audio.start(allowWithoutSpeech: customSTT)
            }
          }
        }
        Button("确认发送本段") { run { try await send() } }
        if turn["run_id"] != .null {
          let replies = model.messages(room: room.id).filter {
            $0["run_id"] == turn["run_id"] && $0["role"].string == "assistant"
          }
          ForEach(replies) { reply in
            Text(reply["content"].string)
            Button("朗读此回复（使用 TTS 服务）") {
              run {
                tts = try await featureCall(
                  model, "createMediaJob",
                  ["actor_id": .string(actor), "kind": .string("tts"), "prompt": reply["content"]])
              }
            }
          }
        }
        if tts != .null {
          Button("查询语音并播放") {
            run {
              tts = try await featureCall(model, "refreshMediaJob", ["id": tts["id"]])
              if tts["state"].string == "completed" {
                let a = try await model.operations(
                  action: "readAsset", id: tts["result"]["asset_id"].string)
                guard let data = Data(base64Encoded: a["content_base64"].string) else {
                  throw APIError(status: 400, code: "invalid_asset")
                }
                try audio.play(data)
              } else {
                status = "语音状态：" + tts["state"].string + "；文本仍可阅读"
              }
            }
          }
          Button("打断播放") {
            Task {
              audio.stopPlayback()
              await recordPlayback()
            }
          }
          Button("保存已播放部分") {
            run {
              audio.stopPlayback()
              await recordPlayback()
              turn = try await featureCall(
                model, "savePlayedAudio", ["session_id": session["id"], "turn_id": turn["id"]],
                revision: turn["revision"].int)
              status = "已保存实际播放部分"
            }
          }
        }
        Button("结束会话") {
          run {
            await recordPlayback()
            audio.stop()
            audio.stopPlayback()
            quietTask?.cancel()
            _ = try await featureCall(model, "closeVoice", ["session_id": session["id"]])
            session = .null
          }
        }
      }
      Text(audio.error)
      Text(status).textSelection(.enabled)
    }.navigationTitle("语音对话").formStyle(.grouped).task {
      actor = room["actor_ids"].array.first?.string ?? ""
      library = (try? await featureCall(model, "voiceLibrary")) ?? .null
    }
    .onChange(of: audio.text) { _, _ in
      quietTask?.cancel()
      if autoSend && audio.recording && !muted {
        quietTask = Task {
          do {
            try await Task.sleep(for: .milliseconds(quiet))
            try await send()
          } catch { if !(error is CancellationError) { status = userFacingError(error) } }
        }
      }
    }
    .onReceive(NotificationCenter.default.publisher(for: .AVAudioEngineConfigurationChange)) { _ in
      audio.stop()
      audio.stopPlayback()
      quietTask?.cancel()
      status = "音频设备已变化，录音与播放已停止"
    }
    #if os(iOS)
      .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.interruptionNotification))
      { _ in
        audio.stop()
        audio.stopPlayback()
        quietTask?.cancel()
        status = "系统中断了音频，请明确恢复录音"
      }
      .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.routeChangeNotification))
      { _ in
        audio.stop()
        audio.stopPlayback()
        quietTask?.cancel()
      }
    #endif
    .onDisappear {
      audio.stop()
      audio.stopPlayback()
      quietTask?.cancel()
      let id = session["id"]
      if id != .null {
        Task { _ = try? await featureCall(model, "closeVoice", ["session_id": id]) }
      }
    }
  }
  private func run(_ body: @escaping @MainActor () async throws -> Void) {
    Task { do { try await body() } catch { status = userFacingError(error) } }
  }
  private func start(_ invite: JSONValue?) async throws {
    var p: [String: JSONValue] = [
      "room_id": .string(room.id), "actor_id": .string(actor),
      "settings": .object([
        "greeting": .bool(greeting), "muted": .bool(muted), "quiet_ms": .number(Double(quiet)),
        "custom_stt": .bool(customSTT), "fallback": .bool(fallback),
      ]),
    ]
    if let invite { p["invite_id"] = invite }
    session = try await featureCall(model, "startVoice", p)
    if greeting {
      audio.text = "我们开始语音对话吧。"
      try await send()
    }
  }
  private func send() async throws {
    guard turn["state"].string != "sent" else { return }
    audio.stop()
    quietTask = nil
    turn = try await featureCall(
      model, "voiceDraft",
      ["session_id": session["id"], "turn_id": .string(turnID), "text": .string(audio.text)],
      revision: turn["revision"].int)
    if customSTT && !audio.wav.isEmpty {
      do {
        let a = try await model.operations(
          action: "createAsset",
          body: .object([
            "operation_id": .string(UUID().uuidString), "world_id": room["world_id"],
            "actor_id": .string(actor), "mime": .string("audio/wav"),
            "content_base64": .string(audio.wav.base64EncodedString()),
          ]))
        let j = try await featureCall(
          model, "createMediaJob",
          [
            "actor_id": .string(actor), "kind": .string("stt"), "prompt": .string(""),
            "asset_id": a["id"],
          ])
        let done = try await featureCall(model, "refreshMediaJob", ["id": j["id"]])
        guard done["state"].string == "completed" else {
          throw APIError(status: 409, code: "stt_unavailable")
        }
        turn = try await featureCall(
          model, "acceptTranscription",
          ["session_id": session["id"], "turn_id": turn["id"], "job_id": j["id"]],
          revision: turn["revision"].int)
      } catch {
        if !fallback { throw error }
        status = "自定义转写未完成，使用已确认文本"
      }
    }
    turn = try await featureCall(
      model, "finalizeVoice", ["session_id": session["id"], "turn_id": turn["id"]],
      revision: turn["revision"].int)
  }
  private func recordPlayback() async {
    guard tts["state"].string == "completed", turn["id"] != .null else { return }
    do {
      turn = try await featureCall(
        model, "voicePlayback",
        [
          "session_id": session["id"], "turn_id": turn["id"], "job_id": tts["id"],
          "played_ms": .number(Double(audio.snapshotPlayback())),
        ], revision: turn["revision"].int)
    } catch { status = userFacingError(error) }
  }
}
