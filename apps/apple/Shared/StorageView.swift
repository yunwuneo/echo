import CompanionCore
import SwiftUI
import UniformTypeIdentifiers

struct StorageView: View {
  var model: AppModel
  @State private var library: JSONValue = .null
  @State private var hosts: JSONValue = .null
  @State private var link = ""
  @State private var root = ""
  @State private var document = ""
  @State private var path = ""
  @State private var password = ""
  @State private var cadence = "daily"
  @State private var keepCount = 0
  @State private var enabled = false
  @State private var diagnostics: JSONValue = .null
  @State private var preview: JSONValue = .null
  @State private var days = 30
  @State private var status = ""
  @State private var credentialIDs: Set<String> = []
  @State private var mcpIDs: Set<String> = []
  @State private var mcpConnections: JSONValue = .null
  @State private var credentialPreview: JSONValue = .null
  @State private var imported: JSONValue = .null
  @State private var exporting = false
  @State private var importing = false
  @State private var archive = OwnerArchive(data: Data())
  var body: some View {
    Form {
      Section("外部目录") {
        Picker("已绑定 Host 身份", selection: $link) {
          ForEach(hosts["links"].array, id: \.self) { l in
            Text(l["remote_identity"].string).tag(l["id"].string)
          }
        }
        TextField("Host 已授权的目录代号", text: $root)
        TextField("已有项目文档 ID", text: $document)
        TextField("目录内相对路径", text: $path)
        Button("关联文档") {
          perform {
            _ = try await featureCall(
              model, "bindExternalDocument",
              [
                "link_id": .string(link), "root": .string(root), "path": .string(path),
                "document_id": .string(document),
              ])
            try await load()
          }
        }
        Text("先读取外部基线，再明确写入。外部内容不会自动覆盖项目文档；冲突时保留外部与本地两份内容，修改后重新读取核对。")
        ForEach(library["documents"].array, id: \.self) { d in
          DisclosureGroup(d["path"].string + " · " + d["state"].string) {
            Text(featureJSON(d["conflict"])).textSelection(.enabled)
            Button("读取外部基线") { change("refreshExternalDocument", d) }
            Button("核对 Host 回执") { change("reconcileExternalDocument", d) }
            Button("按已读基线写入外部文件") { change("writeExternalDocument", d) }
          }
        }
      }
      Section("远端加密恢复点") {
        SecureField("备份或凭据包密码（至少 12 字符）", text: $password)
        Picker("自动备份周期", selection: $cadence) {
          Text("每天").tag("daily")
          Text("每周").tag("weekly")
        }
        Stepper(
          keepCount == 0 ? "保留全部恢复点" : "保留最近 \(keepCount) 个已验证恢复点", value: $keepCount, in: 0...100)
        Toggle("开启自动备份", isOn: $enabled)
        Text("使用上方选定的 Host 与目录代号。后台分块上传并验证完整哈希；失败或未知结果不会删除旧恢复点。")
        Button("保存新的备份计划") {
          perform {
            _ = try await featureCall(
              model, "saveBackupPlan",
              [
                "link_id": .string(link), "root": .string(root), "cadence": .string(cadence),
                "enabled": .bool(enabled), "password": .string(password),
                "keep_count": .number(Double(keepCount)),
              ])
            try await load()
          }
        }
        ForEach(library["plans"].array, id: \.self) { p in
          Text(p["cadence"].string + " · " + (p["enabled"].bool ? "开启" : "暂停"))
          Button("为此计划立即生成恢复点") { change("runRemoteBackup", p) }
          Button("使用当前密码与保留数量启用此计划") {
            perform {
              _ = try await featureCall(
                model, "saveBackupPlan",
                [
                  "id": p["id"], "link_id": p["link_id"], "root": p["root"],
                  "cadence": p["cadence"], "enabled": .bool(true), "password": .string(password),
                  "keep_count": .number(Double(keepCount)),
                ], revision: p["revision"].int)
              try await load()
            }
          }
          Button("暂停此计划") { change("pauseBackupPlan", p) }
        }
        ForEach(library["backups"].array, id: \.self) { b in
          Text(b["created_at"].string + " · " + b["state"].string + " · " + b["error_code"].string)
        }
      }
      Section("仅迁移选定凭据") {
        Text("业务备份始终排除密钥。这里另存加密凭据包；导入前核对连接身份与版本，不自动联网测试。")
        ForEach(model.providers) { p in
          Toggle(
            p.name,
            isOn: Binding(
              get: { credentialIDs.contains(p.id) },
              set: { if $0 { credentialIDs.insert(p.id) } else { credentialIDs.remove(p.id) } }))
        }
        ForEach(mcpConnections["items"].array, id: \.self) { p in
          Toggle(
            "MCP · " + p["name"].string,
            isOn: Binding(
              get: { mcpIDs.contains(p["id"].string) },
              set: {
                if $0 { mcpIDs.insert(p["id"].string) } else { mcpIDs.remove(p["id"].string) }
              }))
        }
        Button("导出已选择的连接凭据") {
          perform {
            let result = try await featureCall(
              model, "exportSelectedCredentials",
              [
                "selections": selectedCredentials, "password": .string(password),
              ])
            archive = OwnerArchive(data: try JSONEncoder().encode(result))
            exporting = true
          }
        }
        Button("选择加密凭据包") { importing = true }
        if imported != .null {
          Button("解密并预览匹配连接") {
            perform {
              credentialPreview = try await featureCall(
                model, "previewSelectedCredentials",
                ["archive": imported, "password": .string(password)])
            }
          }
        }
        if credentialPreview != .null {
          Text(featureJSON(credentialPreview["items"])).textSelection(.enabled)
          Button("只导入当前勾选连接的凭据") {
            perform {
              _ = try await featureCall(
                model, "importSelectedCredentials",
                [
                  "id": credentialPreview["id"],
                  "preview_token": credentialPreview["preview_token"],
                  "selections": selectedCredentials,
                ])
              credentialPreview = .null
              status = "凭据已导入，真实连接仍需单独测试。"
            }
          }
        }
      }
      Section("存储与诊断") {
        Button("只读检查请求哈希与存储占用") {
          perform { diagnostics = try await featureCall(model, "storageDiagnostics") }
        }
        Text(featureJSON(diagnostics)).textSelection(.enabled)
        Stepper("保留最近 \(days) 天诊断正文", value: $days, in: 1...3650)
        Button("预览可清理的历史请求正文") {
          perform {
            preview = try await featureCall(
              model, "previewDiagnosticCleanup", ["retention_days": .number(Double(days))])
          }
        }
        if preview != .null {
          Text("候选 \(preview["items"].array.count) 项。保留每段对话最近的完整请求及执行中、结果未知记录；逻辑删除不代表文件立即缩小。")
          Button("按此预览清理") {
            perform {
              let result = try await featureCall(
                model, "applyDiagnosticCleanup",
                [
                  "retention_days": preview["retention_days"],
                  "preview_token": preview["preview_token"],
                ])
              status = featureJSON(result)
              preview = .null
            }
          }
        }
      }
      Button("刷新") { perform { try await load() } }
      Text(status).textSelection(.enabled)
    }.formStyle(.grouped).navigationTitle("文件、恢复点与存储").task {
      do {
        try await load()
        link = hosts["links"].array.first?["id"].string ?? ""
      } catch { status = userFacingError(error) }
    }
    .fileExporter(
      isPresented: $exporting, document: archive, contentType: .json,
      defaultFilename: "echo-selected-credentials.json"
    ) { r in if case .failure(let e) = r { status = userFacingError(e) } }
    .fileImporter(isPresented: $importing, allowedContentTypes: [.json]) { r in
      do {
        let url = try r.get()
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        guard (try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) <= 131072 else {
          throw APIError(status: 413, code: "credential_package_size")
        }
        imported = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
        credentialPreview = .null
      } catch { status = userFacingError(error) }
    }
  }
  private func perform(_ work: @escaping @MainActor () async throws -> Void) {
    Task { do { try await work() } catch { status = userFacingError(error) } }
  }
  private func change(_ c: String, _ d: JSONValue) {
    perform {
      _ = try await featureCall(model, c, ["id": d["id"]], revision: d["revision"].int)
      try await load()
    }
  }
  private var selectedCredentials: JSONValue {
    .array(
      credentialIDs.sorted().map { .object(["kind": .string("provider"), "id": .string($0)]) }
        + mcpIDs.sorted().map { .object(["kind": .string("mcp"), "id": .string($0)]) })
  }
  private func load() async throws {
    try await model.refreshSettings()
    mcpConnections = try await model.autonomy(action: "connections")
    library = try await featureCall(model, "externalStorageLibrary")
    hosts = try await featureCall(model, "hostLibrary")
  }
}
