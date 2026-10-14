import CompanionCore
import SwiftUI
import UniformTypeIdentifiers

struct OriginalImportFile: FileDocument {
  static var readableContentTypes: [UTType] { [.json, .png] }
  var data: Data
  init(data: Data) { self.data = data }
  init(configuration: ReadConfiguration) throws {
    data = configuration.file.regularFileContents ?? Data()
  }
  func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
    FileWrapper(regularFileWithContents: data)
  }
}
struct ImportView: View {
  var model: AppModel
  let world: String
  @Environment(\.dismiss) private var dismiss
  @State private var picking = false
  @State private var busy = false
  @State private var exporting = false
  @State private var imported = false
  @State private var enableSuggestions = false
  @State private var json = ""
  @State private var strategy = "skip"
  @State private var filename = ""
  @State private var preview: JSONValue = .null
  @State private var result: JSONValue = .null
  @State private var failure: String?
  @State private var audience: Set<String> = []
  @State private var original: OriginalImportFile?
  @State private var originalType = UTType.json
  var body: some View {
    NavigationStack {
      Form {
        Section(String(localized: "选择来源")) {
          Button(String(localized: "选择 JSON 或 PNG 文件")) { picking = true }.disabled(busy)
          Text(String(localized: "或粘贴角色卡／设定集 JSON")).font(EchoFont.caption)
          JSONSourceEditor(text: $json).frame(minHeight: 160)
            .accessibilityLabel(String(localized: "角色卡或设定集 JSON 内容"))
          Button(String(localized: "预览粘贴内容")) {
            prepare(Data(json.utf8), format: "json", name: String(localized: "粘贴的 JSON"))
          }.disabled(
            busy || json.isEmpty
          ).accessibilityIdentifier("preview-import")
          Text(String(localized: "JSON 最多 5 MiB，PNG 最多 10 MiB。只映射兼容子集，不请求文件中的远程地址。")).font(
            EchoFont.caption
          ).foregroundStyle(
            .secondary)
        }
        Section(String(localized: "独立设定集的可知角色 · 不选表示当前设定内公开")) {
          ForEach(model.items("actor").filter { $0["world_id"].string == world }) { actor in
            Toggle(
              actor.name,
              isOn: Binding(
                get: { audience.contains(actor.id) },
                set: {
                  if $0 { audience.insert(actor.id) } else { audience.remove(actor.id) }
                  preview = .null
                }))
          }
          Text(String(localized: "角色卡附带的设定集仅绑定新导入角色。调整可知角色后需要重新预览。")).font(EchoFont.caption)
            .foregroundStyle(.secondary)
        }
        if !preview["id"].string.isEmpty {
          Section(String(localized: "导入预览 · \(filename)")) {
            if !preview["character"]["name"].string.isEmpty {
              Text(String(localized: "角色：\(preview["character"]["name"].string)"))
            }
            Text(String(localized: "设定集条目：\(preview["entries"].array.count)"))
            ForEach(Array(preview["mapping"].array.enumerated()), id: \.offset) { _, row in
              Text(row.string).font(EchoFont.caption)
            }
          }
          Section(String(localized: "兼容性报告")) {
            ForEach(Array(preview["warnings"].array.enumerated()), id: \.offset) { _, row in
              Text(row.string).font(EchoFont.caption).foregroundStyle(Color.echo.warning)
            }
            ForEach(Array(preview["errors"].array.enumerated()), id: \.offset) { _, row in
              Text(row.string).foregroundStyle(Color.echo.error)
            }
          }
          if !preview["character"]["prompt_suggestions"]["system_prompt"].string.isEmpty
            || !preview["character"]["prompt_suggestions"]["post_history_instructions"].string
              .isEmpty
          {
            Section(String(localized: "角色提示建议 · 默认关闭")) {
              if !preview["character"]["prompt_suggestions"]["system_prompt"].string.isEmpty {
                Text(preview["character"]["prompt_suggestions"]["system_prompt"].string)
                  .textSelection(.enabled)
              }
              if !preview["character"]["prompt_suggestions"]["post_history_instructions"].string
                .isEmpty
              {
                Text(preview["character"]["prompt_suggestions"]["post_history_instructions"].string)
                  .textSelection(.enabled)
              }
              Toggle(String(localized: "启用这些角色提示建议"), isOn: $enableSuggestions)
                .disabled(busy || result != .null)
              Text(String(localized: "建议不能授予工具权限或访问其他角色的秘密。")).font(EchoFont.caption)
            }
          }
          Section(String(localized: "冲突处理")) {
            ForEach(Array(preview["conflicts"].array.enumerated()), id: \.offset) { _, row in
              Text(row.string)
            }
            Picker(String(localized: "同名内容"), selection: $strategy) {
              Text(String(localized: "跳过同名项")).tag("skip")
              Text(String(localized: "创建副本")).tag("copy")
            }.disabled(busy || result != .null)
            Text(String(localized: "同一文件与目标设定只提交一次。不会替换现有角色、设定集或历史。")).font(EchoFont.caption)
            Button(String(localized: "确认导入")) {
              busy = true
              Task {
                defer { busy = false }
                do {
                  result = try await model.continuity(
                    action: "commit", id: preview["id"].string,
                    body: .object([
                      "strategy": .string(strategy),
                      "enable_prompt_suggestions": .bool(enableSuggestions),
                    ]))
                  imported = true
                  failure = nil
                } catch { failure = userFacingError(error) }
              }
            }.disabled(busy || !preview["errors"].array.isEmpty || result != .null)
              .accessibilityIdentifier("commit-import")
          }
          if result != .null {
            Section(String(localized: "导入已完成")) {
              if !result["character_id"].string.isEmpty {
                Text(String(localized: "已新增角色：\(preview["character"]["name"].string)"))
              }
              Text(
                String(
                  localized:
                    "新增 \(result["lore_ids"].array.count) 条设定集；跳过 \(result["skipped"].array.count) 项。"
                ))
              Button(String(localized: "保存原始文件（含未知扩展）")) {
                Task {
                  do {
                    let value = try await model.continuity(
                      action: "original", id: preview["id"].string)
                    original = OriginalImportFile(
                      data: Data(base64Encoded: value["data_base64"].string) ?? Data())
                    originalType = value["format"].string == "png" ? .png : .json
                    exporting = true
                  } catch { failure = userFacingError(error) }
                }
              }
            }
          }
        }
        if busy { ProgressView(String(localized: "正在处理导入内容…")) }
        if let failure {
          Label(failure, systemImage: "exclamationmark.circle")
            .foregroundStyle(Color.echo.error).fixedSize(horizontal: false, vertical: true)
        }
      }.formStyle(.grouped).toggleStyle(.switch).scrollContentBackground(.hidden)
        .background(Color.echo.surfaceSunken).navigationTitle(String(localized: "导入角色与设定集"))
        .alert(String(localized: "导入已完成"), isPresented: $imported) {
          Button(String(localized: "好")) {}
        } message: {
          Text(
            String(
              localized:
                "角色与设定集已保存。新增 \(result["lore_ids"].array.count) 条设定集，跳过 \(result["skipped"].array.count) 项。"
            )
          )
        }
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button(String(localized: "完成")) { dismiss() }
          }
        }
        .fileImporter(isPresented: $picking, allowedContentTypes: [.json, .png]) { selection in
          do {
            let url = try selection.get()
            let access = url.startAccessingSecurityScopedResource()
            defer { if access { url.stopAccessingSecurityScopedResource() } }
            let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard size <= 10 * 1024 * 1024 else { throw CocoaError(.fileReadTooLarge) }
            prepare(
              try Data(contentsOf: url),
              format: url.pathExtension.lowercased() == "png" ? "png" : "json",
              name: url.lastPathComponent)
          } catch { failure = userFacingError(error) }
        }
        .fileExporter(
          isPresented: $exporting, document: original, contentType: originalType,
          defaultFilename: "Echo-original"
        ) { selection in
          if case .failure(let error) = selection { failure = userFacingError(error) }
        }
    }.frame(minWidth: 320, idealWidth: 640, minHeight: 520)
  }
  private func prepare(_ data: Data, format: String, name: String) {
    guard data.count <= (format == "png" ? 10 : 5) * 1024 * 1024 else {
      failure = userFacingFailure(code: "import_too_large")
      return
    }
    busy = true
    preview = .null
    enableSuggestions = false
    result = .null
    filename = name
    Task {
      defer { busy = false }
      do {
        preview = try await model.continuity(
          action: "preview", id: world,
          body: .object([
            "format": .string(format), "data_base64": .string(data.base64EncodedString()),
            "audience_actor_ids": .strings(audience.sorted()),
          ]))
        result = preview["result"]
        if result != .null {
          enableSuggestions = result["enable_prompt_suggestions"].bool
          strategy = result["strategy"].string
        }
        failure = nil
      } catch { failure = userFacingError(error) }
    }
  }
}
