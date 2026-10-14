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
  @State private var deletionPreview: JSONValue = .null
  @State private var probe = false
  @State private var confirmDiscard = false
  @State private var showValidation = false
  @State private var scrollTarget: String?
  @State private var providerCommand: JSONValue?
  private var dirty: Bool { fields != original || numericText != originalNumericText }
  private var actors: [Record] {
    model.items("actor").filter { $0["world_id"].string == target.world }
  }
  private var title: String {
    [
      "worlds": String(localized: "TA 的设定"), "characters": String(localized: "角色模板"),
      "actors": String(localized: "设定中的角色"), "rooms": String(localized: "房间"),
      "lore": String(localized: "设定集条目"), "providers": String(localized: "模型连接"),
      "state": String(localized: "已确认剧情"),
    ][target.resource] ?? String(localized: "内容")
  }
  var body: some View {
    NavigationStack {
      ScrollViewReader { proxy in
        Form {
          if target.resource != "state" {
            Section(String(localized: "基本信息")) {
              field("name", String(localized: "名称"), text: string("name"))
            }
          }
          editorSections
          if target.resource == "providers", let record = target.record {
            NavigationLink("测试连接与历史结果") { ProviderProbeView(model: model, provider: record) }
          }
          if let failure {
            Section {
              Label(failure, systemImage: "exclamationmark.circle")
                .font(EchoFont.callout).foregroundStyle(Color.echo.error).fixedSize(
                  horizontal: false, vertical: true)
            }.id("form-error")
          }
          conflictSection
          if target.record != nil && !["state", "providers"].contains(target.resource) {
            Section {
              Button(String(localized: "删除\(title)"), role: .destructive) {
                Task { await previewDelete() }
              }
            } footer: {
              EchoFormHint(String(localized: "删除后，这项内容会从工作区移除。请确认不再需要后再操作。"))
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
      .navigationTitle(
        (target.record == nil ? String(localized: "新建") : String(localized: "编辑")) + title
      )
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
        String(
          localized:
            "移除后保留历史内容和共享原件。涉及 \(deletionPreview["rooms"].array.count) 个房间、\(deletionPreview["assets"].array.count) 个资源、\(deletionPreview["projects"].array.count) 个项目。"
        ), isPresented: $confirmDelete,
        titleVisibility: .visible
      ) {
        Button(String(localized: "删除\(title)"), role: .destructive) { delete() }
        Button(String(localized: "保留"), role: .cancel) {}
      }
      .confirmationDialog(
        String(localized: "放弃尚未保存的修改？"), isPresented: $confirmDiscard, titleVisibility: .visible
      ) {
        Button(String(localized: "放弃修改"), role: .destructive) { dismiss() }
        Button(String(localized: "继续编辑"), role: .cancel) {}
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
      Section(String(localized: "TA 的设定")) {
        field("description", String(localized: "故事背景"), text: string("description"), lines: 3...8)
      }
      Section {
        field("persona.name", String(localized: "玩家名字"), text: nestedString("persona", "name"))
        field(
          "persona.description", String(localized: "玩家描述"),
          text: nestedString("persona", "description"), lines: 2...6)
      } header: {
        Text(String(localized: "你在这套设定中的身份"))
      } footer: {
        EchoFormHint(String(localized: "这里填写虚构身份，角色会通过这个身份认识你。"))
      }
    }
  }
  private var characterSections: some View {
    Group {
      Section(String(localized: "角色设定")) {
        ForEach(
          [
            ("description", String(localized: "角色描述")), ("personality", String(localized: "性格")),
            ("voice", String(localized: "说话风格")),
            ("scenario", String(localized: "初始背景")), ("example", String(localized: "对话示例")),
            ("greeting", String(localized: "开场白")),
          ], id: \.0
        ) { key, title in
          field(key, title, text: string(key), lines: 2...6)
        }
      }
      if fields["prompt_suggestions"] != nil {
        Section(String(localized: "角色提示建议")) {
          Toggle(
            String(localized: "启用提示建议"),
            isOn: Binding(
              get: { fields["prompt_suggestions"]?["enabled"].bool ?? false },
              set: { value in
                var obj = fields["prompt_suggestions"]?.object ?? [:]
                obj["enabled"] = .bool(value)
                fields["prompt_suggestions"] = .object(obj)
              }))
          Group {
            field(
              "prompt_suggestions.system_prompt", String(localized: "角色补充提示"),
              text: nestedString("prompt_suggestions", "system_prompt"), lines: 2...6)
            field(
              "prompt_suggestions.post_history_instructions", String(localized: "回复补充提示"),
              text: nestedString("prompt_suggestions", "post_history_instructions"), lines: 2...6)
          }.disabled(fields["prompt_suggestions"]?["enabled"].bool != true)
        }
      }
    }
  }
  private var actorSections: some View {
    Section {
      EchoFormField(String(localized: "角色模板"), error: issue("template_id")) {
        Picker(
          String(localized: "角色模板"),
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
          Text(String(localized: "选择模板")).tag("")
          ForEach(model.items("character")) { Text($0.name).tag($0.id) }
        }.labelsHidden()
      }.id("template_id")
      Stepper(
        String(localized: "模板版本：\(fields["template_revision"]?.int ?? 1)"),
        value: number("template_revision"),
        in:
          1...max(
            1,
            model.items("character").first { $0.id == fields["template_id"]?.string }?["revision"]
              .int ?? 1)
      )
      .disabled(fields["template_id"]?.string.isEmpty != false)
      EchoFormField(String(localized: "参与度")) {
        HStack {
          Slider(
            value: Binding(
              get: { Double(fields["participation"]?.int ?? 50) },
              set: { fields["participation"] = .number($0) }), in: 0...100, step: 10
          )
          .accessibilityLabel(String(localized: "参与度"))
          Text("\(fields["participation"]?.int ?? 50)%").monospacedDigit().frame(minWidth: 44)
        }
      }
    } header: {
      Text(String(localized: "这套设定中的角色"))
    } footer: {
      EchoFormHint(String(localized: "每套设定中的角色独立保留经历。模板更新后，你可以在这里选择采用的版本；参与度影响未点名时的发言机会。"))
    }
  }
  private var roomSections: some View {
    Group {
      Section(String(localized: "对话设置")) {
        EchoFormField(String(localized: "房间类型")) {
          Picker(String(localized: "房间类型"), selection: string("kind")) {
            Text(String(localized: "私聊")).tag("direct")
            Text(String(localized: "群聊")).tag("group")
          }.pickerStyle(.segmented).labelsHidden()
        }
        EchoFormField(String(localized: "模型连接"), error: issue("provider_id")) {
          Picker(String(localized: "模型连接"), selection: string("provider_id")) {
            Text(String(localized: "选择模型")).tag("")
            ForEach(model.providers) { Text($0.name).tag($0.id) }
          }.labelsHidden()
        }.id("provider_id")
        Stepper(
          String(localized: "每轮最多 \(fields["max_replies"]?.int ?? 3) 条回复"),
          value: number("max_replies"), in: 1...3)
      }
      Section {
        actorToggles("actor_ids")
        validationHint("actor_ids")
      } header: {
        Text(
          fields["kind"]?.string == "direct"
            ? String(localized: "参与角色 · 选择 1 位") : String(localized: "参与角色 · 最多 8 位"))
      } footer: {
        EchoFormHint(String(localized: "新成员无法读取加入前的消息或先前已接收的输入。"))
      }
      .id("actor_ids")
    }
  }
  private var loreSections: some View {
    Group {
      Section(String(localized: "设定内容")) {
        field("content", String(localized: "设定内容"), text: string("content"), lines: 3...10)
        Toggle(String(localized: "启用条目"), isOn: boolean("enabled"))
      }
      Section {
        Toggle(String(localized: "始终提供这条设定"), isOn: boolean("constant"))
        Toggle("不占设定专用预算（仍受总预算限制）", isOn: boolean("budget_exempt"))
        Group {
          field("keys", String(localized: "触发词 · 每行一个"), text: list("keys"), lines: 2...6)
          EchoFormField(String(localized: "匹配方式")) {
            Picker(String(localized: "匹配方式"), selection: string("match_mode")) {
              Text(String(localized: "关键词")).tag("keywords")
              Text(String(localized: "安全正则")).tag("regex")
            }.pickerStyle(.segmented).labelsHidden()
          }
          Toggle(String(localized: "区分大小写"), isOn: boolean("case_sensitive"))
        }.disabled(fields["constant"]?.bool == true)
        Stepper(
          String(localized: "持续 \(fields["sticky_turns"]?.int ?? 0) 轮"),
          value: number("sticky_turns"), in: 0...100)
        Stepper(
          String(localized: "冷却 \(fields["cooldown_turns"]?.int ?? 0) 轮"),
          value: number("cooldown_turns"), in: 0...100
        )
        Stepper(
          String(localized: "延迟 \(fields["delay_turns"]?.int ?? 0) 轮"),
          value: number("delay_turns"), in: 0...100)
      } header: {
        Text(String(localized: "何时想起这条设定"))
      } footer: {
        EchoFormHint(
          String(localized: "按当前角色成功回复计数。预览和失败重试不计数；延迟要求连续命中，冷却从持续期结束后开始。正则使用 RE2 兼容规则。"))
      }
      .disabled(fields["enabled"]?.bool != true)
      Section(String(localized: "提供给角色的位置")) {
        Stepper(
          String(localized: "扫描最近 \(fields["scan_depth"]?.int ?? 8) 条可见消息"),
          value: number("scan_depth"), in: 1...50)
        Stepper(
          String(localized: "优先级：\(fields["priority"]?.int ?? 0)"), value: number("priority"),
          in: -1000...1000)
        Picker(String(localized: "插入位置"), selection: string("insertion_slot")) {
          Text(String(localized: "角色设定前")).tag("before_character")
          Text(String(localized: "角色设定后")).tag("after_character")
          Text(String(localized: "历史前")).tag("before_history")
          Text(String(localized: "历史中")).tag("history_depth")
        }
        Stepper(
          String(localized: "距历史结尾 \(fields["injection_depth"]?.int ?? 0) 条"),
          value: number("injection_depth"),
          in: 0...50
        )
        .disabled(fields["insertion_slot"]?.string != "history_depth")
      }.disabled(fields["enabled"]?.bool != true)
      Section(String(localized: "可知角色 · 不选表示当前设定内公开")) {
        actorToggles("audience_actor_ids")
        validationHint("audience_actor_ids")
      }.id("audience_actor_ids")
    }
  }
  private var stateSections: some View {
    Group {
      Section(String(localized: "当前剧情")) {
        field("data.location", String(localized: "当前地点"), text: nestedString("data", "location"))
        field("data.time", String(localized: "剧情时间"), text: nestedString("data", "time"))
        field(
          "data.open_topics", String(localized: "未完成话题 · 每行一个"),
          text: nestedList("data", "open_topics"), lines: 2...6)
      }
      Section(String(localized: "在场角色")) {
        ForEach(actors) { actor in
          Toggle(actor.name, isOn: nestedContains("data", "present_actor_ids", actor.id))
        }
        validationHint("data.present_actor_ids")
      }.id("data.present_actor_ids")
      Section {
        actorToggles("audience_actor_ids")
        validationHint("audience_actor_ids")
      } header: {
        Text(String(localized: "可知角色 · 不选表示当前设定内公开"))
      } footer: {
        EchoFormHint(String(localized: "这里保存由你确认的剧情事实。角色在聊天中的主观说法会保留为角色声称。"))
      }
      .id("audience_actor_ids")
    }
  }
  private var providerSections: some View {
    Group {
      Section(String(localized: "连接信息")) {
        Picker("服务协议", selection: string("protocol")) {
          Text("OpenAI 兼容").tag("openai");Text("Claude Messages").tag("claude");Text("Gemini").tag("gemini");Text("Vertex Gemini").tag("vertex")
        }
        Text("Vertex 使用访问令牌，模型填写 projects/项目/locations/区域/publishers/google/models/模型。连接测试可能产生费用，仅在明确点击时运行。").font(EchoFont.caption)
        field("base_url", String(localized: "模型 API 地址"), text: string("base_url"))
          .autocorrectionDisabled()
          #if os(iOS)
            .textInputAutocapitalization(.never)
            .keyboardType(.URL)
          #endif
        field("model", String(localized: "模型 ID"), text: string("model")).autocorrectionDisabled()
          #if os(iOS)
            .textInputAutocapitalization(.never)
          #endif
        EchoFormField("API Key", error: issue("api_key")) {
          SecureField(String(localized: "填写 API Key"), text: string("api_key")).textFieldStyle(
            .roundedBorder
          )
          .accessibilityLabel("API Key")
        }.id("api_key")
        if target.record != nil {
          EchoFormHint(String(localized: "API Key 留空保留原凭据。修改连接会让仍使用旧配置的轮次停止，避免把新凭据发往旧地址。"))
        }
        Toggle(String(localized: "模型支持工具调用"), isOn: boolean("tools_enabled"))
        Toggle("连接支持图片理解", isOn: boolean("vision_enabled"))
      }
      Section {
        providerNumber("context_window", String(localized: "上下文上限"))
        providerNumber("max_output_tokens", String(localized: "单次输出上限"))
      } header: {
        Text(String(localized: "文本额度"))
      } footer: {
        EchoFormHint(String(localized: "Key 会加密保存到你的服务器，以便客户端关闭时继续运行。单次输出必须小于上下文上限。"))
      }
    }
  }
  @ViewBuilder private var conflictSection: some View {
    if let conflict {
      Section(String(localized: "服务器当前版本：\(conflict["revision"].int)")) {
        Text(summary(conflict.value)).textSelection(.enabled)
        EchoFormHint(String(localized: "上方仍保留你的编辑，请比较后再决定。"))
        Button(String(localized: "采用服务器版本")) {
          fields = editable(conflict)
          original = fields
          resetNumericInputs()
          revision = conflict["revision"].int
          providerCommand = nil
          self.conflict = nil
          failure = nil
        }
        Button(String(localized: "保留我的编辑，准备重新保存")) {
          original = editable(conflict)
          revision = conflict["revision"].int
          providerCommand = nil
          self.conflict = nil
          failure = nil
        }
      }
    }
  }
  private var cancelButton: some View {
    Button(String(localized: "取消")) { if dirty { confirmDiscard = true } else { dismiss() } }
      .disabled(busy).keyboardShortcut(.cancelAction)
  }
  private var saveButton: some View {
    Button(busy ? String(localized: "保存中…") : String(localized: "保存")) {
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
      if dirty {
        Text(String(localized: "有未保存的修改")).font(EchoFont.caption).foregroundStyle(
          Color.echo.textSecondary)
      }
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
      Label(message, systemImage: "exclamationmark.circle").font(EchoFont.caption)
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
        result.append((key, String(localized: "请填写\(title)。")))
      } else if text.unicodeScalars.count > max {
        result.append((key, String(localized: "\(title)最多 \(max.formatted()) 个字符。")))
      }
    }
    if target.resource != "state" {
      checkText(
        "name", fields["name"]?.string ?? "", String(localized: "名称"), max: 80, required: true)
    }
    switch target.resource {
    case "worlds":
      checkText("description", fields["description"]?.string ?? "", String(localized: "故事背景"))
      checkText(
        "persona.name", fields["persona"]?["name"].string ?? "", String(localized: "玩家名字"), max: 80,
        required: true)
      checkText(
        "persona.description", fields["persona"]?["description"].string ?? "",
        String(localized: "玩家描述"))
    case "characters":
      for key in ["description", "personality", "voice", "scenario", "example", "greeting"] {
        checkText(key, fields[key]?.string ?? "", String(localized: "这项内容"))
      }
      for key in ["system_prompt", "post_history_instructions"] {
        checkText(
          "prompt_suggestions." + key, fields["prompt_suggestions"]?[key].string ?? "",
          String(localized: "补充提示"))
      }
    case "actors":
      if !model.items("character").contains(where: { $0.id == fields["template_id"]?.string }) {
        result.append(("template_id", String(localized: "请选择角色模板。")))
      }
    case "rooms":
      if !model.providers.contains(where: { $0.id == fields["provider_id"]?.string }) {
        result.append(("provider_id", String(localized: "请选择模型连接。")))
      }
      let count = fields["actor_ids"]?.array.count ?? 0
      if fields["kind"]?.string == "direct" && count != 1 {
        result.append(("actor_ids", String(localized: "私聊需要选择 1 位角色。")))
      } else if !(1...8).contains(count) {
        result.append(("actor_ids", String(localized: "群聊需要选择 1–8 位角色。")))
      }
    case "lore":
      checkText("content", fields["content"]?.string ?? "", String(localized: "设定内容"))
      let keys = fields["keys"]?.array ?? []
      if keys.count > 32 || keys.contains(where: { $0.string.unicodeScalars.count > 120 }) {
        result.append(("keys", String(localized: "最多填写 32 个触发词，每个不超过 120 个字符。")))
      }
    case "state":
      for key in ["location", "time"] {
        checkText(
          "data." + key, fields["data"]?[key].string ?? "", String(localized: "这项内容"), max: 500)
      }
      let topics = fields["data"]?["open_topics"].array ?? []
      if topics.count > 20 || topics.contains(where: { $0.string.unicodeScalars.count > 500 }) {
        result.append(("data.open_topics", String(localized: "最多填写 20 个话题，每个不超过 500 个字符。")))
      }
      if (fields["data"]?["present_actor_ids"].array.count ?? 0) > 8 {
        result.append(("data.present_actor_ids", String(localized: "最多选择 8 位在场角色。")))
      }
    case "providers":
      let address = fields["base_url"]?.string ?? ""
      if let url = URLComponents(string: address),
        ["https", "http"].contains(url.scheme?.lowercased() ?? ""), url.host?.isEmpty == false,
        address.unicodeScalars.count <= 2048
      {
      } else {
        result.append(("base_url", String(localized: "请填写完整的 http:// 或 https:// 模型 API 地址。")))
      }
      checkText(
        "model", fields["model"]?.string ?? "", String(localized: "模型 ID"), max: 200, required: true
      )
      checkText(
        "api_key", fields["api_key"]?.string ?? "", "API Key", max: 4096,
        required: target.record == nil)
      for (key, title, range) in [
        ("context_window", String(localized: "上下文上限"), 2048...1_000_000),
        ("max_output_tokens", String(localized: "单次输出上限"), 1...8192),
      ] {
        if let value = echoInteger(numericText[key] ?? ""), range.contains(value) {
        } else {
          result.append(
            (
              key,
              String(
                localized:
                  "\(title)需为 \(range.lowerBound.formatted())–\(range.upperBound.formatted()) tokens 的整数。"
              )
            ))
        }
      }
      if let output = echoInteger(numericText["max_output_tokens"] ?? ""),
        let context = echoInteger(numericText["context_window"] ?? ""), output >= context
      {
        result.append(("max_output_tokens", String(localized: "单次输出上限必须小于上下文上限。")))
      }
    default: break
    }
    if (fields["audience_actor_ids"]?.array.count ?? 0) > 8 {
      result.append(("audience_actor_ids", String(localized: "最多选择 8 位可知角色。")))
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
        var payload = fields
        if target.resource != "state" {
          if target.resource == "providers" && target.record != nil
            && (payload["api_key"]?.string ?? "").isEmpty
          {
            payload.removeValue(forKey: "api_key")
          }
          var prior = providerCommand?.object ?? [:]
          prior.removeValue(forKey: "operation_id")
          if prior != payload || providerCommand == nil {
            payload["operation_id"] = .string(UUID().uuidString)
            providerCommand = .object(payload)
          }
          payload = providerCommand!.object
        }
        try await model.save(
          resource: target.resource,
          id: target.resource == "state" ? target.world : target.record?.id,
          revision: revision, body: .object(payload))
        fields["api_key"] = nil
        dismiss()
      } catch {
        failure = userFacingError(error)
        if APIConnection.apiError(error)?.status == 409 {
          conflict =
            (target.resource == "providers"
            ? model.providers
            : model.items(
              [
                "worlds": "world", "characters": "character", "actors": "actor", "rooms": "room",
                "lore": "lore", "state": "state",
              ][target.resource] ?? ""
            ))
            .first { $0.id == (target.record?.id ?? target.world) }
        }
        scrollTarget = "form-error"
      }
    }
  }
  private func previewDelete() async {
    guard let record = target.record else { return }
    busy = true
    defer { busy = false }
    do {
      deletionPreview = try await milestoneCall(
        model, "deletionPreview", ["id": .string(record.id), "resource": .string(target.resource)])
      if deletionPreview["can_delete"].bool {
        confirmDelete = true
      } else {
        failure = "仍有活动任务、角色实例或房间成员关系。请先处理这些关联，再刷新删除预览。"
      }
    } catch { failure = userFacingError(error) }
  }
  private func delete() {
    guard !busy, let record = target.record else { return }
    busy = true
    Task {
      defer { busy = false }
      do {
        _ = try await milestoneCall(
          model, "deleteEntity",
          [
            "id": .string(record.id), "resource": .string(target.resource),
            "expected_revision": deletionPreview["revision"],
            "context_token": deletionPreview["preview_token"],
          ], command: true)
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
    if target.resource == "providers" {
      object["tools_enabled"] = record["capabilities"]["tools"]
      object["protocol"] = record["protocol"] == .null ? .string("openai") : record["protocol"]
      object["vision_enabled"] = .bool(record["capabilities"]["vision"].bool)
      object.removeValue(forKey: "credential_present")
      object.removeValue(forKey: "capabilities")
    }
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
        "persona": .object(["name": .string(String(localized: "玩家")), "description": .string("")]),
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
        "protocol":.string("openai"), "name": .string(""), "base_url": .string("https://"), "model": .string(""),
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
          "name": String(localized: "名称"), "description": String(localized: "描述"),
          "persona": String(localized: "玩家身份"), "content": String(localized: "内容"),
          "personality": String(localized: "性格"), "voice": String(localized: "语气"),
          "scenario": String(localized: "背景"), "example": String(localized: "示例"),
          "greeting": String(localized: "开场白"),
          "data": String(localized: "剧情状态"), "location": String(localized: "地点"),
          "time": String(localized: "时间"), "actor_ids": String(localized: "房间成员"),
          "audience_actor_ids": String(localized: "可知角色"),
          "present_actor_ids": String(localized: "在场角色"), "open_topics": String(localized: "未完成话题"),
          "max_replies": String(localized: "回复上限"), "participation": String(localized: "参与度"),
          "template_revision": String(localized: "模板版本"),
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
          Text(title).font(EchoFont.body).frame(width: 180, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
          content().labelsHidden().frame(maxWidth: .infinity, alignment: .leading)
        }
      #else
        VStack(alignment: .leading, spacing: EchoSpacing.xs) {
          Text(title).font(EchoFont.callout).foregroundStyle(Color.echo.textSecondary)
          content().labelsHidden().frame(maxWidth: .infinity, alignment: .leading)
        }
      #endif
      if let error {
        Label(error, systemImage: "exclamationmark.circle")
          .font(EchoFont.caption).foregroundStyle(Color.echo.error)
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
    Text(text).font(EchoFont.footnote).foregroundStyle(Color.echo.textSecondary)
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
  String(localized: "未能\(action)。\(userFacingError(error))")
}

/// Edits the world actor's route, shared by all of that actor's conversations.
struct ChatModelRouteView: View {
  var model: AppModel
  let members: [Record]
  var capability = "chat"
  @Environment(\.dismiss) private var dismiss
  @State private var routes: [JSONValue] = []
  @State private var subject = ""
  @State private var mode = "inherit"
  @State private var provider = ""
  @State private var namespace: String?
  @State private var failure: String?
  @State private var busy = false
  @State private var loaded = false
  @State private var pendingBody: JSONValue?
  private var owner: String { model.connection?.credentials.owner_id ?? "" }
  private var current: JSONValue? {
    routes.first { $0["subject_id"].string == subject && $0["capability"].string == capability }
  }
  var body: some View {
    NavigationStack {
      Form {
        Section(String(localized: "作用范围")) {
          Picker(String(localized: "修改对象"), selection: $subject) {
            Text(String(localized: "全局默认")).tag(owner)
            ForEach(members) { Text($0.name).tag($0.id) }
          }
          Text(String(localized: "角色设置影响该角色在当前设定中的所有对话；其他设定中的同名角色不受影响。正在进行的回应保留原配置。"))
            .font(EchoFont.caption).foregroundStyle(.secondary)
        }
        Section(String(localized: "模型线路")) {
          Picker(String(localized: "使用方式"), selection: $mode) {
            Text(String(localized: "继承默认")).tag("inherit")
            Text(String(localized: "指定模型")).tag("override")
            Text(String(localized: "关闭对话生成")).tag("disabled")
          }
          if mode == "override" {
            Picker(String(localized: "模型连接"), selection: $provider) {
              Text(String(localized: "请选择")).tag("")
              ForEach(model.providers) { Text($0.name).tag($0.id) }
            }
          }
          Text(String(localized: "保存不会调用模型。关闭后不会回退到其他模型；尚未设置全局默认时，继承会沿用房间原有连接。"))
            .font(EchoFont.caption).foregroundStyle(.secondary)
        }
        if let failure {
          Section {
            Text(failure).foregroundStyle(Color.echo.error)
            Button(String(localized: "刷新版本并保留当前选择")) { Task { await load(preserveDraft: true) } }
          }
        }
      }
      .formStyle(.grouped).scrollContentBackground(.hidden).background(Color.echo.surfaceSunken)
      .navigationTitle(String(localized: "对话模型"))
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button(String(localized: "取消")) { dismiss() }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button(String(localized: "保存")) { Task { await save() } }
            .disabled(busy || !loaded || (mode == "override" && provider.isEmpty))
        }
      }
      .disabled(busy)
      .onChange(of: subject) { _, _ in selectCurrent() }
      .task {
        namespace = model.connection?.namespace
        subject = members.first?.id ?? owner
        await load(preserveDraft: false)
      }
    }.frame(minWidth: 320, idealWidth: 520, minHeight: 400)
  }
  private func selectCurrent() {
    mode = current?["state"].string ?? "inherit"
    provider = current?["provider_id"].string ?? ""
    pendingBody = nil
  }
  private func load(preserveDraft: Bool) async {
    busy = true
    defer { busy = false }
    do {
      guard namespace == model.connection?.namespace else {
        throw APIError(status: 409, code: "connection_changed")
      }
      try await model.refreshSettings()
      let value = try await model.operations(action: "modelRoutes")
      routes = value["items"].array
      loaded = true
      if !preserveDraft { selectCurrent() }
      failure = nil
    } catch { failure = userFacingError(error) }
  }
  private func save() async {
    busy = true
    defer { busy = false }
    do {
      guard namespace == model.connection?.namespace else {
        throw APIError(status: 409, code: "connection_changed")
      }
      var route: [String: JSONValue] = ["state": .string(mode)]
      if mode == "override" { route["provider_id"] = .string(provider) }
      var payload: [String: JSONValue] = [
        "subject_id": .string(subject),
        "subject_kind": .string(subject == owner ? "owner" : "actor"),
        "capability": .string(capability),
        "expected_revision": .number(Double(current?["revision"].int ?? 0)),
        "route": .object(route),
      ]
      var prior = pendingBody?.object ?? [:]
      prior.removeValue(forKey: "operation_id")
      if prior != payload || pendingBody == nil {
        payload["operation_id"] = .string(UUID().uuidString)
        pendingBody = .object(payload)
      }
      _ = try await model.operations(action: "saveModelRoute", body: pendingBody!)
      dismiss()
    } catch { failure = userFacingError(error) }
  }
}

struct MessageVersionEditor: View {
  @State private var deleteOldVersion = false
  var model: AppModel
  let message: Record
  @Environment(\.dismiss) private var dismiss
  @State private var preview: JSONValue = .null
  @State private var content = ""
  @State private var version = ""
  @State private var mode = "keep"
  @State private var namespace: String?
  @State private var failure: String?
  @State private var busy = false
  @State private var pending: JSONValue?
  @State private var confirm = false
  @State private var branchName = ""
  @State private var branchBody: JSONValue?
  var body: some View {
    NavigationStack {
      Form {
        Section(String(localized: "消息内容")) {
          Picker(String(localized: "内容来源"), selection: $version) {
            Text(String(localized: "编辑当前内容")).tag("")
            ForEach(Array(preview["items"].array.enumerated()), id: \.offset) { index, item in
              Text(String(localized: "历史版本 \(index + 1)")).tag(item["id"].string)
            }
          }
          if version.isEmpty {
            TextEditor(text: $content).frame(minHeight: 140)
              .accessibilityLabel(String(localized: "消息正文"))
          } else {
            Text(
              preview["items"].array.first { $0["id"].string == version }?["content"].string ?? ""
            )
            .textSelection(.enabled)
          }
        }
        if message["role"].string == "assistant" {
          Button("按下方处理方式重新生成此回复") { Task { await regenerate() } }
        }
        if !version.isEmpty && version != preview["message"]["selected_version_id"].string {
          Button("永久删除所选旧版本", role: .destructive) { deleteOldVersion = true }
        }
        Section(String(localized: "后续历史")) {
          Picker(String(localized: "处理方式"), selection: $mode) {
            Text(String(localized: "保留并标明旧上下文")).tag("keep")
            Text(String(localized: "截断后续消息")).tag("truncate")
          }
          Text(
            String(
              localized: "将影响后续 \(preview["later_messages"].int) 条消息。已发生的外部操作不会撤销，也不会重新执行；相关记忆将失效。")
          )
          .font(EchoFont.caption).foregroundStyle(.secondary)
        }
        if let failure { Text(failure).foregroundStyle(Color.echo.error) }
        Button(String(localized: "刷新影响范围并保留草稿")) { Task { await load() } }
        Section(String(localized: "独立分支")) {
          TextField(String(localized: "新对话名称"), text: $branchName)
          Text(String(localized: "复制到此处完整回合的已选消息；当前编辑草稿不会保存到分支。原对话保持原样，外部动作不会重放。原文的隐私删除仍会清除派生副本。"))
            .font(EchoFont.caption).foregroundStyle(.secondary)
          Button(String(localized: "创建独立分支")) { Task { await branch() } }
            .disabled(
              preview == .null || branchName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            )
        }
      }
      .formStyle(.grouped).scrollContentBackground(.hidden).background(Color.echo.surfaceSunken)
      .navigationTitle(String(localized: "编辑与历史版本"))
      .confirmationDialog("永久删除所选旧版本？当前选中正文不受影响。", isPresented: $deleteOldVersion) {
        Button("删除旧版本", role: .destructive) { Task { await removeVersion() } }
        Button("取消", role: .cancel) {}
      }
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button(String(localized: "取消")) { dismiss() }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button(String(localized: "保存")) { confirm = true }
            .disabled(
              busy || preview == .null
                || (version.isEmpty
                  && (content.isEmpty || ChatPresentation.length(content) > 16000))
            )
        }
      }
      .disabled(busy)
      .confirmationDialog(
        String(localized: "确认修改消息及所选后续历史？"), isPresented: $confirm, titleVisibility: .visible
      ) {
        Button(String(localized: "确认保存"), role: mode == "truncate" ? .destructive : nil) {
          Task { await save() }
        }
        Button(String(localized: "取消"), role: .cancel) {}
      }
      .task {
        namespace = model.connection?.namespace
        content = message["content"].string
        await load()
      }
    }.frame(minWidth: 320, idealWidth: 600, minHeight: 480)
  }
  private func load() async {
    busy = true
    defer { busy = false }
    do {
      guard namespace == model.connection?.namespace else {
        throw APIError(status: 409, code: "connection_changed")
      }
      preview = try await model.operations(action: "messageVersions", id: message.id)
      pending = nil
      failure = nil
    } catch { failure = userFacingError(error) }
  }
  private func save() async {
    busy = true
    defer { busy = false }
    do {
      guard namespace == model.connection?.namespace else {
        throw APIError(status: 409, code: "connection_changed")
      }
      var payload: [String: JSONValue] = [
        "expected_revision": preview["message"]["revision"],
        "context_token": preview["context_token"],
        "mode": .string(mode),
      ]
      payload[version.isEmpty ? "content" : "version_id"] = .string(
        version.isEmpty ? content : version)
      var previous = pending?.object ?? [:]
      previous.removeValue(forKey: "operation_id")
      if previous != payload || pending == nil {
        payload["operation_id"] = .string(UUID().uuidString)
        pending = .object(payload)
      }
      _ = try await model.operations(action: "editMessage", id: message.id, body: pending!)
      dismiss()
    } catch { failure = userFacingError(error) }
  }
  private func regenerate() async {
    busy = true
    defer { busy = false }
    do {
      guard namespace == model.connection?.namespace else {
        throw APIError(status: 409, code: "connection_changed")
      }
      _ = try await milestoneCall(
        model, "regenerateMessage",
        [
          "id": .string(message.id), "expected_revision": preview["message"]["revision"],
          "context_token": preview["context_token"], "mode": .string(mode),
        ], command: true)
      dismiss()
    } catch { failure = userFacingError(error) }
  }
  private func removeVersion() async {
    busy = true
    defer { busy = false }
    do {
      guard namespace == model.connection?.namespace else {
        throw APIError(status: 409, code: "connection_changed")
      }
      _ = try await milestoneCall(
        model, "deleteVersion",
        [
          "id": .string(message.id), "expected_revision": preview["message"]["revision"],
          "version_id": .string(version),
        ], command: true)
      version = ""
      await load()
    } catch { failure = userFacingError(error) }
  }
  private func branch() async {
    busy = true
    defer { busy = false }
    do {
      guard namespace == model.connection?.namespace else {
        throw APIError(status: 409, code: "connection_changed")
      }
      var payload: [String: JSONValue] = [
        "expected_revision": preview["message"]["revision"],
        "context_token": preview["context_token"], "name": .string(branchName),
      ]
      var old = branchBody?.object ?? [:]
      old.removeValue(forKey: "operation_id")
      if old != payload || branchBody == nil {
        payload["operation_id"] = .string(UUID().uuidString)
        branchBody = .object(payload)
      }
      _ = try await model.operations(
        action: "branchConversation", id: message.id, body: branchBody!)
      dismiss()
    } catch { failure = userFacingError(error) }
  }
}

struct ConversationQueueView: View {
  var model: AppModel
  let room: Record
  @Environment(\.dismiss) private var dismiss
  @State private var items: [JSONValue] = []
  @State private var content = ""
  @State private var editing: JSONValue = .null
  @State private var operation = UUID().uuidString
  @State private var namespace: String?
  @State private var busy = false
  @State private var failure: String?
  private var draftKey: String { room.id + "/manual" }
  var body: some View {
    NavigationStack {
      Form {
        Section(String(localized: "待回复内容")) {
          Text(String(localized: "暂存不会立即回复。点击一起回复时，只使用当前列表中这些版本；之后新增的内容留给下一轮。"))
            .font(EchoFont.caption).foregroundStyle(.secondary)
          ForEach(items, id: \.self) { item in
            VStack(alignment: .leading) {
              Text(item["content"].string).textSelection(.enabled)
              HStack {
                Button(String(localized: "编辑")) {
                  editing = item
                  content = item["content"].string
                  operation = UUID().uuidString
                  persist()
                }
                Button(String(localized: "删除"), role: .destructive) {
                  Task { await remove(item) }
                }
              }.buttonStyle(.borderless)
            }
          }
          Button(String(localized: "一起回复（\(items.count) 条）")) { Task { await start() } }
            .disabled(items.isEmpty)
        }
        Section(editing == .null ? String(localized: "新增内容") : String(localized: "修改暂存内容")) {
          TextEditor(
            text: Binding(
              get: { content },
              set: {
                content = $0
                operation = UUID().uuidString
                persist()
              })
          ).frame(minHeight: 120)
          Button(editing == .null ? String(localized: "加入待回复") : String(localized: "保存修改")) {
            Task { await save() }
          }.disabled(!ChatPresentation.canSend(content))
          if editing != .null {
            Button(String(localized: "保留文字并作为新条目")) {
              editing = .null
              operation = UUID().uuidString
              persist()
            }
          }
        }
        if let failure { Text(failure).foregroundStyle(Color.echo.error) }
        Button(String(localized: "刷新列表并保留草稿")) { Task { await reload() } }
      }
      .formStyle(.grouped).scrollContentBackground(.hidden).background(Color.echo.surfaceSunken)
      .navigationTitle(String(localized: "暂存并一起回复"))
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button(String(localized: "完成")) { dismiss() }
        }
      }
      .disabled(busy)
      .task {
        namespace = model.connection?.namespace
        if let data = model.draft(room: draftKey).data(using: .utf8),
          let saved = try? JSONDecoder().decode(JSONValue.self, from: data)
        {
          content = saved["content"].string
          editing = saved["editing"]
          if !saved["operation"].string.isEmpty { operation = saved["operation"].string }
        }
        await reload()
      }
    }.frame(minWidth: 320, idealWidth: 600, minHeight: 480)
  }
  private func checkConnection() throws {
    guard namespace == model.connection?.namespace else {
      throw APIError(status: 409, code: "connection_changed")
    }
  }
  private func persist() {
    guard namespace == model.connection?.namespace else { return }
    let value: JSONValue = .object([
      "content": .string(content), "editing": editing, "operation": .string(operation),
    ])
    if let data = try? JSONEncoder().encode(value), let text = String(data: data, encoding: .utf8) {
      model.saveDraft(room: draftKey, content: text)
    }
  }
  private func fetch() async throws {
    items = try await model.operations(action: "queuedInputs", id: room.id)["items"].array
  }
  private func reload() async {
    busy = true
    defer { busy = false }
    do {
      try checkConnection()
      try await fetch()
      failure = nil
    } catch { failure = userFacingError(error) }
  }
  private func save() async {
    busy = true
    defer { busy = false }
    do {
      try checkConnection()
      var body: [String: JSONValue] = [
        "operation_id": .string(operation), "content": .string(content),
      ]
      if editing != .null { body["expected_revision"] = editing["revision"] }
      _ = try await model.operations(
        action: editing == .null ? "queueInput" : "updateQueuedInput",
        id: editing == .null ? room.id : editing["id"].string, body: .object(body))
      content = ""
      editing = .null
      operation = UUID().uuidString
      persist()
      try await fetch()
      failure = nil
    } catch { failure = userFacingError(error) }
  }
  private func remove(_ item: JSONValue) async {
    busy = true
    defer { busy = false }
    do {
      try checkConnection()
      _ = try await model.operations(
        action: "updateQueuedInput", id: item["id"].string,
        body: .object([
          "operation_id": .string(UUID().uuidString), "expected_revision": item["revision"],
          "remove": .bool(true),
        ]))
      try await fetch()
      failure = nil
    } catch { failure = userFacingError(error) }
  }
  private func start() async {
    busy = true
    defer { busy = false }
    do {
      try checkConnection()
      let frozen = items.map { JSONValue.object(["id": $0["id"], "revision": $0["revision"]]) }
      _ = try await model.operations(
        action: "startQueuedTurn", id: room.id,
        body: .object(["operation_id": .string(UUID().uuidString), "items": .array(frozen)]))
      try await fetch()
      failure = nil
    } catch { failure = userFacingError(error) }
  }
}
