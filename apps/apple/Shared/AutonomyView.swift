import CompanionCore
import SwiftUI

struct AutonomyView: View {
  var model: AppModel
  let world: String?
  @Environment(\.dismiss) private var dismiss
  @State private var fields: [String: JSONValue] = [:]
  @State private var original: [String: JSONValue] = [:]
  @State private var numericText: [String: String] = [:]
  @State private var originalNumericText: [String: String] = [:]
  @State private var revision = 1
  @State private var globalOn = false
  @State private var timezone = "Asia/Shanghai"
  @State private var loaded = false
  @State private var busy = false
  @State private var failure: String?
  @State private var usage: JSONValue = .null
  @State private var globalSettings = false
  @State private var confirmDiscard = false
  @State private var confirmReload = false
  @State private var repairFields: Set<String> = []
  @State private var showValidation = false
  @State private var scrollTarget: String?

  private var dirty: Bool { fields != original || numericText != originalNumericText }
  private var enabled: Bool { fields["enabled"]?.bool == true }
  private var backgroundEnabled: Bool { enabled && (world == nil || globalOn) }
  private var hasConversation: Bool {
    fields["contact"]?.bool == true || fields["interaction"]?.bool == true
  }
  private var rooms: [Record] {
    model.items("room").filter { $0["world_id"].string == world && $0["kind"].string != "legacy" }
  }
  private var numberLimits: [(String, String, String, ClosedRange<Int>)] {
    var result: [(String, String, String, ClosedRange<Int>)] = [
      ("request_limit", "每日请求次数", "次", 0...10000),
      ("input_limit", "每日输入上限", "tokens", 0...10_000_000),
      ("output_limit", "每日输出上限", "tokens", 0...1_000_000),
    ]
    if world != nil { result.append(("category_limit", "每类请求上限", "次", 0...10000)) }
    return result
  }

  var body: some View {
    NavigationStack {
      ScrollViewReader { proxy in
        Form {
          if loaded {
            executionSection
            if !backgroundEnabled && !repairFields.isEmpty {
              Section {
                EchoFormHint("暂停期间仍可修正未通过校验的字段；设置会在保存后生效。")
              }
            }
            if world != nil { conversationSections }
            toolSection
            budgetSection
            usageSection
          } else if failure == nil {
            ProgressView("正在读取设置…").frame(maxWidth: .infinity)
          }
          if let failure {
            Section {
              Label(failure, systemImage: "exclamationmark.circle")
                .font(.callout).foregroundStyle(Color.echo.error).fixedSize(
                  horizontal: false, vertical: true)
              Button(loaded ? "重新读取服务器设置" : "重新加载") {
                if dirty { confirmReload = true } else { Task { await load() } }
              }
            }.id("form-error")
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
      .navigationTitle(world == nil ? "后台活动与预算" : "主动消息与后台活动")
      #if os(iOS)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { cancelButton }
          ToolbarItem(placement: .confirmationAction) { saveButton }
        }
      #endif
      .task { if !loaded { await load() } }
      .sheet(isPresented: $globalSettings, onDismiss: { Task { await refreshGlobalStatus() } }) {
        AutonomyView(model: model, world: nil)
      }
      .confirmationDialog("放弃尚未保存的修改？", isPresented: $confirmDiscard, titleVisibility: .visible) {
        Button("放弃修改", role: .destructive) { dismiss() }
        Button("继续编辑", role: .cancel) {}
      }
      .confirmationDialog("重新读取会替换尚未保存的修改。", isPresented: $confirmReload, titleVisibility: .visible)
      {
        Button("放弃修改并重新读取", role: .destructive) { Task { await load() } }
        Button("继续编辑", role: .cancel) {}
      }
    }
    .tint(Color.echo.primary)
    .interactiveDismissDisabled(dirty || busy)
    #if os(macOS)
      .frame(minWidth: 560, idealWidth: EchoMetric.formWidth, minHeight: 520, idealHeight: 680)
    #endif
  }

  private var executionSection: some View {
    Section {
      Toggle(world == nil ? "允许后台活动" : "允许这个世界后台运行", isOn: flag("enabled"))
        .accessibilityIdentifier("autonomy-enabled")
      if world != nil {
        Label(
          globalOn ? "全局后台活动已开启" : "全局后台活动已暂停",
          systemImage: globalOn ? "checkmark.circle" : "pause.circle"
        )
        .font(.callout).foregroundStyle(Color.echo.textSecondary)
        Button("查看全局开关与预算") { globalSettings = true }
        Toggle("整理记忆与语义索引", isOn: flag("memory")).disabled(!backgroundEnabled)
      } else {
        EchoFormField("结算时区", error: issue("timezone")) {
          Picker("结算时区", selection: string("timezone")) {
            ForEach(timezones, id: \.self) { Text($0).tag($0) }
          }.labelsHidden()
        }.id("timezone")
      }
    } header: {
      Text("后台活动")
    } footer: {
      EchoFormHint(
        world == nil
          ? "各世界需要分别开启。暂停后会停止后续后台活动；已经发出的外部请求仍需查看实际结果。"
          : "记忆整理还需在「记忆与来源」中开启。全局暂停时，保留这个世界的设置。")
    }
  }

  @ViewBuilder private var conversationSections: some View {
    Section {
      Toggle("主动联系你", isOn: flag("contact"))
        .disabled(!backgroundEnabled && !repairFields.contains("room_id"))
      countStepper("每天主动联系", key: "contact_daily", unit: "次", range: 0...3)
        .disabled(!backgroundEnabled || fields["contact"]?.bool != true)
      Toggle("角色之间互动", isOn: flag("interaction"))
        .disabled(!backgroundEnabled && !repairFields.contains("room_id"))
      countStepper("每天角色互动", key: "interaction_daily", unit: "次", range: 0...4)
        .disabled(!backgroundEnabled || fields["interaction"]?.bool != true)
      EchoFormField("活动房间", error: issue("room_id")) {
        Picker("活动房间", selection: string("room_id")) {
          Text("选择房间").tag("")
          ForEach(rooms) { room in
            Text(room.name + (room["kind"].string == "group" ? " · 群聊" : " · 私聊")).tag(room.id)
          }
        }.labelsHidden()
      }.id("room_id")
        .disabled((!backgroundEnabled || !hasConversation) && !repairFields.contains("room_id"))
    } header: {
      Text("什么时候联系你")
    } footer: {
      EchoFormHint("角色之间互动需要选择群聊。你最近发消息后的 10 分钟内，主动联系和角色互动会暂缓。")
    }

    Section {
      countStepper("每次最多发言", key: "max_turns", unit: "条", range: 1...3)
        .disabled(!backgroundEnabled || !hasConversation)
      EchoFormField("最短间隔", error: issue("interval_minutes")) {
        HStack {
          TextField("120", text: numericBinding("interval_minutes"))
            .multilineTextAlignment(.trailing).monospacedDigit().textFieldStyle(.roundedBorder)
            .accessibilityLabel("最短间隔，分钟")
            #if os(iOS)
              .keyboardType(.numberPad)
            #endif
          Text("分钟").foregroundStyle(Color.echo.textSecondary)
        }
      }.id("interval_minutes")
        .disabled(
          (!backgroundEnabled || !hasConversation) && !repairFields.contains("interval_minutes"))
    } header: {
      Text("每次说多少")
    } footer: {
      EchoFormHint("间隔至少 120 分钟，最多 10,080 分钟（7 天）。角色发言与每天次数同时受后台预算约束。")
    }

    Section {
      DatePicker("开始时间", selection: clock("quiet_start"), displayedComponents: .hourAndMinute)
      DatePicker("结束时间", selection: clock("quiet_end"), displayedComponents: .hourAndMinute)
      Toggle("安静时段仍可推进角色互动", isOn: flag("quiet_interaction"))
        .disabled(fields["interaction"]?.bool != true)
    } header: {
      Text("安静时段 · 别打扰我")
    } footer: {
      EchoFormHint("按 \(timezone) 的当地时间执行，可以跨午夜。开始与结束相同表示不设安静时段。")
    }
    .disabled(!backgroundEnabled || !hasConversation)
  }

  private var toolSection: some View {
    Section {
      Toggle("允许已授权的读取工具", isOn: flag("tools_read"))
      Toggle("允许已授权的写入工具", isOn: flag("tools_write"))
    } header: {
      Text("现实工具权限")
    } footer: {
      EchoFormHint("工具权限独立于后台活动开关，也用于你主动发起的对话。仍需为具体角色授权；写入默认逐次批准。剧情中的许可不会授予现实权限。")
    }
  }

  private var budgetSection: some View {
    Section {
      ForEach(numberLimits, id: \.0) { key, title, unit, range in
        EchoFormField(title, error: issue(key)) {
          HStack {
            TextField("0", text: numericBinding(key))
              .multilineTextAlignment(.trailing).monospacedDigit().textFieldStyle(.roundedBorder)
              .accessibilityLabel(title + "，" + unit)
              #if os(iOS)
                .keyboardType(.numberPad)
              #endif
            Text(unit).foregroundStyle(Color.echo.textSecondary)
          }
        }.id(key).disabled(!backgroundEnabled && !repairFields.contains(key))
      }
    } header: {
      Text("每日后台预算")
    } footer: {
      EchoFormHint("记忆、语义查询和自主剧情共享预算；0 表示不分配额度。按结算时区重置，未知用量暂时保留预留额度。服务器上限仍有效。")
    }
  }

  @ViewBuilder private var usageSection: some View {
    if !usage["daily"].array.isEmpty || !usage["items"].array.isEmpty {
      Section("近期用量 · 含预留") {
        ForEach(Array(usage["daily"].array.prefix(7).enumerated()), id: \.offset) { _, day in
          VStack(alignment: .leading, spacing: EchoSpacing.xxs) {
            Text(String(day["day"].string.prefix(10))).font(.callout)
            Text(
              "\(day["requests"].int) 次请求 · 输入 \(day["input_tokens"].int) / 输出 \(day["output_tokens"].int) tokens"
            )
            .font(.caption).foregroundStyle(Color.echo.textSecondary)
          }.fixedSize(horizontal: false, vertical: true)
        }
        if !usage["items"].array.isEmpty {
          DisclosureGroup("查看最近活动") {
            ForEach(Array(usage["items"].array.prefix(10).enumerated()), id: \.offset) { _, item in
              VStack(alignment: .leading, spacing: EchoSpacing.xxs) {
                Text(usageTitle(item["kind"].string) + " · " + usageState(item["state"].string))
                  .font(.callout)
                if !item["error_code"].string.isEmpty {
                  Text(userFacingFailure(code: item["error_code"].string))
                    .font(.caption).foregroundStyle(Color.echo.error)
                }
              }.fixedSize(horizontal: false, vertical: true)
            }
          }
        }
      }
    }
  }
  private func usageTitle(_ kind: String) -> String {
    if kind.hasPrefix("memory") { return "记忆整理" }
    return ["contact": "主动联系", "interaction": "角色互动", "embedding": "语义索引"][kind] ?? "后台活动"
  }
  private func usageState(_ state: String) -> String {
    ["reserved": "额度已预留", "known": "用量已记录", "unknown": "用量待确认"][state] ?? "等待更新"
  }

  private var timezones: [String] {
    Array(Set(TimeZone.knownTimeZoneIdentifiers + [fields["timezone"]?.string ?? "Asia/Shanghai"]))
      .filter { !$0.isEmpty }.sorted()
  }
  private var cancelButton: some View {
    Button("取消") { if dirty { confirmDiscard = true } else { dismiss() } }.disabled(busy)
      .keyboardShortcut(.cancelAction)
  }
  private var saveButton: some View {
    Button(busy ? "保存中…" : "保存") {
      showValidation = true
      scrollTarget = nil
      if let first = validation.first {
        repairFields.formUnion(validation.map(\.0))
        Task { @MainActor in scrollTarget = first.0 }
      } else {
        Task { await save() }
      }
    }.disabled(!loaded || busy || !dirty).accessibilityIdentifier("save-autonomy")
      .keyboardShortcut(.defaultAction)
  }
  private var actions: some View {
    HStack(spacing: EchoSpacing.sm) {
      if dirty { Text("有未保存的修改").font(.caption).foregroundStyle(Color.echo.textSecondary) }
      Spacer()
      cancelButton.buttonStyle(.bordered)
      saveButton.buttonStyle(.borderedProminent)
    }.padding(EchoSpacing.md).background(.bar).overlay(alignment: .top) { Divider() }
  }
  private func countStepper(_ title: String, key: String, unit: String, range: ClosedRange<Int>)
    -> some View
  {
    Stepper(value: integer(key), in: range) {
      HStack {
        Text(title)
        Spacer()
        Text("\(fields[key]?.int ?? range.lowerBound) \(unit)").monospacedDigit()
          .foregroundStyle(Color.echo.textSecondary)
      }
    }
    .accessibilityLabel(title)
    .accessibilityValue("\(fields[key]?.int ?? range.lowerBound) \(unit)")
  }
  private var validation: [(String, String)] {
    var result: [(String, String)] = []
    if world == nil && TimeZone(identifier: fields["timezone"]?.string ?? "") == nil {
      result.append(("timezone", "请选择有效的结算时区。"))
    }
    if world != nil && hasConversation {
      let room = rooms.first { $0.id == fields["room_id"]?.string }
      if room == nil {
        result.append(("room_id", "请选择主动联系和互动使用的房间。"))
      } else if fields["interaction"]?.bool == true && room?["kind"].string != "group" {
        result.append(("room_id", "角色之间互动需要选择群聊房间。"))
      }
    }
    var limits = numberLimits
    if world != nil { limits.insert(("interval_minutes", "最短间隔", "分钟", 120...10080), at: 0) }
    for (key, title, unit, range) in limits {
      guard let value = echoInteger(numericText[key] ?? ""), range.contains(value) else {
        result.append(
          (
            key,
            "\(title)需为 \(range.lowerBound.formatted())–\(range.upperBound.formatted()) \(unit)的整数。"
          ))
        continue
      }
    }
    return result
  }
  private func issue(_ key: String) -> String? {
    showValidation ? validation.first { $0.0 == key }?.1 : nil
  }
  private func flag(_ key: String) -> Binding<Bool> {
    .init(get: { fields[key]?.bool ?? false }, set: { fields[key] = .bool($0) })
  }
  private func string(_ key: String) -> Binding<String> {
    .init(get: { fields[key]?.string ?? "" }, set: { fields[key] = .string($0) })
  }
  private func integer(_ key: String) -> Binding<Int> {
    .init(get: { fields[key]?.int ?? 0 }, set: { fields[key] = .number(Double($0)) })
  }
  private func numericBinding(_ key: String) -> Binding<String> {
    .init(
      get: { numericText[key] ?? "" },
      set: {
        numericText[key] = $0
        if let value = echoInteger($0) { fields[key] = .number(Double(value)) }
      })
  }
  private func clock(_ key: String) -> Binding<Date> {
    // HH:mm is a wall-clock value, not an instant in the server's time zone.
    // Use the device calendar in both directions: native macOS DatePicker uses
    // the device zone even when a Form section overrides SwiftUI's timeZone.
    let clockCalendar = Calendar.current
    return .init(
      get: {
        let parts = (fields[key]?.string ?? "00:00").split(separator: ":").compactMap { Int($0) }
        return clockCalendar.date(
          from: DateComponents(
            year: 2001, month: 1, day: 1,
            hour: parts.first ?? 0, minute: parts.count > 1 ? parts[1] : 0)) ?? .distantPast
      },
      set: { date in
        let parts = clockCalendar.dateComponents([.hour, .minute], from: date)
        fields[key] = .string(String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0))
      })
  }
  private func load() async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    failure = nil
    do {
      let response = try await model.autonomy(
        action: world == nil ? "global" : "policy", id: world ?? "")
      let record = world == nil ? response : response["world"]
      fields = record.object
      original = fields
      revision = record["revision"].int
      globalOn = response["global"]["enabled"].bool
      timezone = world == nil ? record["timezone"].string : response["global"]["timezone"].string
      for key in numberLimits.map(\.0) + (world == nil ? [] : ["interval_minutes"]) {
        numericText[key] = (fields[key]?.int ?? 0).formatted(
          .number.locale(Locale(identifier: "zh_CN")))
      }
      originalNumericText = numericText
      showValidation = false
      repairFields = []
      scrollTarget = nil
      loaded = true
      do { usage = try await model.autonomy(action: "usage") } catch {
        failure = "设置已加载，近期用量暂时无法读取。你仍可修改并保存设置。"
      }
    } catch { failure = echoFormFailure(error, action: "读取设置") }
  }
  private func refreshGlobalStatus() async {
    // Returning from the global sheet must preserve edits made in this world.
    do {
      let global = try await model.autonomy(action: "global")
      globalOn = global["enabled"].bool
      timezone = global["timezone"].string
    } catch { failure = echoFormFailure(error, action: "刷新全局状态") }
  }
  private func save() async {
    guard !busy, dirty, validation.isEmpty else { return }
    busy = true
    failure = nil
    defer { busy = false }
    var body = fields
    for key in [
      "id", "owner_id", "world_id", "revision", "last_status", "next_contact_at",
      "next_interaction_at", "recap_revision",
    ] {
      body.removeValue(forKey: key)
    }
    if world != nil && body["room_id"]?.string.isEmpty == true { body["room_id"] = .null }
    do {
      _ = try await model.autonomy(
        action: world == nil ? "saveGlobal" : "savePolicy", id: world ?? "", revision: revision,
        body: .object(body))
      dismiss()
    } catch {
      failure = echoFormFailure(error, action: "保存设置")
      scrollTarget = "form-error"
    }
  }
}

struct RecapView: View {
  var model: AppModel
  let world: String
  @Environment(\.dismiss) private var dismiss
  @State private var items: [Record] = []
  @State private var cursor = 0
  @State private var more = false
  @State private var source: Record?
  @State private var failure: String?
  var body: some View {
    NavigationStack {
      List {
        Text("以下是已经保存的角色发言，按实际发生顺序摘录。点击可跳到原文。").font(.caption).foregroundStyle(.secondary)
        if items.isEmpty { Text("还没有后台剧情或主动消息。") }
        ForEach(items) { item in
          Button {
            source = item
          } label: {
            VStack(alignment: .leading, spacing: 6) {
              Text(item["actor_name"].string + (item["unread"].bool ? " · 未读" : "")).font(.headline)
              Text(displayDate(item["created_at"].string)).font(.caption).foregroundStyle(
                .secondary)
              Text(item["content"].string).foregroundStyle(.primary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
          }.buttonStyle(.plain).accessibilityIdentifier("recap-item")
        }
        if more { Button("加载更多") { Task { await load() } } }
        if let failure { Text(failure).foregroundStyle(.red) }
      }.navigationTitle("离线回顾")
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("完成") { dismiss() } }
          ToolbarItem {
            Button("标记已读") {
              Task {
                do {
                  _ = try await model.autonomy(action: "readRecaps", id: world, revision: cursor)
                  items = []
                  cursor = 0
                  await load()
                } catch { failure = userFacingError(error) }
              }
            }.disabled(items.isEmpty)
          }
        }
        .task { await load() }
        .sheet(item: $source) { item in
          NavigationStack {
            if let room = model.items("room").first(where: { $0.id == item["room_id"].string }) {
              ChatView(model: model, room: room, sourceMessage: item.id)
                .toolbar {
                  ToolbarItem(placement: .cancellationAction) { Button("返回回顾") { source = nil } }
                }
            }
          }
        }
    }.frame(minWidth: 320, idealWidth: 640, minHeight: 480)
  }
  private func load() async {
    do {
      let page = try await model.autonomy(
        action: "recaps", id: world, body: .object(["after": .number(Double(cursor))]))
      items += page["items"].array.map { Record(kind: "recap", value: $0) }
      cursor = page["next_revision"].int
      more = page["has_more"].bool
    } catch { failure = userFacingError(error) }
  }
}
