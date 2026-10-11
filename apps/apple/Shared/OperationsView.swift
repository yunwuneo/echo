import CompanionCore
import SwiftUI
import UniformTypeIdentifiers

struct OwnerArchive: FileDocument {
  static var readableContentTypes: [UTType] { [.json] }
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
  var body: some View {
    NavigationStack {
      Form {
        Section("数据导出") {
          Text("导出包含世界、角色、消息、记忆与原始导入文件，可能含私人内容，请妥善保管。模型 Key 与设备凭据不会导出。").font(.caption)
          Button(busy ? "正在准备…" : "导出我的数据") {
            busy = true
            Task {
              defer { busy = false }
              do {
                let value = try await model.operations(action: "export")
                archive = OwnerArchive(data: try JSONEncoder().encode(value))
                filename = "echo-data-\(UUID().uuidString.prefix(8)).json"
                exporting = true
              } catch { model.report(error) }
            }
          }.disabled(busy)
          Text("整实例备份与恢复由服务器管理员在维护模式下执行。").font(.caption).foregroundStyle(.secondary)
        }
        Section("服务器状态") {
          LabeledContent("版本", value: diagnostics["version"].string)
          LabeledContent("后台进程", value: diagnostics["worker"]["healthy"].bool ? "运行中" : "未检测到近期心跳")
          LabeledContent("实例", value: diagnostics["server_instance_id"].string).font(.caption)
          LabeledContent("恢复版本", value: diagnostics["data_epoch"].string).font(.caption)
          Button("导出诊断信息") {
            do {
              archive = OwnerArchive(data: try JSONEncoder().encode(diagnostics))
              filename = "echo-diagnostics-\(UUID().uuidString.prefix(8)).json"
              exporting = true
            } catch { model.report(error) }
          }
          Text("诊断仅包含版本、迁移校验和、任务状态数量与后台心跳，不包含正文、密钥或工具返回。").font(.caption)
        }
      }.formStyle(.grouped).navigationTitle("数据与诊断")
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("完成") { dismiss() }.accessibilityIdentifier("close-operations")
          }
        }
        .task {
          do { diagnostics = try await model.operations(action: "diagnostics") } catch {
            model.report(error)
          }
        }
        .fileExporter(
          isPresented: $exporting, document: archive, contentType: .json, defaultFilename: filename
        ) { result in if case .failure(let error) = result { model.report(error) } }
    }.frame(minWidth: 320, idealWidth: 560, minHeight: 460)
  }
}
