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
  @State private var original: [String: JSONValue] = [:]
  @State private var numericText: [String: String] = [:]
  @State private var originalNumericText: [String: String] = [:]
  @State private var revision = 1
  @State private var busy = false
  @State private var loaded = false
  @State private var failure: String?
  @State private var conflict: Record?
  @State private var confirmDelete = false
  @State private var confirmDiscard = false
  @State private var showValidation = false
  @State private var scrollTarget: String?
  private var dirty: Bool { fields != original || numericText != originalNumericText }
  private var actors: [Record] {
    model.items("actor").filter { $0["world_id"].string == target.world }
  }
  private var title: String {
    [
      "worlds": "世界", "characters": "角色模板", "actors": "世界角色", "rooms": "房间",
      "lore": "世界书条目", "providers": "模型连接", "state": "已确认剧情",
    ][target.resource] ?? "内容"
  }
  var body: some View {
    NavigationStack {
      ScrollViewReader { proxy in
        Form {
          if target.resource != "state" {
            Section("基本信息") { field("name", "名称", text: string("name")) }
          }
          editorSections
          if let failure {
            Section {
              Label(failure, systemImage: "exclamationmark.circle")
                .font(.callout).foregroundStyle(Color.echo.error).fixedSize(
                  horizontal: false, vertical: true)
            }.id("form-error")
          }
          conflictSection
          if target.record != nil && target.resource != "state" {
            Section {
              Button("删除\(title)", role: .destructive) { confirmDelete = true }
            } footer: {
              EchoFormHint("删除后，这项内容会从工作区移除。请确认不再需要后再操作。")
            }
          }
        }
        .formStyle(.grouped)
        .scrollContentBackground(.hidden)
        .background(Color.echo.bg)
        .toggleStyle(.switch)
        .disabled(busy)
        .onChange(of: scrollTarget) { _, target in
          if let target { withAnimation { proxy.scrollTo(target, anchor: .center) } }
        }
        #if os(macOS)
          .safeAreaInset(edge: .bottom, spacing: 0) { actions }
        #endif
      }
      .navigationTitle((target.record == nil ? "新建" : "编辑") + title)
      #if os(iOS)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { cancelButton }
          ToolbarItem(placement: .confirmationAction) { saveButton }
        }
      #endif
      .task {
        guard !loaded else { return }
        fields = target.record.map(editable) ?? defaults()
        original = fields
        resetNumericInputs()
        revision = target.record?["revision"].int ?? 1
        loaded = true
        if target.resource == "rooms" {
          do { try await model.refreshSettings() } catch { failure = userFacingError(error) }
        }
      }
      .confirmationDialog(
        "删除\(title)后，该内容将从工作区移除。", isPresented: $confirmDelete, titleVisibility: .visible
      ) {
        Button("删除\(title)", role: .destructive) { delete() }
        Button("保留", role: .cancel) {}
      }
      .confirmationDialog("放弃尚未保存的修改？", isPresented: $confirmDiscard, titleVisibility: .visible) {
        Button("放弃修改", role: .destructive) { dismiss() }
        Button("继续编辑", role: .cancel) {}
      }
    }
    .tint(Color.echo.primary)
    .interactiveDismissDisabled(dirty || busy)
    #if os(macOS)
      .frame(minWidth: 560, idealWidth: EchoMetric.formWidth, minHeight: 520, idealHeight: 680)
    #endif
  }

  @ViewBuilder private var editorSections: some View {
    switch target.resource {
    case "worlds": worldSections
    case "characters": characterSections
    case "actors": actorSections
    case "rooms": roomSections
    case "lore": loreSections
    case "state": stateSections
    case "providers": providerSections
    default: EmptyView()
    }
  }
  private var worldSections: some View {
    Group {
      Section("世界设定") {
        field("description", "世界背景", text: string("description"), lines: 3...8)
      }
      Section {
        field("persona.name", "玩家名字", text: nestedString("persona", "name"))
        field(
          "persona.description", "玩家描述", text: nestedString("persona", "description"), lines: 2...6)
      } header: {
        Text("你在这个世界中的身份")
      } footer: {
        EchoFormHint("这里填写虚构身份，角色会通过这个身份认识你。")
      }
    }
  }
  private var characterSections: some View {
    Group {
      Section("角色设定") {
        ForEach(
          [
            ("description", "角色描述"), ("personality", "性格"), ("voice", "说话风格"),
            ("scenario", "初始背景"), ("example", "对话示例"), ("greeting", "开场白"),
          ], id: \.0
        ) { key, title in
          field(key, title, text: string(key), lines: 2...6)
        }
      }
      if fields["prompt_suggestions"] != nil {
        Section("角色提示建议") {
          Toggle(
            "启用提示建议",
            isOn: Binding(
              get: { fields["prompt_suggestions"]?["enabled"].bool ?? false },
              set: { value in
                var obj = fields["prompt_suggestions"]?.object ?? [:]
                obj["enabled"] = .bool(value)
                fields["prompt_suggestions"] = .object(obj)
              }))
          Group {
            field(
              "prompt_suggestions.system_prompt", "角色补充提示",
              text: nestedString("prompt_suggestions", "system_prompt"), lines: 2...6)
            field(
              "prompt_suggestions.post_history_instructions", "回复补充提示",
              text: nestedString("prompt_suggestions", "post_history_instructions"), lines: 2...6)
          }.disabled(fields["prompt_suggestions"]?["enabled"].bool != true)
        }
      }
    }
  }
  private var actorSections: some View {
    Section {
      EchoFormField("角色模板", error: issue("template_id")) {
        Picker(
          "角色模板",
          selection: Binding(
            get: { fields["template_id"]?.string ?? "" },
            set: { selected in
              fields["template_id"] = .string(selected)
              // Only a deliberate template selection changes the pinned version.
              fields["template_revision"] = .number(
                Double(
                  model.items("character").first { $0.id == selected }?["revision"].int ?? 1))
            })
        ) {
          Text("选择模板").tag("")
          ForEach(model.items("character")) { Text($0.name).tag($0.id) }
        }.labelsHidden()
      }.id("template_id")
      Stepper(
        "模板版本：\(fields["template_revision"]?.int ?? 1)", value: number("template_revision"),
        in:
          1...max(
            1,
            model.items("character").first { $0.id == fields["template_id"]?.string }?["revision"]
              .int ?? 1)
      )
      .disabled(fields["template_id"]?.string.isEmpty != false)
      EchoFormField("参与度") {
        HStack {
          Slider(
            value: Binding(
              get: { Double(fields["participation"]?.int ?? 50) },
              set: { fields["participation"] = .number($0) }), in: 0...100, step: 10
          )
          .accessibilityLabel("参与度")
          Text("\(fields["participation"]?.int ?? 50)%").monospacedDigit().frame(minWidth: 44)
        }
      }
    } header: {
      Text("在世界中的角色")
    } footer: {
      EchoFormHint("各个世界的角色独立保留经历。模板更新后，你可以在这里选择采用的版本；参与度影响未点名时的发言机会。")
    }
  }
  private var roomSections: some View {
    Group {
      Section("对话设置") {
        EchoFormField("房间类型") {
          Picker("房间类型", selection: string("kind")) {
            Text("私聊").tag("direct")
            Text("群聊").tag("group")
          }.pickerStyle(.segmented).labelsHidden()
        }
        EchoFormField("模型连接", error: issue("provider_id")) {
          Picker("模型连接", selection: string("provider_id")) {
            Text("选择模型").tag("")
            ForEach(model.providers) { Text($0.name).tag($0.id) }
          }.labelsHidden()
        }.id("provider_id")
        Stepper(
          "每轮最多 \(fields["max_replies"]?.int ?? 3) 条回复", value: number("max_replies"), in: 1...3)
      }
      Section {
        actorToggles("actor_ids")
        validationHint("actor_ids")
      } header: {
        Text(fields["kind"]?.string == "direct" ? "参与角色 · 选择 1 位" : "参与角色 · 最多 8 位")
      } footer: {
        EchoFormHint("新成员无法读取加入前的消息或先前已接收的输入。")
      }
      .id("actor_ids")
    }
  }
  private var loreSections: some View {
    Group {
      Section("设定内容") {
        field("content", "设定内容", text: string("content"), lines: 3...10)
        Toggle("启用条目", isOn: boolean("enabled"))
      }
      Section {
        Toggle("始终提供这条设定", isOn: boolean("constant"))
        Group {
          field("keys", "触发词 · 每行一个", text: list("keys"), lines: 2...6)
          EchoFormField("匹配方式") {
            Picker("匹配方式", selection: string("match_mode")) {
              Text("关键词").tag("keywords")
              Text("安全正则").tag("regex")
            }.pickerStyle(.segmented).labelsHidden()
          }
          Toggle("区分大小写", isOn: boolean("case_sensitive"))
        }.disabled(fields["constant"]?.bool == true)
        Stepper(
          "持续 \(fields["sticky_turns"]?.int ?? 0) 轮", value: number("sticky_turns"), in: 0...100)
        Stepper(
          "冷却 \(fields["cooldown_turns"]?.int ?? 0) 轮", value: number("cooldown_turns"), in: 0...100
        )
        Stepper(
          "延迟 \(fields["delay_turns"]?.int ?? 0) 轮", value: number("delay_turns"), in: 0...100)
      } header: {
        Text("何时想起这条设定")
      } footer: {
        EchoFormHint("按当前角色成功回复计数。预览和失败重试不计数；延迟要求连续命中，冷却从持续期结束后开始。正则使用 RE2 兼容规则。")
      }
      .disabled(fields["enabled"]?.bool != true)
      Section("提供给角色的位置") {
        Stepper(
          "扫描最近 \(fields["scan_depth"]?.int ?? 8) 条可见消息", value: number("scan_depth"), in: 1...50)
        Stepper("优先级：\(fields["priority"]?.int ?? 0)", value: number("priority"), in: -1000...1000)
        Picker("插入位置", selection: string("insertion_slot")) {
          Text("角色设定前").tag("before_character")
          Text("角色设定后").tag("after_character")
          Text("历史前").tag("before_history")
          Text("历史中").tag("history_depth")
        }
        Stepper(
          "距历史结尾 \(fields["injection_depth"]?.int ?? 0) 条", value: number("injection_depth"),
          in: 0...50
        )
        .disabled(fields["insertion_slot"]?.string != "history_depth")
      }.disabled(fields["enabled"]?.bool != true)
      Section("可知角色 · 不选表示世界内公开") {
        actorToggles("audience_actor_ids")
        validationHint("audience_actor_ids")
      }.id("audience_actor_ids")
    }
  }
  private var stateSections: some View {
    Group {
      Section("当前剧情") {
        field("data.location", "当前地点", text: nestedString("data", "location"))
        field("data.time", "剧情时间", text: nestedString("data", "time"))
        field(
          "data.open_topics", "未完成话题 · 每行一个", text: nestedList("data", "open_topics"), lines: 2...6)
      }
      Section("在场角色") {
        ForEach(actors) { actor in
          Toggle(actor.name, isOn: nestedContains("data", "present_actor_ids", actor.id))
        }
        validationHint("data.present_actor_ids")
      }.id("data.present_actor_ids")
      Section {
        actorToggles("audience_actor_ids")
        validationHint("audience_actor_ids")
      } header: {
        Text("可知角色 · 不选表示世界内公开")
      } footer: {
        EchoFormHint("这里保存由你确认的剧情事实。角色在聊天中的主观说法会保留为角色声称。")
      }
      .id("audience_actor_ids")
    }
  }
  private var providerSections: some View {
    Group {
      Section("连接信息") {
        field("base_url", "模型 API 地址", text: string("base_url"))
          .autocorrectionDisabled()
          #if os(iOS)
            .textInputAutocapitalization(.never)
            .keyboardType(.URL)
          #endif
        field("model", "模型 ID", text: string("model")).autocorrectionDisabled()
          #if os(iOS)
            .textInputAutocapitalization(.never)
          #endif
        EchoFormField("API Key", error: issue("api_key")) {
          SecureField("填写 API Key", text: string("api_key")).textFieldStyle(.roundedBorder)
            .accessibilityLabel("API Key")
        }.id("api_key")
        Toggle("模型支持工具调用", isOn: boolean("tools_enabled"))
      }
      Section {
        providerNumber("context_window", "上下文上限")
        providerNumber("max_output_tokens", "单次输出上限")
      } header: {
        Text("文本额度")
      } footer: {
        EchoFormHint("Key 会加密保存到你的服务器，以便客户端关闭时继续运行。单次输出必须小于上下文上限。")
      }
    }
  }
  @ViewBuilder private var conflictSection: some View {
    if let conflict {
      Section("服务器当前版本：\(conflict["revision"].int)") {
        Text(summary(conflict.value)).textSelection(.enabled)
        EchoFormHint("上方仍保留你的编辑，请比较后再决定。")
        Button("采用服务器版本") {
          fields = editable(conflict)
          original = fields
          resetNumericInputs()
          revision = conflict["revision"].int
          self.conflict = nil
          failure = nil
        }
        Button("保留我的编辑，准备重新保存") {
          original = editable(conflict)
          revision = conflict["revision"].int
          self.conflict = nil
          failure = nil
        }
      }
    }
  }
  private var cancelButton: some View {
    Button("取消") { if dirty { confirmDiscard = true } else { dismiss() } }
      .disabled(busy).keyboardShortcut(.cancelAction)
  }
  private var saveButton: some View {
    Button(busy ? "保存中…" : "保存") {
      showValidation = true
      scrollTarget = nil
      if let first = validation.first {
        Task { @MainActor in scrollTarget = first.0 }
      } else {
        save()
      }
    }.disabled(!loaded || busy || conflict != nil || !dirty).keyboardShortcut(.defaultAction)
  }
  private var actions: some View {
    HStack(spacing: EchoSpacing.sm) {
      if dirty { Text("有未保存的修改").font(.caption).foregroundStyle(Color.echo.textSecondary) }
      Spacer()
      cancelButton.buttonStyle(.bordered)
      saveButton.buttonStyle(.borderedProminent)
    }.padding(EchoSpacing.md).background(.bar).overlay(alignment: .top) { Divider() }
  }
  private func field(
    _ key: String, _ title: String, text: Binding<String>, lines: ClosedRange<Int> = 1...1
  ) -> some View {
    EchoFormField(title, error: issue(key)) {
      TextField(title, text: text, axis: .vertical).lineLimit(lines).textFieldStyle(.roundedBorder)
        .accessibilityLabel(title)
    }.id(key)
  }
  private func providerNumber(_ key: String, _ title: String) -> some View {
    EchoFormField(title, error: issue(key)) {
      HStack {
        TextField(
          "0",
          text: Binding(
            get: { numericText[key] ?? "" },
            set: {
              numericText[key] = $0
              if let value = echoInteger($0) { fields[key] = .number(Double(value)) }
            })
        ).multilineTextAlignment(.trailing).monospacedDigit().textFieldStyle(.roundedBorder)
          .accessibilityLabel(title + "，tokens")
          #if os(iOS)
            .keyboardType(.numberPad)
          #endif
        Text("tokens").foregroundStyle(Color.echo.textSecondary)
      }
    }.id(key)
  }
  private func resetNumericInputs() {
    if target.resource == "providers" {
      for key in ["context_window", "max_output_tokens"] {
        numericText[key] = (fields[key]?.int ?? 0).formatted(
          .number.locale(Locale(identifier: "zh_CN")))
      }
    }
    originalNumericText = numericText
  }
  @ViewBuilder private func validationHint(_ key: String) -> some View {
    if let message = issue(key) {
      Label(message, systemImage: "exclamationmark.circle").font(.caption)
        .foregroundStyle(Color.echo.error).fixedSize(horizontal: false, vertical: true)
    }
  }
  private func issue(_ key: String) -> String? {
    showValidation ? validation.first { $0.0 == key }?.1 : nil
  }
  private var validation: [(String, String)] {
    var result: [(String, String)] = []
    func checkText(
      _ key: String, _ text: String, _ title: String, max: Int = 16000, required: Bool = false
    ) {
      if required && text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        result.append((key, "请填写\(title)。"))
      } else if text.unicodeScalars.count > max {
        result.append((key, "\(title)最多 \(max.formatted()) 个字符。"))
      }
    }
    if target.resource != "state" {
      checkText("name", fields["name"]?.string ?? "", "名称", max: 80, required: true)
    }
    switch target.resource {
    case "worlds":
      checkText("description", fields["description"]?.string ?? "", "世界背景")
      checkText(
        "persona.name", fields["persona"]?["name"].string ?? "", "玩家名字", max: 80, required: true)
      checkText("persona.description", fields["persona"]?["description"].string ?? "", "玩家描述")
    case "characters":
      for key in ["description", "personality", "voice", "scenario", "example", "greeting"] {
        checkText(key, fields[key]?.string ?? "", "这项内容")
      }
      for key in ["system_prompt", "post_history_instructions"] {
        checkText(
          "prompt_suggestions." + key, fields["prompt_suggestions"]?[key].string ?? "", "补充提示")
      }
    case "actors":
      if !model.items("character").contains(where: { $0.id == fields["template_id"]?.string }) {
        result.append(("template_id", "请选择角色模板。"))
      }
    case "rooms":
      if !model.providers.contains(where: { $0.id == fields["provider_id"]?.string }) {
        result.append(("provider_id", "请选择模型连接。"))
      }
      let count = fields["actor_ids"]?.array.count ?? 0
      if fields["kind"]?.string == "direct" && count != 1 {
        result.append(("actor_ids", "私聊需要选择 1 位角色。"))
      } else if !(1...8).contains(count) {
        result.append(("actor_ids", "群聊需要选择 1–8 位角色。"))
      }
    case "lore":
      checkText("content", fields["content"]?.string ?? "", "设定内容")
      let keys = fields["keys"]?.array ?? []
      if keys.count > 32 || keys.contains(where: { $0.string.unicodeScalars.count > 120 }) {
        result.append(("keys", "最多填写 32 个触发词，每个不超过 120 个字符。"))
      }
    case "state":
      for key in ["location", "time"] {
        checkText("data." + key, fields["data"]?[key].string ?? "", "这项内容", max: 500)
      }
      let topics = fields["data"]?["open_topics"].array ?? []
      if topics.count > 20 || topics.contains(where: { $0.string.unicodeScalars.count > 500 }) {
        result.append(("data.open_topics", "最多填写 20 个话题，每个不超过 500 个字符。"))
      }
      if (fields["data"]?["present_actor_ids"].array.count ?? 0) > 8 {
        result.append(("data.present_actor_ids", "最多选择 8 位在场角色。"))
      }
    case "providers":
      let address = fields["base_url"]?.string ?? ""
      if let url = URLComponents(string: address),
        ["https", "http"].contains(url.scheme?.lowercased() ?? ""), url.host?.isEmpty == false,
        address.unicodeScalars.count <= 2048
      {
      } else {
        result.append(("base_url", "请填写完整的 http:// 或 https:// 模型 API 地址。"))
      }
      checkText("model", fields["model"]?.string ?? "", "模型 ID", max: 200, required: true)
      checkText("api_key", fields["api_key"]?.string ?? "", "API Key", max: 4096, required: true)
      for (key, title, range) in [
        ("context_window", "上下文上限", 2048...1_000_000), ("max_output_tokens", "单次输出上限", 1...8192),
      ] {
        if let value = echoInteger(numericText[key] ?? ""), range.contains(value) {
        } else {
          result.append(
            (
              key,
              "\(title)需为 \(range.lowerBound.formatted())–\(range.upperBound.formatted()) tokens 的整数。"
            ))
        }
      }
      if let output = echoInteger(numericText["max_output_tokens"] ?? ""),
        let context = echoInteger(numericText["context_window"] ?? ""), output >= context
      {
        result.append(("max_output_tokens", "单次输出上限必须小于上下文上限。"))
      }
    default: break
    }
    if (fields["audience_actor_ids"]?.array.count ?? 0) > 8 {
      result.append(("audience_actor_ids", "最多选择 8 位可知角色。"))
    }
    return result
  }
  private func save() {
    guard dirty, validation.isEmpty else { return }
    busy = true
    failure = nil
    Task {
      defer { busy = false }
      do {
        try await model.save(
          resource: target.resource,
          id: target.resource == "state" ? target.world : target.record?.id,
          revision: revision, body: .object(fields))
        fields["api_key"] = nil
        dismiss()
      } catch {
        failure = userFacingError(error)
        if APIConnection.apiError(error)?.status == 409 {
          conflict = model.items(
            [
              "worlds": "world", "characters": "character", "actors": "actor", "rooms": "room",
              "lore": "lore", "state": "state",
            ][target.resource] ?? ""
          )
          .first { $0.id == (target.record?.id ?? target.world) }
        }
        scrollTarget = "form-error"
      }
    }
  }
  private func delete() {
    guard !busy, let record = target.record else { return }
    busy = true
    Task {
      defer { busy = false }
      do {
        try await model.delete(resource: target.resource, record: record)
        dismiss()
      } catch {
        failure = userFacingError(error)
        scrollTarget = "form-error"
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

/// A permanent label keeps filled-in values understandable on both platforms.
struct EchoFormField<Content: View>: View {
  let title: String
  var error: String?
  @ViewBuilder var content: () -> Content

  init(_ title: String, error: String? = nil, @ViewBuilder content: @escaping () -> Content) {
    self.title = title
    self.error = error
    self.content = content
  }
  var body: some View {
    VStack(alignment: .leading, spacing: EchoSpacing.xs) {
      #if os(macOS)
        HStack(alignment: .firstTextBaseline, spacing: EchoSpacing.md) {
          Text(title).font(.body).frame(width: 180, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
          content().labelsHidden().frame(maxWidth: .infinity, alignment: .leading)
        }
      #else
        VStack(alignment: .leading, spacing: EchoSpacing.xs) {
          Text(title).font(.callout).foregroundStyle(Color.echo.textSecondary)
          content().labelsHidden().frame(maxWidth: .infinity, alignment: .leading)
        }
      #endif
      if let error {
        Label(error, systemImage: "exclamationmark.circle")
          .font(.caption).foregroundStyle(Color.echo.error)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(EchoSpacing.xxs)
    .overlay {
      RoundedRectangle(cornerRadius: EchoRadius.sm)
        .stroke(error == nil ? .clear : Color.echo.error, lineWidth: 1)
        .allowsHitTesting(false)
    }
  }
}

struct EchoFormHint: View {
  let text: String
  init(_ text: String) { self.text = text }
  var body: some View {
    Text(text).font(.footnote).foregroundStyle(Color.echo.textSecondary)
      .fixedSize(horizontal: false, vertical: true)
  }
}

func echoInteger(_ text: String) -> Int? {
  let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
  let digits = trimmed.hasPrefix("-") ? String(trimmed.dropFirst()) : trimmed
  let groups = digits.split(separator: ",", omittingEmptySubsequences: false)
  guard !groups.isEmpty,
    groups.allSatisfy({ !$0.isEmpty && $0.allSatisfy { $0.isASCII && $0.isNumber } })
  else { return nil }
  if groups.count > 1 {
    guard (1...3).contains(groups[0].count), groups.dropFirst().allSatisfy({ $0.count == 3 })
    else { return nil }
  }
  return Int(trimmed.replacingOccurrences(of: ",", with: ""))
}

func echoFormFailure(_ error: any Error, action: String) -> String {
  "未能\(action)。\(userFacingError(error))"
}
