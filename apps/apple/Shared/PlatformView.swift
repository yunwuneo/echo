import CompanionCore
import SwiftUI

struct PlatformView: View {
  var model: AppModel
  @State private var services = SystemServices()
  @State private var library: JSONValue = .null
  @State private var today: JSONValue = .null
  @State private var actor = ""
  @State private var action = "calendar.query"
  @State private var arguments = "{}"
  @State private var shortcut = ""
  @State private var status = ""
  @State private var busy = false
  @State private var externalID = ""
  @State private var evidence = ""
  @State private var resolvedState = "completed"
  private let actions = [
    "calendar.query", "calendar.create", "calendar.update", "calendar.delete", "reminders.query",
    "reminders.create", "reminders.update", "reminders.complete", "reminders.delete",
    "contacts.search", "contacts.create", "health.query", "health.write", "health.delete",
    "photos.query", "location.query", "weather.query", "battery.query", "notifications.create",
    "notifications.delete", "timer.create", "timer.delete", "shortcut.run",
  ]
  private var device: String { model.connection?.credentials.device_id ?? "" }
  var body: some View {
    Form {
      Section("系统授权") {
        ForEach(SystemServices.capabilities, id: \.self) { capability in
          HStack {
            Text(capability)
            Text(
              library["capabilities"].array.first {
                $0["device_id"].string == device && $0["capability"].string == capability
              }?["state"].string ?? "尚未查询"
            ).foregroundStyle(.secondary)
            Button("请求授权") {
              run {
                try await services.request(capability)
                await refreshCapabilities()
              }
            }
          }
        }
        Button("仅查询权限状态") { run { await refreshCapabilities() } }
        Text("拒绝授权不会显示为空数据。健康读取权限由系统保密，无结果时不显示为零。计时器安排本 App 通知，不承诺后台生成或系统闹钟准点响铃。").font(
          EchoFont.caption)
      }
      Section("角色系统动作") {
        Picker("角色", selection: $actor) {
          ForEach(model.items("actor")) { Text($0.name).tag($0.id) }
        }
        Picker("动作", selection: $action) { ForEach(actions, id: \.self) { Text($0).tag($0) } }
        Text(
          "查询时间使用 ISO 8601。写入参数需要 title、start/end 或 id；修改与删除需查询结果的 base_hash。健康 metric 支持 steps、weight、heart_rate。快捷指令只运行已登记名称，将切换应用。"
        ).font(EchoFont.caption)
        TextEditor(text: $arguments).font(.system(.body, design: .monospaced)).frame(minHeight: 100)
          .accessibilityLabel("系统动作参数 JSON")
        Button("允许此角色在此设备使用该动作") { policy(true) }
        Button("撤销该动作许可") { policy(false) }
        Button("创建待确认动作") {
          run {
            let p = try JSONDecoder().decode(JSONValue.self, from: Data(arguments.utf8))
            _ = try await featureCall(
              model, "createSystemAction",
              [
                "actor_id": .string(actor), "device_id": .string(device), "action": .string(action),
                "arguments": p,
              ])
            await load()
          }
        }
        ForEach(library["actions"].array, id: \.self) { a in
          DisclosureGroup(a["action"].string + " · " + a["state"].string) {
            Text(featureJSON(a["payload"])).textSelection(.enabled)
            Text(featureJSON(a["result"])).textSelection(.enabled)
            if a["state"].string == "pending" {
              Button("批准当前参数") { decide(a, true) }
              Button("拒绝") { decide(a, false) }
            }
            if a["device_id"].string == device && a["state"].string == "approved" {
              Button("在本设备执行") { run { try await execute(a) } }
            }
            if a["device_id"].string == device
              && ["executing", "unknown"].contains(a["state"].string)
            {
              Button("核对本机持久回执（不重做动作）") { run { try await reconcile(a) } }
            }
          }
        }
      }
      Section("人工核对未知系统结果") {
        Text("先在系统来源中核实真实结果。此操作只登记核对证据，不再次执行系统动作；原设备不可用时也可在当前设备处理。")
        TextField("核实的外部对象 ID", text: $externalID)
        TextField("核对依据", text: $evidence, axis: .vertical)
        Picker("核实结果", selection: $resolvedState) {
          Text("已完成").tag("completed")
          Text("已确认失败").tag("failed")
        }
        ForEach(
          library["actions"].array.filter {
            ["executing", "unknown"].contains($0["state"].string)
          }, id: \.self
        ) { a in
          Button("确认并登记：" + a["action"].string) {
            run {
              var p: [String: JSONValue] = [
                "id": a["id"], "state": .string(resolvedState), "evidence": .string(evidence),
                "confirmed": .bool(true),
              ]
              if !externalID.isEmpty { p["external_id"] = .string(externalID) }
              _ = try await featureCall(
                model, "reconcileSystemAction", p, revision: a["revision"].int)
              await load()
            }
          }
        }
      }
      Section("今日来源，逐项刷新") {
        Text(Date.now, format: .dateTime.year().month().day().weekday())
        ForEach(["calendar", "reminders", "health", "weather", "location", "battery"], id: \.self) {
          source in
          let row = today["sources"].array.first { $0["source"].string == source }
          DisclosureGroup(source + " · " + (row?["state"].string ?? "未加载")) {
            Text(row?["detail"].string ?? "")
            Text(featureJSON(row?["data"] ?? .null)).textSelection(.enabled)
            Button("刷新这一来源") { run { await refreshToday(source) } }
          }
        }
      }
      Section("快捷指令登记") {
        TextField("你创建的快捷指令名称", text: $shortcut)
        Button("登记名称（不会执行）") {
          var names = UserDefaults.standard.stringArray(forKey: "echo.registeredShortcuts") ?? []
          if !shortcut.trimmingCharacters(in: .whitespaces).isEmpty && !names.contains(shortcut) {
            names.append(shortcut)
            UserDefaults.standard.set(names, forKey: "echo.registeredShortcuts")
          }
        }
      }
      Section("分享与系统提问草稿") {
        Text("分享扩展只保存草稿；这里明确发送后才请求模型。")
        ForEach(library["drafts"].array, id: \.self) { d in
          Text(d["content"].string)
          Button("发送这份草稿") {
            run {
              _ = try await featureCall(model, "sendShareDraft", ["id": d["id"]])
              await load()
            }
          }
        }
        Button("接收系统入口中的草稿") {
          run {
            _ = try await SystemInbox.consume(model)
            await load()
          }
        }
      }
      Text(status).textSelection(.enabled)
    }.navigationTitle("系统与今日").formStyle(.grouped).disabled(busy).task {
      actor = model.items("actor").first?.id ?? ""
      await load()
      await refreshCapabilities()
      SystemInbox.publishTargets(model)
    }
  }
  private func run(_ work: @escaping @MainActor () async throws -> Void) {
    Task {
      busy = true
      defer { busy = false }
      do { try await work() } catch { status = userFacingError(error) }
    }
  }
  private func load() async {
    do {
      library = try await featureCall(model, "platformLibrary")
      today = try await featureCall(model, "todaySummary")
    } catch { status = userFacingError(error) }
  }
  private func policy(_ enabled: Bool) {
    run {
      let old = library["policies"].array.first {
        $0["actor_id"].string == actor && $0["device_id"].string == device
          && $0["action"].string == action
      }
      _ = try await featureCall(
        model, "setSystemPolicy",
        [
          "actor_id": .string(actor), "device_id": .string(device), "action": .string(action),
          "enabled": .bool(enabled),
        ], revision: old?["revision"].int ?? 0)
      await load()
    }
  }
  private func decide(_ a: JSONValue, _ approve: Bool) {
    run {
      _ = try await featureCall(
        model, "decideSystemAction", ["id": a["id"], "approve": .bool(approve)],
        revision: a["revision"].int)
      await load()
    }
  }
  private func refreshCapabilities() async {
    for name in SystemServices.capabilities {
      do {
        _ = try await featureCall(
          model, "reportCapability",
          [
            "capability": .string(name), "state": .string(await services.state(name)),
            "detail": .object([:]),
          ])
      } catch { status = userFacingError(error) }
    }
    await load()
  }
  private func execute(_ a: JSONValue) async throws {
    guard let namespace = model.connection?.namespace else {
      throw APIError(status: 401, code: "not_connected")
    }
    guard try model.executionReceipt(namespace: namespace, id: a["id"].string).isEmpty else {
      throw APIError(status: 409, code: "reconciliation_required")
    }
    await refreshCapabilities()
    let claimed = try await featureCall(
      model, "claimSystemAction", ["id": a["id"]], revision: a["revision"].int)
    guard namespace == model.connection?.namespace else {
      throw APIError(status: 409, code: "connection_changed")
    }
    try model.storeExecutionReceipt(
      namespace: namespace, id: a["id"].string,
      value: featureJSON(
        .object([
          "state": .string("unknown"), "result": .object(["reason": .string("execution_started")]),
        ])))
    var receipt: JSONValue
    do {
      let result = try await services.execute(
        claimed["action"].string, claimed["payload"], id: claimed["id"].string)
      receipt = .object([
        "state": .string(result.state),
        "external_id": result.externalID.map { .string($0) } ?? .null, "result": result.value,
      ])
    } catch {
      receipt = .object([
        "state": .string("unknown"),
        "result": .object(["error": .string((error as? APIError)?.code ?? "system_result_unknown")]
        ),
      ])
    }
    try model.storeExecutionReceipt(
      namespace: namespace, id: a["id"].string, value: featureJSON(receipt))
    guard namespace == model.connection?.namespace else {
      throw APIError(status: 409, code: "connection_changed")
    }
    try await report(claimed, receipt)
    await load()
  }
  private func report(_ a: JSONValue, _ receipt: JSONValue) async throws {
    var p = receipt.object
    p["id"] = a["id"]
    if p["external_id"] == .null { p.removeValue(forKey: "external_id") }
    _ = try await featureCall(model, "completeSystemAction", p, revision: a["revision"].int)
  }
  private func reconcile(_ a: JSONValue) async throws {
    guard let namespace = model.connection?.namespace else {
      throw APIError(status: 401, code: "not_connected")
    }
    let data = Data(try model.executionReceipt(namespace: namespace, id: a["id"].string).utf8)
    guard let receipt = try? JSONDecoder().decode(JSONValue.self, from: data) else {
      throw APIError(status: 409, code: "reconciliation_required")
    }
    try await report(a, receipt)
    await load()
  }
  private func refreshToday(_ source: String) async {
    do {
      _ = try await featureCall(
        model, "reportTodaySource",
        [
          "source": .string(source), "state": .string("loading"), "data": .null,
          "detail": .string(""),
        ])
      var p: JSONValue = .object([:])
      if source == "health" { p = .object(["metric": .string("steps")]) }
      do {
        let value = try await services.execute(source + ".query", p, id: UUID().uuidString).value
        _ = try await featureCall(
          model, "reportTodaySource",
          [
            "source": .string(source),
            "state": .string(value == .array([]) ? "empty" : "available"), "data": value,
            "detail": .string("本设备系统来源"),
          ])
      } catch {
        let state = await services.state(source)
        _ = try await featureCall(
          model, "reportTodaySource",
          [
            "source": .string(source), "state": .string(state == "denied" ? "denied" : "failed"),
            "data": .null, "detail": .string((error as? APIError)?.code ?? "source_failed"),
          ])
      }
      await load()
    } catch { status = userFacingError(error) }
  }
}
