import CompanionCore
import SwiftUI

struct ContinuationView: View {
  var model: AppModel
  @State private var schedules: JSONValue = .null
  @State private var hosts: JSONValue = .null
  @State private var actor = ""
  @State private var name = ""
  @State private var prompt = ""
  @State private var at = Date().addingTimeInterval(3600)
  @State private var rule = "once"
  @State private var executor = "cloud"
  @State private var interval = 3600
  @State private var status = ""
  @State private var pairing: JSONValue = .null
  @State private var command = "linkHostIdentity"
  @State private var payload = "{}"
  @State private var revision = 0
  var body: some View {
    Form {
      Section("定时任务") {
        Picker("角色", selection: $actor) {
          ForEach(model.items("actor")) { Text($0.name).tag($0.id) }
        }
        TextField("任务名称", text: $name)
        TextField("任务内容", text: $prompt, axis: .vertical)
        Picker("重复", selection: $rule) {
          Text("一次").tag("once")
          Text("每天").tag("daily")
          Text("固定间隔").tag("interval")
        }
        Picker("执行位置", selection: $executor) {
          Text("云端").tag("cloud")
          Text("本机运行机会").tag("device")
        }
        DatePicker("时间", selection: $at)
        if rule == "interval" {
          Stepper("间隔 \(interval) 秒", value: $interval, in: 60...604800, step: 60)
        }
        Text("使用角色最近的普通私聊。云端执行需开启对应世界的主动联系权限。重复任务错过后只补最近一次；错过的单次任务需明确补跑。")
        Button("保存并开启") {
          perform {
            let f = DateFormatter()
            f.dateFormat = "HH:mm"
            _ = try await featureCall(
              model, "saveSchedule",
              [
                "actor_id": .string(actor), "name": .string(name), "prompt": .string(prompt),
                "rule": .string(rule), "timezone": .string(TimeZone.current.identifier),
                "at": .string(
                  rule == "daily" ? f.string(from: at) : ISO8601DateFormatter().string(from: at)),
                "interval_seconds": .number(Double(interval)), "enabled": .bool(true),
                "catch_up": .string("latest"), "executor": .string(executor),
                "device_id": .string(model.connection?.credentials.device_id ?? ""),
                "tool_limit": .number(5),
              ])
            try await load()
            try await DeviceSchedules.synchronize(model)
          }
        }
        ForEach(schedules["schedules"].array, id: \.self) { s in
          DisclosureGroup(s["name"].string + " · " + (s["enabled"].bool ? "开启" : "暂停")) {
            Text(featureJSON(s)).textSelection(.enabled)
            Button("暂停并撤销旧执行版本") {
              perform {
                _ = try await featureCall(
                  model, "pauseSchedule", ["id": s["id"]], revision: s["revision"].int)
                try await load()
              }
            }
          }
        }
        ForEach(schedules["occurrences"].array, id: \.self) { o in
          Text(o["slot"].string + " · " + o["state"].string)
          if ["pending", "missed"].contains(o["state"].string) {
            Button("明确补跑这一时次") {
              perform {
                _ = try await featureCall(
                  model, "runOccurrence",
                  ["id": o["schedule_id"], "slot": o["slot"], "allow_missed": .bool(true)])
                try await load()
              }
            }
          }
        }
      }
      Section("独立 Host") {
        Text("Host 使用自己的角色与数据。配对后仍需授权能力、目录并绑定独立身份。执行结果未知时先对账，不自动切换执行端。")
        Button("生成十分钟配对码") {
          perform { pairing = try await featureCall(model, "createHostPairing") }
        }
        if pairing != .null { Text(featureJSON(pairing)).textSelection(.enabled) }
        ForEach(hosts["hosts"].array, id: \.self) { h in
          Text(h["name"].string + " · " + (h["online"].bool ? "近期有心跳" : "未检测到近期心跳"))
          Text(featureJSON(h)).font(EchoFont.caption).textSelection(.enabled)
        }
        ForEach(hosts["jobs"].array, id: \.self) { j in
          DisclosureGroup(j["kind"].string + " · " + j["state"].string) {
            Text(featureJSON(j)).textSelection(.enabled)
          }
        }
      }
      Section("事件与 Host 高级配置") {
        Text("按服务端字段填写参数；修改时使用当前记录 revision。所有命令均由服务端重新检查权限和版本。")
        Picker("操作", selection: $command) {
          ForEach(
            [
              "linkHostIdentity", "setHostGrants", "setReplyRelay", "submitHostJob",
              "reconcileHostJob",
              "configureHostPlugin", "publishHostSnapshot", "beginHandoff", "confirmHandoff",
              "registerTrigger", "registrationReceipt", "revokeTrigger", "triggerSecret",
            ], id: \.self
          ) { Text($0).tag($0) }
        }
        TextEditor(text: $payload).font(.system(.body, design: .monospaced)).frame(minHeight: 160)
        Stepper("当前 revision \(revision)", value: $revision, in: 0...100000)
        Button("提交配置") {
          perform {
            let p = try JSONDecoder().decode(JSONValue.self, from: Data(payload.utf8))
            let r = try await featureCall(model, command, p.object, revision: revision)
            status = featureJSON(r)
            try await load()
          }
        }
        Text(featureJSON(schedules["triggers"])).textSelection(.enabled)
      }
      Button("刷新") { perform { try await load() } }
      Text(status).textSelection(.enabled)
    }.formStyle(.grouped).navigationTitle("任务与 Host").task {
      actor = model.items("actor").first?.id ?? ""
      do { try await load() } catch { status = userFacingError(error) }
    }
  }
  private func perform(_ work: @escaping @MainActor () async throws -> Void) {
    Task { do { try await work() } catch { status = userFacingError(error) } }
  }
  private func load() async throws {
    schedules = try await featureCall(model, "scheduleLibrary")
    hosts = try await featureCall(model, "hostLibrary")
  }
}
