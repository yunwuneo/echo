import CompanionCore
import SwiftUI

struct MemoriesTimelineView: View {
  var model: AppModel
  let openChat: (String) -> Void
  let openPartner: () -> Void
  @State private var worldID = ""
  @State private var selected: Record?

  private var memories: [Record] {
    model.items("memory").filter {
      (worldID.isEmpty || $0["world_id"].string == worldID)
        && isCurrentMemory($0)
    }.sorted {
      $0["valid_from"].string == $1["valid_from"].string
        ? $0.id < $1.id : $0["valid_from"].string > $1["valid_from"].string
    }
  }
  private var days: [String] {
    var seen = Set<String>()
    return memories.map(day).filter { seen.insert($0).inserted }
  }
  private func day(_ memory: Record) -> String {
    ChatPresentation.parseDate(memory["valid_from"].string)?.formatted(
      date: .abbreviated, time: .omitted) ?? String(localized: "共同的回忆")
  }

  var body: some View {
    List {
      if model.items("world").count > 1 {
        Picker(String(localized: "故事"), selection: $worldID) {
          Text(String(localized: "全部故事")).tag("")
          ForEach(model.items("world")) { Text($0.name).tag($0.id) }
        }
      }
      if memories.isEmpty {
        EchoEmptyState(
          title: String(localized: "回忆从聊天开始"),
          description: String(localized: "TA 记住的事会留在这里，慢慢积攒属于你们的经历。"), symbol: "book.closed",
          actionTitle: String(localized: "去聊一聊")
        ) {
          if let room = model.items("room").first(where: {
            worldID.isEmpty || $0["world_id"].string == worldID
          }) {
            openChat(room.id)
          } else {
            openPartner()
          }
        }
        .listRowBackground(Color.echo.bg)
      }
      ForEach(days, id: \.self) { date in
        Section(date) {
          ForEach(memories.filter { day($0) == date }) { memory in
            Button {
              selected = memory
            } label: {
              VStack(alignment: .leading, spacing: EchoSpacing.sm) {
                Label(
                  model.items("world").first { $0.id == memory["world_id"].string }?.name
                    ?? String(localized: "你们的故事"), systemImage: "book.closed"
                )
                .font(EchoFont.footnote).foregroundStyle(Color.echo.primary)
                if memory["audience_actor_ids"].array.isEmpty {
                  Text(String(localized: "仅你可见")).font(EchoFont.caption)
                    .foregroundStyle(Color.echo.textSecondary)
                }
                Text(memory["content"].string).font(EchoFont.body)
                  .foregroundStyle(Color.echo.textPrimary).lineSpacing(EchoMetric.lineSpacing)
                  .fixedSize(horizontal: false, vertical: true)
                if memory["status"].string != "active" {
                  Text(
                    memory["status"].string == "claimed"
                      ? String(localized: "这件事被提到过 · 还未确认") : String(localized: "这件事还需要确认")
                  )
                  .font(EchoFont.caption).foregroundStyle(Color.echo.textSecondary)
                }
              }.padding(.vertical, EchoSpacing.sm)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).accessibilityIdentifier("memory-timeline-item")
            .listRowBackground(Color.echo.surface)
          }
        }
      }
    }
    .scrollContentBackground(.hidden).background(Color.echo.bg)
    .navigationTitle(String(localized: "回忆")).accessibilityIdentifier("memories-timeline")
    .onChange(of: model.items("world").map(\.id)) { _, ids in
      if !worldID.isEmpty && !ids.contains(worldID) { worldID = "" }
    }
    .sheet(item: $selected) { memory in
      MemoryMomentView(model: model, memoryID: memory.id) { roomID in
        selected = nil
        openChat(roomID)
      }
    }
  }
}

private struct MemoryMomentView: View {
  var model: AppModel
  let memoryID: String
  private var memory: Record? {
    model.items("memory").first {
      $0.id == memoryID && isCurrentMemory($0)
    }
  }
  let openChat: (String) -> Void
  @Environment(\.dismiss) private var dismiss
  private var originals: [Record] {
    model.items("message").filter { memory?["source_ids"].array.contains(.string($0.id)) == true }
  }
  var body: some View {
    NavigationStack {
      List {
        if let memory {
          Section(
            memory["audience_actor_ids"].array.isEmpty
              ? String(localized: "你的记录") : String(localized: "TA 记住的事")
          ) {
            if memory["audience_actor_ids"].array.isEmpty {
              Text(String(localized: "仅你可见")).font(EchoFont.footnote)
                .foregroundStyle(Color.echo.textSecondary)
            }
            Text(memory["content"].string).font(EchoFont.body).lineSpacing(EchoMetric.lineSpacing)
              .textSelection(.enabled)
            if memory["status"].string != "active" {
              Text(String(localized: "这是尚未确认的回忆，可以在「我」的记忆与来源中核对、修正。")).font(EchoFont.footnote)
                .foregroundStyle(Color.echo.textSecondary)
            }
          }
          Section(String(localized: "那时说过的话")) {
            ForEach(originals) { source in
              VStack(alignment: .leading, spacing: EchoSpacing.xs) {
                Text(ChatMessage(record: source).displayName).font(EchoFont.footnote)
                  .foregroundStyle(
                    Color.echo.primary)
                Text(source["content"].string).font(EchoFont.body).textSelection(.enabled)
                if model.items("room").contains(where: { $0.id == source["room_id"].string }) {
                  Button(String(localized: "回到这段聊天")) { openChat(source["room_id"].string) }
                    .buttonStyle(.bordered)
                }
              }.padding(.vertical, EchoSpacing.xs)
            }
            if originals.isEmpty {
              Text(String(localized: "这段对话尚未保存在本机，连接服务器后再来看看。")).foregroundStyle(
                Color.echo.textSecondary)
            }
          }
        } else {
          Text(String(localized: "这段回忆已更新或移除。")).foregroundStyle(Color.echo.textSecondary)
        }
      }
      .scrollContentBackground(.hidden).background(Color.echo.bg)
      .navigationTitle(String(localized: "一段回忆"))
      .onChange(of: memory == nil) { _, missing in if missing { dismiss() } }
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button(String(localized: "完成")) { dismiss() }
        }
      }
    }
  }
}

struct PartnerProfileView: View {
  var model: AppModel
  let openChat: (String) -> Void
  @State private var actorID = ""
  @State private var edit: EditTarget?
  @State private var details: Record?
  @State private var autonomyWorld: Record?
  @State private var importing: Record?
  private var actors: [Record] { model.items("actor") }
  private var actor: Record? { actors.first { $0.id == actorID } ?? actors.first }
  private var world: Record? { model.items("world").first { $0.id == actor?["world_id"].string } }
  // Only show the pinned version, never a newer template as this actor's current personality.
  private var character: Record? {
    model.items("character").first {
      $0.id == actor?["template_id"].string && $0["revision"].int == actor?["template_revision"].int
    }
  }

  var body: some View {
    List {
      if !actors.isEmpty {
        Picker(
          String(localized: "切换 TA"),
          selection: Binding(get: { actor?.id ?? "" }, set: { actorID = $0 })
        ) {
          ForEach(actors) { item in
            let context =
              model.items("world").first { $0.id == item["world_id"].string }?.name ?? ""
            Text("\(item.name) · \(context)").tag(item.id)
          }
        }.accessibilityIdentifier("partner-picker")
      }
      if let actor, let world {
        Section {
          VStack(alignment: .leading, spacing: EchoSpacing.md) {
            EchoAvatar(name: actor.name, id: actor.id, size: EchoMetric.heroIcon)
            Text(actor.name).font(EchoFont.display)
            Text(world.name).font(EchoFont.callout).foregroundStyle(Color.echo.textSecondary)
            if let character {
              let definition =
                character["definition"] == .null ? character.value : character["definition"]
              if !definition["description"].string.isEmpty {
                Text(definition["description"].string).font(EchoFont.body)
              }
              if !definition["personality"].string.isEmpty {
                Text(definition["personality"].string).font(EchoFont.callout).foregroundStyle(
                  Color.echo.textSecondary)
              }
            }
          }.padding(.vertical, EchoSpacing.md).fixedSize(horizontal: false, vertical: true)
          if let room = model.items("room").first(where: {
            $0["kind"].string == "direct" && $0["world_id"].string == world.id
              && $0["actor_ids"].array.contains(.string(actor.id))
          }) {
            Button(String(localized: "和 TA 聊聊"), systemImage: "bubble.left.and.bubble.right") {
              openChat(room.id)
            }.buttonStyle(.borderedProminent)
          } else {
            Button(String(localized: "开启一段聊天"), systemImage: "plus.bubble") {
              edit = EditTarget(resource: "rooms", world: world.id)
            }.buttonStyle(.borderedProminent)
          }
        }.listRowBackground(Color.echo.bg)
        Section {
          Button {
            edit = EditTarget(resource: "actors", record: actor, world: world.id)
          } label: {
            EchoSettingsRow(
              title: String(localized: "TA 的资料"), subtitle: String(localized: "名字、性格与相处方式"),
              symbol: "person.crop.circle", color: Color.echo.primary)
          }
          Button {
            details = world
          } label: {
            EchoSettingsRow(
              title: String(localized: "TA 的设定"), subtitle: String(localized: "设定集、角色与共同的故事"),
              symbol: "book.closed", color: Color.echo.moss)
          }.accessibilityIdentifier("partner-settings")
          Button {
            autonomyWorld = world
          } label: {
            EchoSettingsRow(
              title: String(localized: "主动消息"), subtitle: String(localized: "TA 什么时候找你，以及别打扰的时段"),
              symbol: "moon.stars", color: Color.echo.mauve)
          }.accessibilityIdentifier("partner-autonomy")
        }.listRowBackground(Color.echo.surface)
      } else {
        EchoEmptyState(
          title: String(localized: "认识一个新的 TA"),
          description: String(localized: "写下名字和性格，把故事里的那个人带到这里。"), symbol: "person.crop.circle",
          actionTitle: String(localized: "创建角色")
        ) { edit = EditTarget(resource: "characters") }
        if let world = model.items("world").first {
          Button(String(localized: "把角色加入 TA 的设定")) {
            edit = EditTarget(resource: "actors", world: world.id)
          }.buttonStyle(.bordered)
          Button(String(localized: "导入角色卡")) { importing = world }.buttonStyle(.bordered)
        } else {
          Button(String(localized: "创建 TA 的设定")) { edit = EditTarget(resource: "worlds") }
            .buttonStyle(.bordered)
        }
      }
    }
    .buttonStyle(.plain).scrollContentBackground(.hidden).background(Color.echo.bg)
    .navigationTitle("TA").accessibilityIdentifier("partner-profile")
    .toolbar {
      ToolbarItem(placement: .primaryAction) {
        Menu {
          Button(String(localized: "创建角色"), systemImage: "person.badge.plus") {
            edit = EditTarget(resource: "characters")
          }
          ForEach(model.items("world")) { world in
            Button(String(localized: "加入「\(world.name)」")) {
              edit = EditTarget(resource: "actors", world: world.id)
            }
            Button(String(localized: "导入角色卡到「\(world.name)」")) { importing = world }
          }
        } label: {
          Label(String(localized: "认识新的 TA"), systemImage: "person.badge.plus")
        }
        .help(String(localized: "创建或导入角色"))
      }
    }
    .sheet(item: $edit) { EntityEditor(model: model, target: $0) }
    .sheet(item: $details) { WorldDetails(model: model, world: $0) }
    .sheet(item: $importing) { ImportView(model: model, world: $0.id) }
    .sheet(item: $autonomyWorld) { world in
      AutonomyView(model: model, world: world.id)
    }
  }
}

func isCurrentMemory(_ memory: Record) -> Bool {
  guard ["active", "claimed", "conflict"].contains(memory["status"].string) else { return false }
  if let end = ChatPresentation.parseDate(memory["valid_to"].string), end <= .now { return false }
  return true
}
