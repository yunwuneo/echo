import CompanionCore
import SwiftUI

#if os(macOS)
  import AppKit
#else
  import UIKit
#endif

struct ChatView: View {
  var model: AppModel
  let room: Record
  var sourceMessage: String? = nil
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var content = ""
  @State private var addressed: Set<String> = []
  @State private var editing = false
  @State private var details = false
  @State private var activity = false
  @State private var memory = false
  @State private var autonomy = false
  @State private var scrollPosition = ScrollPosition(idType: String.self)
  @State private var nearBottom = true
  @State private var followLatest = true
  @State private var isUserScrolling = false
  @State private var hasNewMessages = false
  @State private var followingSource = false
  @State private var focusRequest = 0
  @State private var macInputHeight: CGFloat = 36
  @State private var regenerateRun: String?
  @State private var replacementDraft: String?
  @State private var replacementCommand: LocalCommand?
  @FocusState private var composerFocused: Bool
  private var messages: [Record] { model.messages(room: room.id) }
  private var members: [Record] {
    model.items("actor").filter { room["actor_ids"].array.contains(.string($0.id)) }
  }
  private var isGroup: Bool { room["kind"].string != "direct" }
  private var title: String { isGroup ? room.name : members.first?.name ?? room.name }
  private var pending: [LocalCommand] {
    model.pending.filter { command in
      command.room == room.id && command.state != "draft"
        && !messages.contains { $0.id == command.messageID }
    }
  }
  private var runs: [Record] {
    model.items("run").filter {
      $0["room_id"].string == room.id
        && ["queued", "running", "awaiting_approval"].contains($0["state"].string)
    }
  }
  private var needsApproval: Bool { runs.contains { $0["state"].string == "awaiting_approval" } }
  private var replying: Bool { model.ready && runs.contains { $0["state"].string == "running" } }
  private var subtitle: String {
    if !model.ready { return "离线 · 可继续写消息" }
    if needsApproval { return "有件事需要你决定" }
    if replying { return "正在输入…" }
    if !runs.isEmpty { return "等候回应…" }
    return isGroup ? "\(members.count) 位角色 · \(worldName)" : worldName
  }
  private var worldName: String {
    model.items("world").first { $0.id == room["world_id"].string }?.name ?? ""
  }
  private var inputLength: Int { ChatPresentation.length(content) }

  var body: some View {
    GeometryReader { geometry in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 0) {
          if messages.isEmpty && pending.isEmpty { emptyChat }
          ForEach(Array(messages.enumerated()), id: \.element.id) { index, message in
            let previous = index > 0 ? messages[index - 1] : nil
            let continuing = ChatPresentation.continues(message, after: previous)
            if ChatPresentation.needsTimestamp(message, after: previous),
              let date = ChatPresentation.date(message)
            {
              timestamp(date)
            }
            messageRow(
              message, continuing: continuing, width: min(geometry.size.width, EchoMetric.chatWidth)
            )
            .padding(.top, continuing ? EchoSpacing.xxs : EchoSpacing.md)
            .id(message.id)
          }
          ForEach(pending) { command in
            pendingRow(command, width: min(geometry.size.width, EchoMetric.chatWidth))
              .padding(.top, EchoSpacing.md)
              .id(command.id)
          }
          if replying && messages.last?["status"].string != "streaming" {
            HStack(alignment: .top, spacing: EchoSpacing.sm) {
              EchoAvatar(name: isGroup ? "…" : title, size: 30)
              TypingDots().padding(.horizontal, EchoSpacing.md).padding(.vertical, EchoSpacing.sm)
                .background(Color.echo.surface, in: Capsule())
                .overlay(Capsule().stroke(Color.echo.border, lineWidth: 1))
            }.padding(.top, EchoSpacing.md).accessibilityLabel("正在输入")
          }
          Color.clear.frame(height: EchoSpacing.md).id("end")
        }
        .scrollTargetLayout()
        .padding(.horizontal, EchoSpacing.md)
        .frame(maxWidth: EchoMetric.chatWidth).frame(maxWidth: .infinity)
      }
      .defaultScrollAnchor(.bottom, for: .initialOffset)
      .defaultScrollAnchor(.bottom, for: .alignment)
      .scrollPosition($scrollPosition)
      .accessibilityIdentifier("chat-history")
      .onScrollPhaseChange { _, phase, context in
        if phase == .tracking || phase == .interacting {
          isUserScrolling = true
          followLatest = false
        } else if phase == .idle && isUserScrolling {
          isUserScrolling = false
          followLatest =
            context.geometry.visibleRect.maxY >= context.geometry.contentSize.height
            - EchoSpacing.xxl
          if followLatest { followingSource = false }
        }
      }
      .onScrollGeometryChange(for: ChatScrollSize.self) { geometry in
        ChatScrollSize(
          contentHeight: geometry.contentSize.height, viewportHeight: geometry.containerSize.height,
          nearBottom: geometry.visibleRect.maxY >= geometry.contentSize.height - EchoSpacing.xxl)
      } action: { previous, current in
        nearBottom = current.nearBottom
        if current.nearBottom { hasNewMessages = false }
        let resized =
          previous.contentHeight != current.contentHeight
          || previous.viewportHeight != current.viewportHeight
        if resized && followLatest && !followingSource && !isUserScrolling {
          scrollPosition.scrollTo(id: "end", anchor: .bottom)
        }
      }
      .overlay(alignment: .bottomTrailing) {
        if !nearBottom {
          Button {
            scrollToBottom()
          } label: {
            Image(systemName: "arrow.down").font(.headline).dynamicTypeSize(.large)
              .frame(width: 44, height: 44)
              .foregroundStyle(Color.echo.primary)
              .background(Color.echo.surface, in: Circle())
              .overlay(Circle().stroke(Color.echo.border, lineWidth: 1))
              .overlay(alignment: .topTrailing) {
                if hasNewMessages { Circle().fill(Color.echo.accent).frame(width: 8, height: 8) }
              }
          }
          .buttonStyle(.plain).padding(EchoSpacing.md)
          .accessibilityIdentifier("return-to-latest")
          .accessibilityLabel(hasNewMessages ? "查看新消息" : "回到最新消息").help("回到最新消息")
        }
      }
    }
    .background(Color.echo.bg)
    .foregroundStyle(Color.echo.textPrimary)
    .safeAreaInset(edge: .bottom, spacing: 0) { composer }
    #if os(macOS)
      .safeAreaInset(edge: .top, spacing: 0) {
        HStack {
          chatHeader
          Spacer()
        }
        .padding(.horizontal, EchoSpacing.lg).padding(.vertical, EchoSpacing.sm)
        .background(Color.echo.bg)
        .overlay(alignment: .bottom) { Color.echo.separator.frame(height: EchoMetric.hairline) }
      }
    #endif
    .navigationTitle(title)
    #if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
      .toolbarBackground(Color.echo.bg, for: .navigationBar)
      .toolbarBackground(.visible, for: .navigationBar)
    #endif
    .toolbar {
      #if os(iOS)
        ToolbarItem(placement: .principal) { chatHeader }
      #endif
      ToolbarItem {
        Menu {
          Button("聊天与成员", systemImage: "person.2") { editing = true }
          Button("剧情与来源", systemImage: "book.closed") { details = true }
          Button("回忆与记忆", systemImage: "text.book.closed") { memory = true }
          Button("主动消息设置", systemImage: "moon.stars") { autonomy = true }
          Button(needsApproval ? "有待你决定的工具操作" : "工具审批与记录", systemImage: "checkmark.shield") {
            activity = true
          }
          if !runs.isEmpty {
            Button("停止本次回应", systemImage: "stop.circle") {
              Task {
                for run in runs {
                  do { try await model.cancel(id: run.id) } catch { model.report(error) }
                }
              }
            }
          }
        } label: {
          Image(systemName: "ellipsis").frame(minWidth: 32, minHeight: 32)
            .overlay(alignment: .topTrailing) {
              if needsApproval { Circle().fill(Color.echo.accent).frame(width: 8, height: 8) }
            }
        }.accessibilityLabel("聊天选项").help("聊天选项")
      }
    }
    .onAppear {
      content = model.draft(room: room.id)
      #if DEBUG
        if let draft = ProcessInfo.processInfo.environment["ECHO2_UI_TEST_DRAFT"] {
          content = draft
          model.saveDraft(room: room.id, content: draft)
        }
      #endif
      if let sourceMessage {
        followingSource = true
        scrollPosition.scrollTo(id: sourceMessage)
      } else {
        scrollPosition.scrollTo(id: "end", anchor: .bottom)
      }
    }
    .onChange(of: messages.last?.id) { _, _ in
      if followLatest && !followingSource && !isUserScrolling {
        scrollPosition.scrollTo(id: "end", anchor: .bottom)
      } else {
        hasNewMessages = true
      }
    }
    .onChange(of: messages.last?["content"].string) { _, _ in
      if followLatest && !followingSource && !isUserScrolling {
        scrollPosition.scrollTo(id: "end", anchor: .bottom)
      }
    }
    .sheet(isPresented: $editing) {
      EntityEditor(
        model: model,
        target: EditTarget(resource: "rooms", record: room, world: room["world_id"].string))
    }
    .sheet(isPresented: $activity) { ToolActivityView(model: model) }
    .sheet(isPresented: $details) { StoryView(model: model, world: room["world_id"].string) }
    .sheet(isPresented: $memory) { MemoryView(model: model, world: room["world_id"].string) }
    .sheet(isPresented: $autonomy) { AutonomyView(model: model, world: room["world_id"].string) }
    .confirmationDialog(
      "换一种回答会替换这一轮所有角色的回应，并更新相关回忆。",
      isPresented: Binding(get: { regenerateRun != nil }, set: { if !$0 { regenerateRun = nil } }),
      titleVisibility: .visible
    ) {
      Button("换一种回答") {
        guard let run = regenerateRun else { return }
        regenerateRun = nil
        Task { do { try await model.regenerate(id: run) } catch { model.report(error) } }
      }
    }
    .confirmationDialog(
      "替换输入框里的草稿？",
      isPresented: Binding(
        get: { replacementDraft != nil },
        set: {
          if !$0 {
            replacementDraft = nil
            replacementCommand = nil
          }
        }),
      titleVisibility: .visible
    ) {
      Button("替换草稿", role: .destructive) {
        guard let text = replacementDraft else { return }
        applyDraft(text, command: replacementCommand)
        replacementDraft = nil
        replacementCommand = nil
      }
      Button("保留草稿", role: .cancel) {
        replacementDraft = nil
        replacementCommand = nil
      }
    }
  }

  private var chatHeader: some View {
    Button {
      editing = true
    } label: {
      HStack(spacing: EchoSpacing.sm) {
        if isGroup {
          ZStack {
            ForEach(Array(members.prefix(2).enumerated()), id: \.element.id) { index, actor in
              EchoAvatar(name: actor.name, id: actor.id, size: 30)
                .offset(x: index == 0 ? -6 : 6, y: index == 0 ? -4 : 4)
            }
          }.frame(width: 44, height: 38)
        } else {
          EchoAvatar(name: title, size: EchoMetric.rowAvatar)
        }
        VStack(alignment: .leading, spacing: EchoSpacing.xxs) {
          Text(title).font(.headline).foregroundStyle(Color.echo.textPrimary).lineLimit(1)
          Text(subtitle).font(.caption).foregroundStyle(Color.echo.textSecondary).lineLimit(1)
        }
      }
    }.buttonStyle(.plain).help("查看聊天与成员")
      .accessibilityLabel("\(title)，\(subtitle)，聊天与成员")
  }

  private var emptyChat: some View {
    VStack(spacing: EchoSpacing.sm) {
      EchoAvatar(name: title, size: 56)
      Text("还没有聊过天").font(.title3.weight(.semibold))
      Text(isGroup ? "大家都在这里，先打个招呼吧。" : "想说的话，就从这里开始。").font(.callout).foregroundStyle(
        Color.echo.textSecondary)
      Button("打个招呼") {
        if content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { content = "你好" }
        focusComposer()
      }.buttonStyle(.bordered)
    }.frame(maxWidth: .infinity).padding(.vertical, EchoSpacing.xxl)
  }

  @ViewBuilder private func messageRow(_ message: Record, continuing: Bool, width: CGFloat)
    -> some View
  {
    let isUser = message["role"].string == "user"
    let status = message["status"].string
    HStack(alignment: .top, spacing: EchoSpacing.sm) {
      if isUser {
        Spacer(minLength: EchoSpacing.xl)
      } else {
        EchoAvatar(name: actorName(message), id: message["actor_id"].string, size: 30)
          .opacity(continuing ? 0 : 1).accessibilityHidden(true)
      }
      VStack(alignment: isUser ? .trailing : .leading, spacing: EchoSpacing.xxs) {
        if isGroup && !isUser && !continuing {
          Text(actorName(message)).font(.footnote.weight(.semibold)).foregroundStyle(
            Color.echo.identity(for: message["actor_id"].string))
        }
        if !message["content"].string.isEmpty {
          Text(
            isUser
              ? AttributedString(message["content"].string)
              : chatMarkdown(message["content"].string)
          )
          .font(.body).lineSpacing(EchoMetric.lineSpacing).textSelection(.enabled)
          .foregroundStyle(isUser ? Color.echo.onPrimary : Color.echo.textPrimary)
          .padding(.horizontal, isUser ? EchoSpacing.md : 0)
          .padding(.vertical, isUser ? EchoSpacing.xs : 0)
          .background {
            if isUser {
              UnevenRoundedRectangle(
                topLeadingRadius: EchoRadius.bubble, bottomLeadingRadius: EchoRadius.bubble,
                bottomTrailingRadius: EchoRadius.xs,
                topTrailingRadius: continuing ? EchoRadius.xs : EchoRadius.bubble
              )
              .fill(Color.echo.primary)
            }
          }
          .frame(
            maxWidth: isUser ? width * 0.78 : .infinity, alignment: isUser ? .trailing : .leading)
        }
        if status == "failed" || status == "interrupted" {
          Label(
            isUser ? "回应未完成，消息已保留" : "TA 好像走神了 · 这条回复未完成", systemImage: "exclamationmark.circle"
          )
          .font(.caption).foregroundStyle(Color.echo.error)
          if !isUser {
            Button("重新编辑这条提问") { restoreQuestion(message) }.font(.footnote).buttonStyle(.borderless)
          }
        } else if status == "invalidated" {
          Text("已被新的回应替代").font(.caption).foregroundStyle(Color.echo.textSecondary)
        } else if status == "cancelled" {
          Text("本次回应已停止").font(.caption).foregroundStyle(Color.echo.textSecondary)
        }
      }
      if !isUser { Spacer(minLength: EchoSpacing.md) }
    }
    .opacity(status == "invalidated" ? 0.55 : 1)
    .contextMenu {
      Button("复制", systemImage: "doc.on.doc") { copy(message["content"].string) }
      Button("引用回复", systemImage: "arrowshape.turn.up.left") {
        content = "> \(actorName(message))：\(message["content"].string)\n\n" + content
        focusComposer()
      }
      if !isUser && status == "completed" {
        Button("换一种回答", systemImage: "arrow.clockwise") { regenerateRun = message["run_id"].string }
      }
      if let date = ChatPresentation.date(message) {
        Text(date.formatted(date: .abbreviated, time: .shortened))
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(isUser ? "你" : actorName(message))
    .accessibilityIdentifier("message-" + message.id)
  }

  private func pendingRow(_ command: LocalCommand, width: CGFloat) -> some View {
    HStack {
      Spacer(minLength: EchoSpacing.xl)
      VStack(alignment: .trailing, spacing: EchoSpacing.xxs) {
        Text(command.content).font(.body).lineSpacing(EchoMetric.lineSpacing)
          .foregroundStyle(Color.echo.onPrimary)
          .padding(.horizontal, EchoSpacing.md).padding(.vertical, EchoSpacing.xs)
          .background(
            Color.echo.primary,
            in: UnevenRoundedRectangle(
              topLeadingRadius: EchoRadius.bubble, bottomLeadingRadius: EchoRadius.bubble,
              bottomTrailingRadius: EchoRadius.xs, topTrailingRadius: EchoRadius.bubble))
        if command.state == "failed" {
          Button {
            Task { await model.retry(command) }
          } label: {
            Label("没发出去 · 轻点重试", systemImage: "exclamationmark.circle.fill")
          }.buttonStyle(.plain).font(.caption).foregroundStyle(Color.echo.error)
          Text(command.failure.contains("（") ? "请检查消息内容与聊天设置后重试。" : command.failure).font(.caption)
            .foregroundStyle(Color.echo.textSecondary)
        } else {
          TimelineView(.periodic(from: .now, by: 1)) { context in
            Text(
              command.state == "accepted"
                ? "已送达 · 正在同步…"
                : !model.ready
                  ? "已存到本机 · 联网后发送"
                  : context.date.timeIntervalSince(command.createdAt) > 10 ? "网络有点慢，还在发" : "发送中…"
            )
            .font(.caption).foregroundStyle(Color.echo.textSecondary)
          }
        }
      }.frame(maxWidth: width * 0.78, alignment: .trailing)
    }
    .contextMenu {
      Button("复制", systemImage: "doc.on.doc") { copy(command.content) }
      if command.state == "failed" {
        Button("重新编辑", systemImage: "pencil") {
          editDraft(command.content, command: command)
        }
      }
      if command.state != "accepted" {
        Button("移除本机待发送内容", role: .destructive) { model.discard(command) }
      }
    }
  }

  private var composer: some View {
    VStack(alignment: .leading, spacing: EchoSpacing.xs) {
      if isGroup {
        Menu {
          Button("自动 · 按参与规则") { addressed = [] }
          ForEach(members) { actor in
            Toggle(
              actor.name,
              isOn: Binding(
                get: { addressed.contains(actor.id) },
                set: {
                  if $0 { addressed.insert(actor.id) } else { addressed.remove(actor.id) }
                }))
          }
        } label: {
          Label(addressed.isEmpty ? "谁来回应 · 自动" : "已点名 \(addressed.count) 位", systemImage: "at")
            .font(.footnote).padding(.horizontal, EchoSpacing.sm).padding(
              .vertical, EchoSpacing.xxs
            )
            .background(Color.echo.primarySoft, in: Capsule())
        }.menuStyle(.borderlessButton).fixedSize(horizontal: true, vertical: false)
          .help("选择回应者，每轮最多 \(room["max_replies"].int) 位")
      }
      if !model.ready {
        Text("离线 · 消息先存到本机，联网后发送").font(.caption).foregroundStyle(Color.echo.textSecondary)
      }
      HStack(alignment: .bottom, spacing: EchoSpacing.xs) {
        #if os(macOS)
          MacChatInput(
            text: $content, height: $macInputHeight,
            placeholder: isGroup ? "想和大家说点什么…" : "想对\(title)说点什么…",
            focusRequest: focusRequest, onSend: send
          )
          .frame(height: macInputHeight)
        #else
          TextField(
            "", text: $content,
            prompt: Text(isGroup ? "想和大家说点什么…" : "想对\(title)说点什么…").foregroundStyle(
              Color.echo.textSecondary), axis: .vertical
          )
          .lineLimit(1...6).textFieldStyle(.plain).font(.body).padding(.vertical, EchoSpacing.xs)
          .focused($composerFocused).accessibilityIdentifier("chat-input").accessibilityLabel("消息")
        #endif
        Button(action: send) {
          Image(systemName: "arrow.up").font(.headline).dynamicTypeSize(.large)
            .foregroundStyle(
              ChatPresentation.canSend(content) ? Color.echo.onPrimary : Color.echo.textSecondary
            )
            .frame(width: 36, height: 36)
            .background(
              ChatPresentation.canSend(content) ? Color.echo.primary : Color.echo.surfaceSunken,
              in: Circle()
            )
            .frame(width: EchoMetric.touchTarget, height: EchoMetric.touchTarget)
            .contentShape(Rectangle())
        }.buttonStyle(.plain).disabled(!ChatPresentation.canSend(content))
          .keyboardShortcut(.return, modifiers: .command)
          .accessibilityLabel("发送").accessibilityIdentifier("send-message").help("发送消息")
          .padding(.bottom, EchoSpacing.xxs)
      }
      .padding(.leading, EchoSpacing.md).padding(.trailing, EchoSpacing.xxs)
      .padding(.vertical, EchoSpacing.xxs)
      .background(
        Color.echo.surface, in: RoundedRectangle(cornerRadius: EchoRadius.lg, style: .continuous)
      )
      .overlay(
        RoundedRectangle(cornerRadius: EchoRadius.lg, style: .continuous).stroke(
          inputLength > ChatPresentation.messageLimit ? Color.echo.error : Color.echo.border,
          lineWidth: 1))
      if inputLength >= ChatPresentation.messageLimit - 1_000 {
        Text(
          inputLength > ChatPresentation.messageLimit
            ? "超出 \(inputLength - ChatPresentation.messageLimit) 字，删减后可发送"
            : "\(inputLength.formatted()) / \(ChatPresentation.messageLimit.formatted())"
        )
        .font(.caption).foregroundStyle(
          inputLength > ChatPresentation.messageLimit ? Color.echo.error : Color.echo.textSecondary
        )
        .frame(maxWidth: .infinity, alignment: .trailing).accessibilityIdentifier("message-length")
      }
    }
    .onChange(of: content) { _, text in model.saveDraft(room: room.id, content: text) }
    .padding(EchoSpacing.md).frame(maxWidth: EchoMetric.chatWidth).frame(maxWidth: .infinity)
    .background(Color.echo.bg)
    .overlay(alignment: .top) { Color.echo.separator.frame(height: 0.5) }
  }

  private func focusComposer() {
    composerFocused = true
    focusRequest += 1
  }

  private func send() {
    guard ChatPresentation.canSend(content) else { return }
    let text = content
    content = ""
    Task {
      do {
        try await model.send(
          room: room.id, content: text,
          addressed: members.filter { addressed.contains($0.id) }.map(\.id))
        scrollToBottom()
      } catch {
        content = text
        model.report(error)
      }
    }
  }
  private func restoreQuestion(_ message: Record) {
    if let question = messages.first(where: {
      $0["run_id"] == message["run_id"] && $0["role"].string == "user"
    }) {
      editDraft(question["content"].string)
    }
  }
  private func editDraft(_ text: String, command: LocalCommand? = nil) {
    if content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || content == text {
      applyDraft(text, command: command)
    } else {
      replacementDraft = text
      replacementCommand = command
    }
  }
  private func applyDraft(_ text: String, command: LocalCommand?) {
    content = text
    if let command { model.discard(command) }
    focusComposer()
  }
  private func actorName(_ message: Record) -> String {
    if message["role"].string == "user" { return "你" }
    return message["actor_name"].string.isEmpty ? "角色" : message["actor_name"].string
  }
  private func scrollToBottom() {
    followingSource = false
    followLatest = true
    withAnimation(reduceMotion ? .easeOut(duration: 0.15) : .easeOut(duration: 0.2)) {
      scrollPosition.scrollTo(id: "end", anchor: .bottom)
    }
    hasNewMessages = false
  }
  private func timestamp(_ date: Date) -> some View {
    HStack(spacing: EchoSpacing.sm) {
      Color.echo.separator.frame(width: 24, height: 0.5)
      Text(timestampLabel(date)).font(.caption).foregroundStyle(Color.echo.textSecondary)
      Color.echo.separator.frame(width: 24, height: 0.5)
    }.frame(maxWidth: .infinity).padding(.top, EchoSpacing.lg).padding(.bottom, EchoSpacing.xs)
  }
  private func timestampLabel(_ date: Date) -> String {
    let time = date.formatted(date: .omitted, time: .shortened)
    if Calendar.current.isDateInToday(date) { return "今天 \(time)" }
    if Calendar.current.isDateInYesterday(date) { return "昨天 \(time)" }
    return date.formatted(date: .abbreviated, time: .shortened)
  }
  private func copy(_ value: String) {
    #if os(macOS)
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(value, forType: .string)
    #else
      UIPasteboard.general.string = value
    #endif
  }
}

private struct ChatScrollSize: Equatable {
  let contentHeight: CGFloat
  let viewportHeight: CGFloat
  let nearBottom: Bool
}

private struct TypingDots: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  var body: some View {
    TimelineView(.animation(minimumInterval: 0.15, paused: reduceMotion)) { timeline in
      HStack(spacing: EchoSpacing.xxs) {
        ForEach(0..<3) { index in
          Circle().fill(Color.echo.textSecondary).frame(width: 6, height: 6)
            .opacity(
              reduceMotion
                ? 0.6
                : 0.35 + 0.65
                  * (sin(
                    timeline.date.timeIntervalSinceReferenceDate * .pi * 2 / 1.2 - Double(index)
                      * 0.8) + 1) / 2)
        }
      }
    }.accessibilityHidden(true)
  }
}

func statusName(_ value: String) -> String {
  [
    "accepted": "已接收", "streaming": "正在输入", "completed": "已完成", "failed": "回复未完成",
    "cancelled": "已停止", "interrupted": "回复未完成", "invalidated": "已被新的回应替代",
  ][value] ?? value
}
func safeMarkdown(_ text: String) -> AttributedString {
  var result =
    (try? AttributedString(
      markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
    ?? AttributedString(text)
  for run in result.runs {
    if let url = run.link, !["https", "http"].contains(url.scheme?.lowercased() ?? "") {
      result[run.range].link = nil
    }
  }
  return result
}
private func chatMarkdown(_ text: String) -> AttributedString {
  var result = safeMarkdown(text)
  // Emphasis represents quiet stage directions, not a second typographic hierarchy.
  for run in result.runs {
    if run.inlinePresentationIntent?.contains(.emphasized) == true {
      result[run.range].foregroundColor = Color.echo.textSecondary
      result[run.range].inlinePresentationIntent = nil
    }
  }
  let plain = String(result.characters)
  if let regex = try? NSRegularExpression(pattern: "（[^）\\n]+）") {
    for match in regex.matches(in: plain, range: NSRange(plain.startIndex..., in: plain)) {
      if let range = Range(match.range, in: plain), let attributed = Range(range, in: result) {
        result[attributed].foregroundColor = Color.echo.textSecondary
      }
    }
  }
  return result
}
