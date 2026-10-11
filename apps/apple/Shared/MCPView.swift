import CompanionCore
import SwiftUI

func jsonText(_ value: JSONValue) -> String {
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
  return (try? encoder.encode(value)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
}
struct MCPView: View {
  var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var editing: Record?
  @State private var adding = false
  @State private var granting: Record?
  @State private var failure: String?
  var body: some View {
    NavigationStack {
      List {
        Section("远程 MCP 连接") {
          Text("支持 Streamable HTTP 和旧 SSE；Bearer / API Key。暂不支持 OAuth、STDIO 或工具服务上传。")
            .font(.caption).foregroundStyle(.secondary)
          ForEach(model.items("mcp_connection")) { connection in
            VStack(alignment: .leading, spacing: 8) {
              Button {
                editing = connection
              } label: {
                EchoSettingsRow(
                  title: connection.name, subtitle: "编辑连接与认证", symbol: "puzzlepiece.extension",
                  color: Color.echo.slate)
              }
              Text(connection["url"].string).font(.caption)
              Text(connection["enabled"].bool ? "已启用" : "已停用").font(.caption)
              Button("发现工具") {
                Task {
                  do { _ = try await model.autonomy(action: "discover", id: connection.id) } catch {
                    failure = userFacingError(error)
                  }
                }
              }
              ForEach(Array(connection["tools"].array.enumerated()), id: \.offset) { _, tool in
                Text("\(tool["name"].string) · \(tool["supported"].bool ? "可授权" : "不支持此 schema")")
                  .font(.caption)
              }
              Button("为角色授权工具") { granting = connection }.disabled(
                connection["tools"].array.isEmpty)
            }
          }
          Button("添加 MCP 连接") { adding = true }
        }
        Section("角色工具授权") {
          ForEach(model.items("tool_grant")) { grant in
            VStack(alignment: .leading, spacing: 5) {
              Text(
                grant["tool_name"].string + " · "
                  + (model.items("actor").first { $0.id == grant["actor_id"].string }?.name ?? "角色")
              )
              Text(
                "\(grant["effect"].string == "write" ? "写入" : "读取") · \(grant["approval_mode"].string == "each" ? "逐次批准" : "参数范围内授权") · \(displayDate(grant["expires_at"].string))"
              ).font(.caption)
              Text(jsonText(grant["argument_scope"])).font(.caption.monospaced()).textSelection(
                .enabled)
              if grant["enabled"].bool {
                Button("撤销授权", role: .destructive) {
                  Task {
                    do { _ = try await model.autonomy(action: "revokeGrant", id: grant.id) } catch {
                      failure = userFacingError(error)
                    }
                  }
                }
              } else {
                Text("已撤销").foregroundStyle(.secondary)
              }
            }
          }
        }
        if let failure {
          Label(failure, systemImage: "exclamationmark.circle")
            .foregroundStyle(Color.echo.error).fixedSize(horizontal: false, vertical: true)
        }
      }.buttonStyle(.borderless).scrollContentBackground(.hidden)
        .background(Color.echo.surfaceSunken).navigationTitle("MCP 连接与授权")
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("完成") { dismiss() } } }
        .sheet(isPresented: $adding) { MCPConnectionEditor(model: model, existing: nil) }
        .sheet(item: $editing) { MCPConnectionEditor(model: model, existing: $0) }
        .sheet(item: $granting) { ToolGrantEditor(model: model, connection: $0) }
    }.frame(minWidth: 320, idealWidth: 620, minHeight: 480)
  }
}
struct MCPConnectionEditor: View {
  var model: AppModel
  let existing: Record?
  @Environment(\.dismiss) private var dismiss
  @State private var name = ""
  @State private var url = ""
  @State private var credential = ""
  @State private var addresses = ""
  @State private var transport = "streamable_http"
  @State private var auth = "none"
  @State private var header = "X-API-Key"
  @State private var enabled = true
  @State private var busy = false
  @State private var failure: String?
  var body: some View {
    NavigationStack {
      Form {
        Section("连接信息") {
          LabeledContent("名称") {
            TextField("给连接起个名字", text: $name).multilineTextAlignment(.trailing)
          }
          LabeledContent("服务地址") {
            TextField("https://example.com/mcp", text: $url).autocorrectionDisabled()
              .multilineTextAlignment(.trailing)
          }
          Picker("协议", selection: $transport) {
            Text("Streamable HTTP").tag("streamable_http")
            Text("旧 SSE").tag("sse")
          }
          Toggle("启用连接", isOn: $enabled)
        }
        Section("认证方式") {
          Picker("认证", selection: $auth) {
            Text("无需认证").tag("none")
            Text("Bearer").tag("bearer")
            Text("API Key").tag("api_key")
          }
          if auth == "api_key" {
            LabeledContent("密钥请求头") {
              TextField("X-API-Key", text: $header).autocorrectionDisabled()
                .multilineTextAlignment(.trailing)
            }
          }
          if auth != "none" {
            LabeledContent("凭据") {
              SecureField(existing == nil ? "填写连接凭据" : "地址未变时可留空", text: $credential)
            }
          }
        }
        Section {
          LabeledContent("允许的内网 IP") {
            TextField("用逗号分隔", text: $addresses).autocorrectionDisabled()
              .multilineTextAlignment(.trailing)
          }
        } header: {
          Text("网络权限")
        } footer: {
          Text("默认只允许公共 HTTPS。需要内网服务时，在此列出该连接允许的精确 IP；云元数据和 link-local 地址始终禁止。")
            .fixedSize(horizontal: false, vertical: true)
        }
        if let failure {
          Label(failure, systemImage: "exclamationmark.circle")
            .foregroundStyle(Color.echo.error).fixedSize(horizontal: false, vertical: true)
        }
      }.formStyle(.grouped).toggleStyle(.switch).scrollContentBackground(.hidden)
        .background(Color.echo.surfaceSunken).navigationTitle("MCP 连接")
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
          ToolbarItem(placement: .confirmationAction) {
            Button("保存") { Task { await save() } }.disabled(busy || name.isEmpty || url.isEmpty)
          }
        }
        .onAppear {
          guard let existing else { return }
          name = existing.name
          url = existing["url"].string
          transport = existing["transport"].string
          auth = existing["auth_type"].string
          header = existing["header_name"].string
          enabled = existing["enabled"].bool
          addresses = existing["private_addresses"].array.map(\.string).joined(separator: ",")
        }
    }.frame(minWidth: 320, idealWidth: 580, minHeight: 480)
  }
  private func save() async {
    busy = true
    defer { busy = false }
    let body: JSONValue = .object([
      "name": .string(name), "url": .string(url), "transport": .string(transport),
      "enabled": .bool(enabled), "auth_type": .string(auth), "header_name": .string(header),
      "credential": .string(credential),
      "private_addresses": .strings(
        addresses.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }),
    ])
    do {
      _ = try await model.autonomy(
        action: existing == nil ? "createConnection" : "updateConnection", id: existing?.id ?? "",
        revision: existing?["revision"].int ?? 1, body: body)
      dismiss()
    } catch { failure = userFacingError(error) }
  }
}
struct ToolGrantEditor: View {
  var model: AppModel
  let connection: Record
  @Environment(\.dismiss) private var dismiss
  @State private var actor = ""
  @State private var toolName = ""
  @State private var effect = "write"
  @State private var mode = "each"
  @State private var scope = "{}"
  @State private var expiry = Date().addingTimeInterval(86400)
  @State private var busy = false
  @State private var failure: String?
  private var tool: JSONValue {
    connection["tools"].array.first { $0["name"].string == toolName } ?? .null
  }
  var body: some View {
    NavigationStack {
      Form {
        Picker("角色与世界", selection: $actor) {
          Text("选择角色").tag("")
          ForEach(model.items("actor")) { row in
            Text(
              row.name + " · "
                + (model.items("world").first { $0.id == row["world_id"].string }?.name ?? "")
            ).tag(row.id)
          }
        }
        Picker("工具", selection: $toolName) {
          Text("选择工具").tag("")
          ForEach(
            Array(connection["tools"].array.filter { $0["supported"].bool }.enumerated()),
            id: \.offset
          ) { _, t in Text(t["name"].string).tag(t["name"].string) }
        }
        Text(tool["description"].string).font(.caption)
        Picker("实际影响", selection: $effect) {
          Text("读取").tag("read")
          Text("写入现实系统").tag("write")
        }
        Text("请按工具的实际行为分类。服务端的只读提示不代表安全承诺。").font(.caption).foregroundStyle(.secondary)
        if effect == "write" {
          Picker("写入审批", selection: $mode) {
            Text("每次批准").tag("each")
            Text("仅在以下参数范围内长期授权").tag("scoped")
          }
        }
        DatePicker("授权到期", selection: $expiry, in: Date()...Date().addingTimeInterval(365 * 86400))
        Section("固定资源参数") {
          Text("用 JSON 指定必须完全相等的参数，例如 {\"calendar\":\"我的日历\"}。长期写授权必须至少固定一个资源参数。")
            .font(.caption).foregroundStyle(.secondary)
          JSONSourceEditor(
            text: $scope, accessibilityTitle: "固定资源参数 JSON", identifier: "tool-scope-json"
          )
          .frame(minHeight: 100)
          DisclosureGroup("查看工具参数定义") {
            Text(jsonText(tool["inputSchema"])).font(.caption.monospaced()).textSelection(.enabled)
          }
        }
        if let failure {
          Label(failure, systemImage: "exclamationmark.circle")
            .foregroundStyle(Color.echo.error).fixedSize(horizontal: false, vertical: true)
        }
      }.formStyle(.grouped).toggleStyle(.switch).scrollContentBackground(.hidden)
        .background(Color.echo.surfaceSunken).navigationTitle("授权具体工具")
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
          ToolbarItem(placement: .confirmationAction) {
            Button("授权") { Task { await save() } }.disabled(
              busy || actor.isEmpty || toolName.isEmpty)
          }
        }
    }.frame(minWidth: 320, idealWidth: 620, minHeight: 520)
  }
  private func save() async {
    busy = true
    defer { busy = false }
    do {
      let parsed = try JSONDecoder().decode(JSONValue.self, from: Data(scope.utf8))
      let body: JSONValue = .object([
        "world_id": .string(
          model.items("actor").first { $0.id == actor }?["world_id"].string ?? ""),
        "actor_id": .string(actor), "connection_id": .string(connection.id),
        "tool_name": .string(toolName), "schema_hash": tool["schema_hash"],
        "effect": .string(effect), "approval_mode": .string(effect == "read" ? "scoped" : mode),
        "argument_scope": parsed, "expires_at": .string(expiry.ISO8601Format()),
        "enabled": .bool(true),
      ])
      _ = try await model.autonomy(action: "createGrant", body: body)
      dismiss()
    } catch { failure = userFacingError(error) }
  }
}
struct ToolActivityView: View {
  var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var failure: String?
  @State private var busy = false
  private var calls: [Record] {
    model.items("tool_call").sorted { $0["created_at"].string > $1["created_at"].string }
  }
  var body: some View {
    NavigationStack {
      List {
        if calls.isEmpty { Text("暂无工具动作。工具调用由服务器按角色授权和审批执行。") }
        ForEach(calls) { call in
          VStack(alignment: .leading, spacing: 8) {
            Text(call["tool_name"].string).font(.headline)
            Text(
              "\(model.items("actor").first { $0.id == call["actor_id"].string }?.name ?? "角色") · \(call["effect"].string == "write" ? "现实写入" : "读取") · \(toolStatus(call["state"].string))"
            )
            .font(.caption)
            Text(jsonText(call["arguments"])).font(.caption.monospaced()).textSelection(.enabled)
            if call["state"].string == "pending" {
              Text("批准仅适用于这些参数，有效至 \(displayDate(call["expires_at"].string))。").font(.caption)
              HStack {
                Button("批准此动作") { act(call, "approve") }.accessibilityIdentifier("approve-tool")
                Button("拒绝", role: .destructive) { act(call, "deny") }
              }.disabled(busy)
            } else if call["state"].string == "outcome_unknown" {
              Text("请求可能已在目标系统执行。请先核对目标系统，再记录核对结果；不会自动重发。").foregroundStyle(Color.echo.warning)
              HStack {
                Button("已核实成功") { act(call, "confirmed_success") }
                Button("已核实未执行") { act(call, "confirmed_failure") }
              }.disabled(busy)
            }
            if !call["error_code"].string.isEmpty {
              Label(
                userFacingFailure(code: call["error_code"].string),
                systemImage: "exclamationmark.circle"
              )
              .font(.caption).foregroundStyle(Color.echo.warning)
              .fixedSize(horizontal: false, vertical: true)
            }
            if !call["result"].string.isEmpty {
              DisclosureGroup("工具返回\(call["truncated"].bool ? "（已截断）" : "")") {
                Text(call["result"].string).font(.caption).textSelection(.enabled)
              }
            }
            if let run = model.items("run").first(where: { $0.id == call["run_id"].string }),
              ["queued", "running", "awaiting_approval"].contains(run["state"].string)
            {
              Button("取消后续运行") {
                Task {
                  do { try await model.cancel(id: run.id) } catch {
                    failure = userFacingError(error)
                  }
                }
              }
            }
          }
        }
        if let failure {
          Label(failure, systemImage: "exclamationmark.circle")
            .foregroundStyle(Color.echo.error).fixedSize(horizontal: false, vertical: true)
        }
      }.buttonStyle(.borderless).scrollContentBackground(.hidden)
        .background(Color.echo.surfaceSunken).navigationTitle("工具审批与运行记录")
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("完成") { dismiss() } } }
    }.frame(minWidth: 320, idealWidth: 640, minHeight: 480)
  }
  private func act(_ call: Record, _ decision: String) {
    busy = true
    Task {
      defer { busy = false }
      do {
        _ = try await model.autonomy(
          action: "decide", id: call.id, body: .object(["decision": .string(decision)]))
      } catch { failure = userFacingError(error) }
    }
  }
}
func toolStatus(_ state: String) -> String {
  [
    "pending": "待批准", "approved": "已批准，等待执行", "executing": "执行中", "succeeded": "成功", "failed": "失败",
    "denied": "已拒绝", "expired": "已过期", "outcome_unknown": "结果未知", "resolved": "已人工核对",
  ][state] ?? state
}

func displayDate(_ value: String) -> String {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  let fractional = formatter.date(from: value)
  formatter.formatOptions = [.withInternetDateTime]
  guard let date = fractional ?? formatter.date(from: value) else { return value }
  return date.formatted(date: .abbreviated, time: .shortened)
}
