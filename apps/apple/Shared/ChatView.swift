import CompanionCore
import SwiftUI

struct ChatView: View {
  var model: AppModel
  let room: Record
  var sourceMessage: String? = nil
  @State private var content = ""
  @State private var addressed: Set<String> = []
  @State private var editing = false
  @State private var details = false
  @State private var activity = false
  @State private var scrollPosition = ScrollPosition(edge: .bottom)
  private var messages: [Record] { model.messages(room: room.id) }
  private var members: [Record] {
    model.items("actor").filter { room["actor_ids"].array.contains(.string($0.id)) }
  }
  private var runs: [Record] {
    model.items("run").filter {
      $0["room_id"].string == room.id
        && ["queued", "running", "awaiting_approval"].contains($0["state"].string)
    }
  }
  var body: some View {
    VStack(spacing: 0) {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 18) {
          if messages.isEmpty {
            ContentUnavailableView(
              "故事从这里开始", systemImage: "sparkles", description: Text("发送一句话，或点名让某位角色回应。"))
          }
          ForEach(messages) { message in
            VStack(alignment: .leading, spacing: 5) {
              HStack {
                Text(
                  message["role"].string == "user"
                    ? "你"
                    : (message["actor_name"].string.isEmpty ? "助手" : message["actor_name"].string)
                ).font(.headline)
                Spacer()
                Text(statusName(message["status"].string)).font(.caption).foregroundStyle(
                  .secondary)
              }
              Text(safeMarkdown(message["content"].string)).textSelection(.enabled)
              if message["status"].string == "completed" && message["role"].string == "assistant" {
                Button("重生成此轮") {
                  Task {
                    do { try await model.regenerate(id: message["run_id"].string) } catch {
                      model.report(error)
                    }
                  }
                }.font(.caption).buttonStyle(.borderless)
              }
            }
            .padding(14).background(
              message["role"].string == "user"
                ? Color.accentColor.opacity(0.08) : Color.secondary.opacity(0.07),
              in: RoundedRectangle(cornerRadius: 14)
            )
            .opacity(message["status"].string == "invalidated" ? 0.45 : 1)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(
              "\(message["role"].string == "user" ? "你" : message["actor_name"].string)：\(message["content"].string)"
            )
            .accessibilityValue(statusName(message["status"].string))
            .accessibilityIdentifier("message-" + message.id)
            .id(message.id)
          }
          ForEach(model.pending.filter { $0.room == room.id && $0.state != "draft" }) { command in
            if !messages.contains(where: { $0.id == command.messageID }) {
              VStack(alignment: .leading, spacing: 6) {
                Text(command.content).textSelection(.enabled)
                Text(
                  command.state == "accepted"
                    ? "服务器已接收 · 等待同步"
                    : command.state == "failed" ? command.failure : "待发送 · 尚未被服务器接收"
                ).font(.caption).foregroundStyle(.secondary)
                HStack {
                  if command.state == "failed" {
                    Button("重试") { Task { await model.retry(command) } }
                  }
                  if command.state != "accepted" {
                    Button("移除本机待发送内容", role: .destructive) { model.discard(command) }
                  }
                }.font(.caption)
              }.padding(14).background(
                Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
            }
          }
          Color.clear.frame(height: 1).id("end")
        }.padding().frame(maxWidth: 900).frame(maxWidth: .infinity)
      }
      .defaultScrollAnchor(.bottom, for: .initialOffset)
      .scrollPosition($scrollPosition)
      .onAppear {
        if let sourceMessage {
          scrollPosition.scrollTo(id: sourceMessage)
        } else {
          scrollPosition.scrollTo(edge: .bottom)
        }
      }
      .onChange(of: messages.last?.id) { _, _ in
        withAnimation { scrollPosition.scrollTo(edge: .bottom) }
      }
      .onChange(of: model.pending.filter { $0.room == room.id && $0.state != "draft" }.map(\.id)) {
        _, _ in
        scrollPosition.scrollTo(edge: .bottom)
      }
      if !runs.isEmpty {
        HStack {
          ProgressView().controlSize(.small)
          Text("\(runs.count) 个运行正在排队或回复").font(.caption)
          Spacer()
          Button("取消运行") {
            Task {
              for run in runs {
                do { try await model.cancel(id: run.id) } catch { model.report(error) }
              }
            }
          }
        }.padding(.horizontal)
      }
      Divider()
      VStack(alignment: .leading, spacing: 10) {
        HStack {
          Menu {
            Button("按角色参与规则") { addressed = [] }
            ForEach(members) { actor in
              Toggle(
                actor.name,
                isOn: Binding(
                  get: { addressed.contains(actor.id) },
                  set: { if $0 { addressed.insert(actor.id) } else { addressed.remove(actor.id) } })
              )
            }
          } label: {
            Label(
              addressed.isEmpty
                ? "按规则回应 · 最多 \(room["max_replies"].int) 位" : "已点名 \(addressed.count) 位",
              systemImage: "at")
          }
          Spacer()
          Text(model.ready ? "" : "离线内容将保存在本机").font(.caption).foregroundStyle(.secondary)
        }
        HStack(alignment: .bottom) {
          TextField("写下你的故事…", text: $content, axis: .vertical).lineLimit(2...8).textFieldStyle(
            .roundedBorder
          )
          .onChange(of: content) { _, text in model.saveDraft(room: room.id, content: text) }
          Button {
            let text = content
            content = ""
            Task {
              do {
                try await model.send(
                  room: room.id, content: text,
                  addressed: members.filter { addressed.contains($0.id) }.map(\.id))
              } catch {
                content = text
                model.report(error)
              }
            }
          } label: {
            Label("发送", systemImage: "arrow.up")
          }
          .buttonStyle(.borderedProminent).keyboardShortcut(.return, modifiers: .command).disabled(
            content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || content.count > 16000
          )
        }
      }.padding()
    }
    .navigationTitle(room.name)
    .toolbar {
      ToolbarItem {
        Button {
          editing = true
        } label: {
          Label("房间与成员", systemImage: "person.2.badge.gearshape")
        }
      }
      ToolbarItem { Button("工具审批") { activity = true } }
      ToolbarItem {
        Button {
          details = true
        } label: {
          Label("剧情", systemImage: "book.closed")
        }
      }
    }
    .onAppear { content = model.draft(room: room.id) }
    .sheet(isPresented: $editing) {
      EntityEditor(
        model: model,
        target: EditTarget(resource: "rooms", record: room, world: room["world_id"].string))
    }
    .sheet(isPresented: $activity) { ToolActivityView(model: model) }
    .sheet(isPresented: $details) { StoryView(model: model, world: room["world_id"].string) }
  }
}
func statusName(_ value: String) -> String {
  [
    "accepted": "已接收", "streaming": "回复中", "completed": "已完成", "failed": "失败", "cancelled": "已取消",
    "interrupted": "未完成", "invalidated": "已被重生成替代",
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
