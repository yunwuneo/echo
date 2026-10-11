import CompanionCore
import SwiftUI

struct MemoryView: View {
  var model: AppModel
  let world: String
  @Environment(\.dismiss) private var dismiss
  @State private var status: JSONValue = .null
  @State private var failure: String?
  @State private var editing: Record?
  @State private var settings = false
  private var memories: [Record] {
    model.items("memory").filter {
      $0["world_id"].string == world && !["deleted", "invalidated"].contains($0["status"].string)
    }
  }
  var body: some View {
    NavigationStack {
      List {
        Section("后台整理") {
          Text(status["settings"]["enabled"].bool ? "已开启记忆整理；还需自主总开关和世界记忆类别允许" : "未开启自动整理")
          Text(
            status["recall_mode"].string == "hybrid"
              ? "词项与语义召回，已索引 \(status["indexed"].int) 条" : "词项召回 · 语义索引未启用或暂不可用"
          )
          .font(.caption).foregroundStyle(.secondary)
          Button("记忆与嵌入设置") { settings = true }.disabled(status["settings"]["revision"].int == 0)
          Button("刷新整理状态") { Task { await refresh() } }
          if !status["index_error"].string.isEmpty {
            Text("索引暂停：\(status["index_error"].string)").foregroundStyle(.orange)
          }
          ForEach(Array(status["jobs"].array.enumerated()), id: \.offset) { _, job in
            if !job["error_code"].string.isEmpty {
              Text("整理待处理：\(job["error_code"].string) · 尝试 \(job["attempts"].int) 次").font(.caption)
            }
          }
          Button("重试失败任务") {
            Task {
              do {
                _ = try await model.continuity(action: "retry", id: world)
                await refresh()
              } catch { failure = error.localizedDescription }
            }
          }
        }
        Section("有来源的记忆") {
          if memories.isEmpty {
            Text("尚无记忆。开启整理后，服务器在积累 8 条消息或空闲 60 秒后提取；原对话仍可正常使用。").foregroundStyle(.secondary)
          }
          ForEach(memories) { memory in
            Button {
              editing = memory
            } label: {
              VStack(alignment: .leading, spacing: 6) {
                Text(memory["content"].string).foregroundStyle(.primary)
                Text(memoryLabel(memory)).font(.caption).foregroundStyle(.secondary)
              }
            }.accessibilityIdentifier("memory-item")
          }
        }
        if let failure { Text(failure).foregroundStyle(.red) }
      }.navigationTitle("记忆与来源")
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("完成") { dismiss() } } }
        .task { await refresh() }
        .sheet(item: $editing, onDismiss: { Task { await refresh() } }) {
          MemoryEditor(model: model, memory: $0)
        }
        .sheet(isPresented: $settings, onDismiss: { Task { await refresh() } }) {
          MemorySettingsView(model: model, world: world, initial: status["settings"])
        }
    }.frame(minWidth: 320, idealWidth: 600, minHeight: 480)
  }
  private func refresh() async {
    do {
      status = try await model.continuity(action: "status", id: world)
      failure = nil
    } catch { failure = error.localizedDescription }
  }
}
private func memoryLabel(_ memory: Record) -> String {
  let status =
    ["active": "用户陈述", "claimed": "角色声称 · 未确认", "conflict": "待处理冲突", "superseded": "已被替代"][
      memory["status"].string] ?? memory["status"].string
  return (memory["manual"].bool ? "人工纠正 · " : "") + status
    + (memory["pinned"].bool ? " · 核心记忆" : "")
}
struct MemoryEditor: View {
  var model: AppModel
  let memory: Record
  @Environment(\.dismiss) private var dismiss
  @State private var content = ""
  @State private var topic = ""
  @State private var supersedes = ""
  @State private var pinned = false
  @State private var busy = false
  @State private var forgetting = false
  @State private var audience: Set<String> = []
  @State private var failure: String?
  @State private var revisions: JSONValue = .null
  @State private var erase: String?
  var body: some View {
    NavigationStack {
      Form {
        Section(memoryLabel(memory)) {
          TextField("记忆内容", text: $content, axis: .vertical).lineLimit(3...10)
            .accessibilityIdentifier("memory-content")
          TextField("主题", text: $topic)
          Toggle("固定为核心记忆", isOn: $pinned)
          Picker("替代另一条记忆", selection: $supersedes) {
            Text("不替代").tag("")
            ForEach(
              model.items("memory").filter {
                $0.id != memory.id && $0["world_id"] == memory["world_id"]
                  && ["active", "claimed", "conflict"].contains($0["status"].string)
              }
            ) {
              Text($0["content"].string).tag($0.id)
            }
          }
        }
        Section("可知角色 · 只能缩小来源范围") {
          ForEach(memory["audience_actor_ids"].array.map(\.string), id: \.self) { id in
            Toggle(
              model.items("actor").first { $0.id == id }?.name ?? "已移除角色",
              isOn: Binding(
                get: { audience.contains(id) },
                set: { if $0 { audience.insert(id) } else { audience.remove(id) } }))
          }
          if memory["audience_actor_ids"].array.isEmpty { Text("仅主人可见") }
        }
        Section("原文证据") {
          ForEach(memory["source_ids"].array.map(\.string), id: \.self) { id in
            if let source = model.items("message").first(where: { $0.id == id }) {
              VStack(alignment: .leading, spacing: 8) {
                Text(source["actor_name"].string.isEmpty ? "玩家" : source["actor_name"].string).font(
                  .caption)
                Text(source["content"].string).textSelection(.enabled)
                Button("删除这条原文及依赖内容", role: .destructive) { erase = id }
              }
            } else {
              Text("原文不在当前缓存中")
            }
          }
        }
        Section("修订记录") {
          ForEach(Array(revisions["items"].array.enumerated()), id: \.offset) { _, row in
            Text("第 \(row["revision"].int) 版：\(row["data"]["content"].string)").font(.caption)
          }
        }
        Section {
          Button("忘记这条记忆", role: .destructive) { forgetting = true }.accessibilityIdentifier(
            "forget-memory")
          Text("忘记后，来源及其派生内容不再参与召回或自动提取。删除原文还会清除相关聊天内容。").font(.caption).foregroundStyle(.secondary)
        }
        if let failure { Text(failure).foregroundStyle(.red) }
      }.formStyle(.grouped).navigationTitle("记忆详情")
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
          ToolbarItem(placement: .confirmationAction) {
            Button("保存纠正") { save() }.disabled(busy || content.isEmpty || topic.isEmpty)
              .accessibilityIdentifier("save-memory")
          }
        }
        .task {
          content = memory["content"].string
          topic = memory["topic"].string
          pinned = memory["pinned"].bool
          audience = Set(memory["audience_actor_ids"].array.map(\.string))
          do { revisions = try await model.continuity(action: "revisions", id: memory.id) } catch {
            failure = error.localizedDescription
          }
        }
        .confirmationDialog(
          "忘记后不能从旧任务自动恢复，继续？", isPresented: $forgetting, titleVisibility: .visible
        ) {
          Button("确认忘记", role: .destructive) { perform("forget", id: memory.id) }
        }
        .confirmationDialog(
          "删除原文及依赖的消息和记忆？此操作无法在客户端撤销。",
          isPresented: Binding(get: { erase != nil }, set: { if !$0 { erase = nil } }),
          titleVisibility: .visible
        ) {
          Button("确认删除原文", role: .destructive) { if let erase { perform("erase", id: erase) } }
        }
    }.frame(minWidth: 320, idealWidth: 600, minHeight: 480)
  }
  private func save() {
    var body: [String: JSONValue] = [
      "content": .string(content), "topic": .string(topic), "pinned": .bool(pinned),
      "audience_actor_ids": .strings(audience.sorted()), "valid_to": memory["valid_to"],
    ]
    if !supersedes.isEmpty { body["supersedes_id"] = .string(supersedes) }
    perform("update", id: memory.id, body: .object(body))
  }
  private func perform(_ action: String, id: String, body: JSONValue = .null) {
    busy = true
    Task {
      defer { busy = false }
      do {
        _ = try await model.continuity(
          action: action, id: id, revision: memory["revision"].int, body: body)
        dismiss()
      } catch { failure = error.localizedDescription }
    }
  }
}
struct MemorySettingsView: View {
  var model: AppModel
  let world: String
  let initial: JSONValue
  @Environment(\.dismiss) private var dismiss
  @State private var enabled = false
  @State private var busy = false
  @State private var provider = ""
  @State private var dimensions = 0
  @State private var failure: String?
  var body: some View {
    NavigationStack {
      Form {
        Toggle("自动整理长期记忆", isOn: $enabled)
        Text("使用房间的聊天模型，受全实例后台预算限制。失败不影响聊天。默认每日 20 次请求、10 万输入与 1 万输出额度，由服务器配置。").font(.caption)
        Picker("嵌入模型连接", selection: $provider) {
          Text("不启用，使用词项召回").tag("")
          ForEach(model.providers) { Text($0.name).tag($0.id) }
        }
        if !provider.isEmpty { TextField("模型向量维度", value: $dimensions, format: .number) }
        Text("嵌入连接必须支持 embeddings 接口。修改连接或维度会重建索引；重建期间保留词项召回。").font(.caption).foregroundStyle(
          .secondary)
        if let failure { Text(failure).foregroundStyle(.red) }
      }.formStyle(.grouped).navigationTitle("记忆设置")
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
          ToolbarItem(placement: .confirmationAction) {
            Button("保存") {
              busy = true
              Task {
                defer { busy = false }
                do {
                  _ = try await model.continuity(
                    action: "settings", id: world, revision: initial["revision"].int,
                    body: .object([
                      "enabled": .bool(enabled),
                      "embedding_provider_id": provider.isEmpty ? .null : .string(provider),
                      "embedding_dimensions": .number(Double(provider.isEmpty ? 0 : dimensions)),
                    ]))
                  dismiss()
                } catch { failure = error.localizedDescription }
              }
            }.disabled(busy || (!provider.isEmpty && !(1...4096).contains(dimensions)))
          }
        }
        .task {
          enabled = initial["enabled"].bool
          provider = initial["embedding_provider_id"].string
          dimensions = initial["embedding_dimensions"].int
          do { try await model.refreshSettings() } catch { failure = error.localizedDescription }
        }
    }.frame(minWidth: 320, idealWidth: 560, minHeight: 420)
  }
}
