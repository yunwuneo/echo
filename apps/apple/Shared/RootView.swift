import CompanionCore
import SwiftUI

#if os(iOS)
  enum EchoTab: Hashable { case chats, memories, partner, me }

  struct RootView: View {
    var model: AppModel
    @Binding var selectedRoom: String?
    var notificationSource: String?
    @State private var tab: EchoTab = .chats
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var search = ""
    @State private var searchPresented = false
    @FocusState private var searchFocused: Bool
    @State private var edit: EditTarget?
    @State private var settingsWorld: Record?
    @State private var importingWorld: Record?
    @State private var activity: LiveStatus.Item?

    private var live: LiveStatus { LiveStatus(records: model.records, isConnected: model.ready) }
    private var chatPath: Binding<[String]> {
      Binding(get: { selectedRoom.map { [$0] } ?? [] }, set: { selectedRoom = $0.last })
    }
    private var visibleStatus: LiveStatus.Item? {
      typeSize.isAccessibilitySize || (tab == .chats && selectedRoom != nil) ? nil : live.current
    }

    var body: some View {
      TabView(selection: $tab) {
        Tab(String(localized: "聊天"), systemImage: "bubble.left.and.bubble.right", value: .chats) {
          NavigationStack(path: chatPath) {
            ConversationListView(
              model: model, search: $search, searchPresented: $searchPresented,
              searchFocus: $searchFocused, live: live,
              openStatus: openStatus, openMemories: { tab = .memories }, create: { edit = $0 },
              settings: { settingsWorld = $0 }, importing: { importingWorld = $0 }
            )
            .navigationDestination(for: String.self) { id in
              if let room = model.items("room").first(where: { $0.id == id }) {
                ChatView(model: model, room: room, sourceMessage: notificationSource)
                  .id(id + (notificationSource ?? ""))
              }
            }
          }
        }.accessibilityIdentifier("echo-tab-chats")
        Tab(String(localized: "回忆"), systemImage: "book.closed", value: .memories) {
          NavigationStack {
            MemoriesTimelineView(model: model, openChat: openChat, openPartner: { tab = .partner })
          }
        }.accessibilityIdentifier("echo-tab-memories")
        Tab("TA", systemImage: "heart.text.square", value: .partner) {
          NavigationStack {
            PartnerProfileView(model: model, openChat: openChat)
          }
        }.accessibilityIdentifier("echo-tab-characters")
        Tab(String(localized: "我"), systemImage: "person.crop.circle", value: .me) {
          NavigationStack { SettingsView(model: model, embedded: true) }
        }.accessibilityIdentifier("echo-tab-profile")
      }
      .tint(Color.echo.primary)
      .modifier(
        GlassDockBehavior(status: visibleStatus, remaining: live.remainingCount, open: openStatus)
      )
      .onChange(of: selectedRoom) { _, room in
        searchFocused = false
        searchPresented = false
        if room != nil { tab = .chats }
      }
      .onChange(of: tab) { _, _ in
        searchFocused = false
        searchPresented = false
      }
      .sheet(item: $edit) { EntityEditor(model: model, target: $0) }
      .sheet(item: $settingsWorld) { WorldDetails(model: model, world: $0) }
      .sheet(item: $importingWorld) { ImportView(model: model, world: $0.id) }
      .sheet(item: $activity) { ToolActivityView(model: model, focusCallID: $0.toolCallID) }
    }

    private func openChat(_ id: String) {
      tab = .chats
      selectedRoom = id
    }
    private func openStatus(_ item: LiveStatus.Item) {
      if item.needsDecision { activity = item } else { openChat(item.roomID) }
    }
  }

  struct GlassDockBehavior: ViewModifier {
    let status: LiveStatus.Item?
    let remaining: Int
    let open: (LiveStatus.Item) -> Void

    @ViewBuilder func body(content: Content) -> some View {
      if #available(iOS 26.1, *) {
        content
          .tabBarMinimizeBehavior(.onScrollDown)
          .tabViewBottomAccessory(isEnabled: status != nil) {
            if let status {
              LiveStatusAccessory(status: status, remaining: remaining) { open(status) }
            }
          }
      } else if #available(iOS 26, *) {
        // Keep the TabView identity stable on 26.0 (no isEnabled overload).
        // Its native glass Dock remains; the status appears in the list instead.
        content.tabBarMinimizeBehavior(.onScrollDown)
      } else {
        content
      }
    }
  }

  @available(iOS 26, *)
  struct LiveStatusAccessory: View {
    let status: LiveStatus.Item
    let remaining: Int
    let open: () -> Void
    @Environment(\.tabViewBottomAccessoryPlacement) private var placement

    var body: some View {
      LiveStatusButton(
        status: status, remaining: remaining, compact: placement == .inline, open: open
      )
      .padding(.horizontal, EchoSpacing.md)
      .accessibilityIdentifier("live-status-accessory")
    }
  }

  struct LiveStatusButton: View {
    let status: LiveStatus.Item
    let remaining: Int
    var compact = false
    var identifier = "live-status-accessory"
    var multiline = false
    let open: () -> Void
    var body: some View {
      Button(action: open) {
        HStack(alignment: multiline ? .top : .center, spacing: EchoSpacing.sm) {
          if status.needsDecision {
            Image(systemName: "hand.raised").foregroundStyle(Color.echo.primary)
              .accessibilityHidden(true)
          } else {
            EchoAvatar(
              name: status.partnerName, id: status.actorID, size: EchoMetric.accessoryAvatar)
          }
          if multiline {
            VStack(alignment: .leading, spacing: EchoSpacing.xs) {
              Text(status.shortText).font(EchoFont.callout)
                .fixedSize(horizontal: false, vertical: true)
              if remaining > 0 {
                Text(String(localized: "还有 \(remaining) 件")).font(EchoFont.caption)
              }
            }
          } else {
            ViewThatFits(in: .horizontal) {
              Text(compact ? status.shortText : status.text).font(EchoFont.subheadline).lineLimit(1)
              Text(status.shortText).font(EchoFont.subheadline).lineLimit(1)
            }
          }
          Spacer(minLength: 0)
          if status.isComposing && !compact && !multiline { TypingDots() }
          if status.needsDecision && !compact && !multiline {
            Text(String(localized: "查看")).font(EchoFont.footnote).foregroundStyle(
              Color.echo.primary)
          }
          if remaining > 0 && !compact && !multiline {
            Text(String(localized: "还有 \(remaining) 件")).font(EchoFont.caption).foregroundStyle(
              Color.echo.textSecondary)
          }
        }
        .foregroundStyle(Color.echo.textPrimary)
        .frame(minHeight: EchoMetric.touchTarget)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(
        status.text + (remaining > 0 ? String(localized: "，还有 \(remaining) 件") : "")
      )
      .accessibilityIdentifier(identifier)
      .accessibilityAddTraits(.isButton)
      .accessibilityHint(
        status.needsDecision ? String(localized: "查看这件事并决定是否同意") : String(localized: "打开这段聊天"))
    }
  }

  struct ConversationListView: View {
    var model: AppModel
    @Binding var search: String
    @Binding var searchPresented: Bool
    var searchFocus: FocusState<Bool>.Binding
    @Environment(\.dynamicTypeSize) private var typeSize
    let live: LiveStatus
    let openStatus: (LiveStatus.Item) -> Void
    let openMemories: () -> Void
    let create: (EditTarget) -> Void
    let settings: (Record) -> Void
    let importing: (Record) -> Void

    private func filteredRooms(latest: [String: Record]) -> [Record] {
      model.items("room").filter { room in
        search.isEmpty || room.name.localizedStandardContains(search)
          || model.items("actor").contains {
            room["actor_ids"].array.contains(.string($0.id))
              && $0.name.localizedStandardContains(search)
          }
      }.sorted { lhs, rhs in
        let leftDirect = lhs["kind"].string == "direct"
        let rightDirect = rhs["kind"].string == "direct"
        if leftDirect != rightDirect { return leftDirect }
        let leftDate =
          latest[lhs.id].flatMap(ChatPresentation.date) ?? .distantPast
        let rightDate =
          latest[rhs.id].flatMap(ChatPresentation.date) ?? .distantPast
        return leftDate == rightDate
          ? lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending : leftDate > rightDate
      }
    }

    var body: some View {
      let latest = latestConversationMessages(model.records)
      let rooms = filteredRooms(latest: latest)
      List {
        if typeSize.isAccessibilitySize {
        } else if #available(iOS 26.1, *) {
        } else if let status = live.current {
          LiveStatusButton(
            status: status, remaining: live.remainingCount,
            identifier: "quiet-live-status"
          ) { openStatus(status) }
        }
        if rooms.isEmpty {
          if search.isEmpty {
            EchoEmptyState(
              title: String(localized: "还没有聊过天"),
              description: String(localized: "认识一位新的 TA，或邀请熟悉的朋友开始聊天。"),
              actionTitle: String(localized: "开启一段聊天")
            ) {
              create(
                EditTarget(
                  resource: model.items("world").isEmpty ? "worlds" : "rooms",
                  world: model.items("world").first?.id))
            }
            if let world = model.items("world").first {
              Button(String(localized: "导入角色卡")) { importing(world) }.buttonStyle(.bordered)
            }
          } else {
            EchoEmptyState(
              title: String(localized: "没有找到这段聊天"),
              description: String(localized: "试试 TA 的名字，或清除搜索看看。"), symbol: "magnifyingglass",
              actionTitle: String(localized: "清除搜索")
            ) { search = "" }
          }
        }
        ForEach(rooms) { room in
          NavigationLink(value: room.id) {
            ConversationRow(model: model, room: room, latest: latest[room.id])
          }
          .contextMenu {
            Button(String(localized: "聊天与成员"), systemImage: "person.2") {
              create(EditTarget(resource: "rooms", record: room, world: room["world_id"].string))
            }
            if let world = model.items("world").first(where: { $0.id == room["world_id"].string }) {
              Button(String(localized: "TA 的设定"), systemImage: "book.closed") { settings(world) }
            }
          }
          .listRowBackground(Color.echo.bg)
        }
        if search.isEmpty { recentMemory }
      }
      .listStyle(.plain)
      .scrollContentBackground(.hidden)
      .background(Color.echo.bg)
      .accessibilityIdentifier("chat-list")
      .safeAreaInset(edge: .top, spacing: 0) {
        if typeSize.isAccessibilitySize, let status = live.current {
          LiveStatusButton(
            status: status, remaining: live.remainingCount,
            identifier: "quiet-live-status", multiline: true
          ) { openStatus(status) }
          .padding(EchoSpacing.md)
          .background(Color.echo.bg)
        }
      }
      .navigationTitle(String(localized: "聊天"))
      .navigationBarTitleDisplayMode(typeSize.isAccessibilitySize ? .inline : .large)
      .searchable(
        text: $search, isPresented: $searchPresented,
        placement: .navigationBarDrawer(displayMode: .always),
        prompt: typeSize.isAccessibilitySize
          ? String(localized: "搜索") : String(localized: "搜索聊天或名字")
      )
      .searchFocused(searchFocus)
      .toolbar {
        ToolbarItem(placement: .primaryAction) {
          Menu {
            ForEach(model.items("world")) { world in
              Button(String(localized: "在「\(world.name)」开始聊天"), systemImage: "plus.bubble") {
                create(EditTarget(resource: "rooms", world: world.id))
              }
              Button(
                String(localized: "导入角色卡到「\(world.name)」"), systemImage: "square.and.arrow.down"
              ) { importing(world) }
            }
            Button(String(localized: "创建角色"), systemImage: "person.badge.plus") {
              create(EditTarget(resource: "characters"))
            }
            Button(String(localized: "新建 TA 的设定"), systemImage: "book.closed") {
              create(EditTarget(resource: "worlds"))
            }
          } label: {
            Label(String(localized: "新的对话"), systemImage: "square.and.pencil")
          }
          .help(String(localized: "新的对话、角色或导入角色卡"))
        }
      }
    }
    @ViewBuilder private var recentMemory: some View {
      if let memory = model.items("memory").filter(isCurrentMemory).max(by: {
        $0["valid_from"].string < $1["valid_from"].string
      }) {
        Section(String(localized: "最近的回忆")) {
          Button(action: openMemories) {
            VStack(alignment: .leading, spacing: EchoSpacing.sm) {
              Label(
                model.items("world").first { $0.id == memory["world_id"].string }?.name
                  ?? String(localized: "你们的故事"), systemImage: "book.closed"
              )
              .font(EchoFont.footnote).foregroundStyle(Color.echo.primary)
              if memory["audience_actor_ids"].array.isEmpty {
                Text(String(localized: "你的记录 · 仅你可见"))
                  .font(EchoFont.caption).foregroundStyle(Color.echo.textSecondary)
              }
              Text(memory["content"].string).font(EchoFont.title)
                .foregroundStyle(Color.echo.textPrimary).lineLimit(4)
              if memory["status"].string != "active" {
                Text(String(localized: "还需要确认")).font(EchoFont.caption)
                  .foregroundStyle(Color.echo.textSecondary)
              }
            }.padding(.vertical, EchoSpacing.lg).frame(maxWidth: .infinity, alignment: .leading)
          }.buttonStyle(.plain).listRowBackground(Color.echo.primarySoft)
            .accessibilityIdentifier("recent-memory")
        }
      }
    }

  }
#endif

struct ConversationRow: View {
  @Environment(\.dynamicTypeSize) private var typeSize
  var model: AppModel
  let room: Record
  private var members: [Record] {
    model.items("actor").filter { room["actor_ids"].array.contains(.string($0.id)) }
  }
  var latest: Record?
  private var avatarSize: CGFloat {
    #if os(macOS)
      EchoMetric.sidebarAvatar
    #else
      EchoMetric.touchTarget
    #endif
  }
  var body: some View {
    HStack(spacing: EchoSpacing.sm) {
      if room["kind"].string == "direct" {
        EchoAvatar(
          name: members.first?.name ?? room.name, id: members.first?.id ?? room.id,
          size: avatarSize)
      } else {
        ZStack {
          EchoAvatar(
            name: members.dropFirst().first?.name ?? room.name, id: members.dropFirst().first?.id,
            size: min(EchoMetric.smallAvatar, avatarSize)
          )
          .offset(x: EchoSpacing.xxs, y: -EchoSpacing.xxs)
          EchoAvatar(
            name: members.first?.name ?? room.name, id: members.first?.id,
            size: min(EchoMetric.smallAvatar, avatarSize)
          )
          .overlay { Circle().stroke(Color.echo.bg, lineWidth: EchoMetric.border) }
          .offset(x: -EchoSpacing.xxs, y: EchoSpacing.xxs)
        }.frame(width: avatarSize, height: avatarSize)
      }
      VStack(alignment: .leading, spacing: EchoSpacing.xxs) {
        if typeSize.isAccessibilitySize {
          Text(room.name).font(EchoFont.headline).foregroundStyle(Color.echo.textPrimary)
            .fixedSize(horizontal: false, vertical: true)
          if let latest, let date = ChatPresentation.date(latest) {
            Text(date, format: .dateTime.month(.twoDigits).day().hour().minute())
              .font(EchoFont.caption).foregroundStyle(Color.echo.textSecondary)
              .fixedSize(horizontal: false, vertical: true)
          }
        } else {
          HStack(alignment: .firstTextBaseline, spacing: EchoSpacing.xs) {
            Text(room.name).font(EchoFont.headline).foregroundStyle(Color.echo.textPrimary)
              .lineLimit(
                2)
            Spacer(minLength: 0)
            if let latest, let date = ChatPresentation.date(latest) {
              Text(date, format: .dateTime.month(.twoDigits).day().hour().minute())
                .font(EchoFont.caption).foregroundStyle(Color.echo.textSecondary).lineLimit(1)
            }
          }
        }
        Text(latest?["content"].string ?? String(localized: "还没有聊过天，先打个招呼吧"))
          .font(EchoFont.callout).foregroundStyle(Color.echo.textSecondary)
          .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
      }
    }
    .padding(.vertical, EchoSpacing.sm)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(room.name)
    .accessibilityValue(latest?["content"].string ?? String(localized: "还没有聊过天"))
  }
}

/// One pass per list update; never sort the full message history inside each row/comparison.
func latestConversationMessages(_ records: [Record]) -> [String: Record] {
  var latest: [String: Record] = [:]
  for message in records where message.kind == "message" {
    guard message["status"].string != "invalidated", !message["content"].string.isEmpty else {
      continue
    }
    let room = message["room_id"].string
    if let previous = latest[room],
      !cursorIsNewer(message["sequence"].string, than: previous["sequence"].string)
    {
      continue
    }
    latest[room] = message
  }
  return latest
}
