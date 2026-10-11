import CompanionCore
import SwiftUI

struct EditTarget: Identifiable {
  let id = UUID()
  var resource: String
  var record: Record?
  var world: String?
}
struct EntityEditor: View {
  var model: AppModel
  let target: EditTarget
  @Environment(\.dismiss) private var dismiss
  @State private var fields: [String: JSONValue] = [:]
  @State private var revision = 1
  @State private var busy = false
  @State private var failure: String?
  @State private var conflict: Record?
  @State private var confirmDelete = false
  private var actors: [Record] {
    model.items("actor").filter { $0["world_id"].string == target.world }
  }
  private var title: String {
    [
      "worlds": "世界", "characters": "角色模板", "actors": "世界角色", "rooms": "房间", "lore": "世界书条目",
      "providers": "模型连接", "state": "已确认剧情",
    ][target.resource] ?? "编辑"
  }
  var body: some View {
    NavigationStack {
      Form {
        if target.resource != "state" { TextField("名称", text: string("name")) }
        switch target.resource {
        case "worlds":
          TextField("世界背景", text: string("description"), axis: .vertical).lineLimit(3...8)
          TextField("玩家虚构身份", text: nestedString("persona", "name"))
          TextField("玩家描述", text: nestedString("persona", "description"), axis: .vertical)
            .lineLimit(2...6)
        case "characters":
          ForEach(
            [
              ("description", "角色描述"), ("personality", "性格"), ("voice", "说话风格"),
              ("scenario", "初始背景"), ("example", "对话示例"), ("greeting", "开场白"),
            ], id: \.0
          ) { key, label in TextField(label, text: string(key), axis: .vertical).lineLimit(2...6) }
          if fields["prompt_suggestions"] != nil {
            Section("角色提示建议") {
              TextField(
                "角色补充提示", text: nestedString("prompt_suggestions", "system_prompt"), axis: .vertical
              ).lineLimit(2...6)
              TextField(
                "回复补充提示", text: nestedString("prompt_suggestions", "post_history_instructions"),
                axis: .vertical
              ).lineLimit(2...6)
              Toggle(
                "启用提示建议",
                isOn: Binding(
                  get: { fields["prompt_suggestions"]?["enabled"].bool ?? false },
                  set: { value in
                    var obj = fields["prompt_suggestions"]?.object ?? [:]
                    obj["enabled"] = .bool(value)
                    fields["prompt_suggestions"] = .object(obj)
                  }))
            }
          }
        case "actors":
          Picker("角色模板", selection: string("template_id")) {
            Text("选择模板").tag("")
            ForEach(model.items("character")) { Text($0.name).tag($0.id) }
          }
          .onChange(of: fields["template_id"]) { _, value in
            fields["template_revision"] = .number(
              Double(
                model.items("character").first { $0.id == value?.string }?["revision"].int ?? 1))
          }
          Stepper(
            "固定模板版本：\(fields["template_revision"]?.int ?? 1)", value: number("template_revision"),
            in:
              1...max(
                1,
                model.items("character").first { $0.id == fields["template_id"]?.string }?[
                  "revision"
                ].int ?? 1))
          Stepper(
            "参与度：\(fields["participation"]?.int ?? 50)", value: number("participation"),
            in: 0...100, step: 10)
          Text("每个世界中的角色独立保留经历。模板编辑后，可在这里明确选择要采用的版本。").font(.caption).foregroundStyle(.secondary)
        case "rooms":
          Picker("房间类型", selection: string("kind")) {
            Text("私聊").tag("direct")
            Text("群聊").tag("group")
          }
          Picker("模型连接", selection: string("provider_id")) {
            Text("选择模型").tag("")
            ForEach(model.providers) { Text($0.name).tag($0.id) }
          }
          Stepper(
            "每轮最多 \(fields["max_replies"]?.int ?? 3) 条回复", value: number("max_replies"), in: 1...3)
          Section("参与角色 · 私聊 1 位，群聊最多 8 位") { actorToggles("actor_ids") }
          Text("新成员无法读取加入前的消息或先前已接收的输入。").font(.caption).foregroundStyle(.secondary)
        case "lore":
          TextField("设定内容", text: string("content"), axis: .vertical).lineLimit(3...10)
          Toggle("启用", isOn: boolean("enabled"))
          Toggle("常驻条目", isOn: boolean("constant"))
          TextField("触发关键词（每行一个）", text: list("keys"), axis: .vertical).lineLimit(2...6)
          Picker("匹配方式", selection: string("match_mode")) {
            Text("关键词").tag("keywords")
            Text("安全正则（RE2）").tag("regex")
          }
          Toggle("区分大小写", isOn: boolean("case_sensitive"))
          Stepper(
            "持续轮次：\(fields["sticky_turns"]?.int ?? 0)", value: number("sticky_turns"), in: 0...100)
          Stepper(
            "冷却轮次：\(fields["cooldown_turns"]?.int ?? 0)", value: number("cooldown_turns"),
            in: 0...100)
          Stepper(
            "延迟轮次：\(fields["delay_turns"]?.int ?? 0)", value: number("delay_turns"), in: 0...100)
          Text("按当前角色成功回复计数。预览与失败重试不计数；延迟要求连续命中，冷却从持续期结束后开始。").font(.caption).foregroundStyle(
            .secondary)
          Stepper(
            "扫描最近 \(fields["scan_depth"]?.int ?? 8) 条可见消息", value: number("scan_depth"), in: 1...50)
          Stepper(
            "优先级：\(fields["priority"]?.int ?? 0)", value: number("priority"), in: -1000...1000)
          Picker("插入位置", selection: string("insertion_slot")) {
            Text("角色设定前").tag("before_character")
            Text("角色设定后").tag("after_character")
            Text("历史前").tag("before_history")
            Text("历史中").tag("history_depth")
          }
          if fields["insertion_slot"]?.string == "history_depth" {
            Stepper(
              "距历史结尾 \(fields["injection_depth"]?.int ?? 0) 条", value: number("injection_depth"),
              in: 0...50)
          }
          Section("可知角色 · 不选表示世界内公开") { actorToggles("audience_actor_ids") }
        case "state":
          TextField("当前地点", text: nestedString("data", "location"))
          TextField("剧情时间", text: nestedString("data", "time"))
          TextField("未完成话题（每行一个）", text: nestedList("data", "open_topics"), axis: .vertical)
            .lineLimit(2...6)
          Section("在场角色") {
            ForEach(actors) { actor in
              Toggle(actor.name, isOn: nestedContains("data", "present_actor_ids", actor.id))
            }
          }
          Section("可知角色 · 不选表示世界内公开") { actorToggles("audience_actor_ids") }
          Text("此处由你确认剧情事实。角色在聊天中的主观说法会保留为角色声称。").font(.caption).foregroundStyle(.secondary)
        case "providers":
          Toggle("模型支持工具调用", isOn: boolean("tools_enabled"))
          TextField("模型 API 地址", text: string("base_url")).autocorrectionDisabled()
          TextField("模型 ID", text: string("model")).autocorrectionDisabled()
          SecureField("API Key", text: string("api_key"))
          TextField("上下文 token 上限", value: number("context_window"), format: .number)
          TextField("单次输出 token 上限", value: number("max_output_tokens"), format: .number)
          Text("Key 将加密保存到你的服务器，以便客户端关闭时运行。当前只使用文本流式能力。").font(.caption).foregroundStyle(.secondary)
        default: EmptyView()
        }
        if let failure { Section { Text(failure).foregroundStyle(.red).textSelection(.enabled) } }
        if let conflict {
          Section("服务器当前版本：\(conflict["revision"].int)") {
            Text(summary(conflict.value)).textSelection(.enabled)
            Text("上方仍是你的编辑内容。")
            Button("采用服务器版本") {
              fields = editable(conflict)
              revision = conflict["revision"].int
              self.conflict = nil
              failure = nil
            }
            Button("保留我的编辑，与此版本重新比较后保存") {
              revision = conflict["revision"].int
              self.conflict = nil
              failure = nil
            }
          }
        }
        if target.record != nil && target.resource != "state" {
          Section { Button("删除\(title)", role: .destructive) { confirmDelete = true } }
        }
      }
      .formStyle(.grouped)
      .navigationTitle((target.record == nil ? "新建" : "编辑") + title)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button(busy ? "保存中…" : "保存") { save() }.disabled(busy || conflict != nil)
        }
      }
      .task {
        fields = target.record.map(editable) ?? defaults()
        revision = target.record?["revision"].int ?? 1
        if target.resource == "rooms" {
          do { try await model.refreshSettings() } catch { model.report(error) }
        }
      }
      .confirmationDialog("删除后，该内容将从工作区移除。", isPresented: $confirmDelete, titleVisibility: .visible)
      {
        Button("删除", role: .destructive) {
          Task {
            do {
              if let record = target.record {
                try await model.delete(resource: target.resource, record: record)
              }
              dismiss()
            } catch {
              failure =
                APIConnection.apiError(error)?.localizedDescription ?? error.localizedDescription
            }
          }
        }
      }
    }
    .frame(minWidth: 320, idealWidth: 560, minHeight: 440, idealHeight: 680)
  }
  private func save() {
    busy = true
    failure = nil
    Task {
      defer { busy = false }
      do {
        try await model.save(
          resource: target.resource,
          id: target.resource == "state" ? target.world : target.record?.id, revision: revision,
          body: .object(fields))
        fields["api_key"] = nil
        dismiss()
      } catch {
        failure = APIConnection.apiError(error)?.localizedDescription ?? error.localizedDescription
        if APIConnection.apiError(error)?.status == 409 {
          conflict = model.items(
            [
              "worlds": "world", "characters": "character", "actors": "actor", "rooms": "room",
              "lore": "lore", "state": "state",
            ][target.resource] ?? ""
          ).first { $0.id == (target.record?.id ?? target.world) }
        }
      }
    }
  }
  private func editable(_ record: Record) -> [String: JSONValue] {
    var object = record.value.object
    object.removeValue(forKey: "id")
    object.removeValue(forKey: "revision")
    if target.resource == "lore" && object["match_mode"] == nil {
      object["match_mode"] = .string("keywords")
    }
    if target.resource == "state" { object.removeValue(forKey: "world_id") }
    return object
  }
  private func defaults() -> [String: JSONValue] {
    switch target.resource {
    case "worlds":
      [
        "name": .string(""), "description": .string(""),
        "persona": .object(["name": .string("玩家"), "description": .string("")]),
      ]
    case "characters":
      Dictionary(
        uniqueKeysWithValues: [
          "name", "description", "personality", "voice", "scenario", "example", "greeting",
        ].map { ($0, JSONValue.string("")) })
    case "actors":
      [
        "world_id": .string(target.world ?? ""), "name": .string(""), "template_id": .string(""),
        "template_revision": .number(1), "participation": .number(50),
      ]
    case "rooms":
      [
        "world_id": .string(target.world ?? ""), "name": .string(""), "provider_id": .string(""),
        "kind": .string("group"), "max_replies": .number(3), "actor_ids": .array([]),
      ]
    case "lore":
      [
        "world_id": .string(target.world ?? ""), "name": .string(""), "content": .string(""),
        "enabled": .bool(true), "constant": .bool(false), "keys": .array([]),
        "case_sensitive": .bool(false), "scan_depth": .number(8), "priority": .number(0),
        "insertion_slot": .string("before_history"), "injection_depth": .number(0),
        "audience_actor_ids": .array([]), "match_mode": .string("keywords"),
        "sticky_turns": .number(0), "cooldown_turns": .number(0), "delay_turns": .number(0),
      ]
    case "state":
      [
        "data": .object([
          "location": .string(""), "time": .string(""), "present_actor_ids": .array([]),
          "open_topics": .array([]),
        ]), "audience_actor_ids": .array([]),
      ]
    case "providers":
      [
        "name": .string(""), "base_url": .string("https://"), "model": .string(""),
        "api_key": .string(""), "context_window": .number(32768),
        "max_output_tokens": .number(1024),
      ]
    default: [:]
    }
  }
  private func string(_ key: String) -> Binding<String> {
    Binding(get: { fields[key]?.string ?? "" }, set: { fields[key] = .string($0) })
  }
  private func number(_ key: String) -> Binding<Int> {
    Binding(get: { fields[key]?.int ?? 0 }, set: { fields[key] = .number(Double($0)) })
  }
  private func boolean(_ key: String) -> Binding<Bool> {
    Binding(get: { fields[key]?.bool ?? false }, set: { fields[key] = .bool($0) })
  }
  private func list(_ key: String) -> Binding<String> {
    Binding(
      get: { fields[key]?.array.map(\.string).joined(separator: "\n") ?? "" },
      set: { fields[key] = .strings($0.split(separator: "\n").map(String.init)) })
  }
  private func nestedString(_ parent: String, _ key: String) -> Binding<String> {
    Binding(
      get: { fields[parent]?[key].string ?? "" },
      set: {
        var obj = fields[parent]?.object ?? [:]
        obj[key] = .string($0)
        fields[parent] = .object(obj)
      })
  }
  private func nestedList(_ parent: String, _ key: String) -> Binding<String> {
    Binding(
      get: { fields[parent]?[key].array.map(\.string).joined(separator: "\n") ?? "" },
      set: {
        var obj = fields[parent]?.object ?? [:]
        obj[key] = .strings($0.split(separator: "\n").map(String.init))
        fields[parent] = .object(obj)
      })
  }
  private func nestedContains(_ parent: String, _ key: String, _ id: String) -> Binding<Bool> {
    Binding(
      get: { fields[parent]?[key].array.contains(.string(id)) ?? false },
      set: { on in
        var obj = fields[parent]?.object ?? [:]
        var values = obj[key]?.array ?? []
        values.removeAll { $0 == .string(id) }
        if on { values.append(.string(id)) }
        obj[key] = .array(values)
        fields[parent] = .object(obj)
      })
  }
  @ViewBuilder private func actorToggles(_ key: String) -> some View {
    ForEach(actors) { actor in
      Toggle(
        actor.name,
        isOn: Binding(
          get: { fields[key]?.array.contains(.string(actor.id)) ?? false },
          set: { on in
            var values = fields[key]?.array ?? []
            values.removeAll { $0 == .string(actor.id) }
            if on { values.append(.string(actor.id)) }
            fields[key] = .array(values)
          }))
    }
  }
  private func summary(_ value: JSONValue) -> String {
    value.object.sorted { $0.key < $1.key }.filter {
      !["id", "world_id", "provider_id", "template_id", "revision"].contains($0.key)
    }.map { key, value in
      let label =
        [
          "name": "名称", "description": "描述", "persona": "玩家身份", "content": "内容",
          "personality": "性格", "voice": "语气", "scenario": "背景", "example": "示例", "greeting": "开场白",
          "data": "剧情状态", "location": "地点", "time": "时间", "actor_ids": "房间成员",
          "audience_actor_ids": "可知角色", "present_actor_ids": "在场角色", "open_topics": "未完成话题",
          "max_replies": "回复上限", "participation": "参与度", "template_revision": "模板版本",
        ][key] ?? key
      if case .object = value { return "\(label)：\n\(summary(value))" }
      if case .array = value {
        return "\(label)："
          + value.array.map { element in
            model.items("actor").first { $0.id == element.string }?.name ?? element.string
          }.joined(separator: "、")
      }
      return "\(label)：\(value.string.isEmpty ? String(value.int) : value.string)"
    }.joined(separator: "\n")
  }
}
