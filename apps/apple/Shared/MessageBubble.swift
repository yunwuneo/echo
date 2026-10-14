import CompanionCore
import SwiftUI

/// Renders typed, persisted message state; actions stay with the conversation owner.
struct MessageBubble: View {
  let message: ChatMessage
  let continuing: Bool
  let isGroup: Bool
  let width: CGFloat
  let restoreQuestion: () -> Void

  var body: some View {
    HStack(alignment: .top, spacing: EchoSpacing.sm) {
      if message.isUser {
        Spacer(minLength: EchoSpacing.xl)
      } else {
        EchoAvatar(name: message.displayName, id: message.actorID, size: EchoMetric.icon)
          .opacity(continuing ? 0 : 1).accessibilityHidden(true)
      }
      VStack(alignment: message.isUser ? .trailing : .leading, spacing: EchoSpacing.xxs) {
        if isGroup && !message.isUser && !continuing {
          Text(message.displayName).font(EchoFont.section)
            .foregroundStyle(Color.echo.identity(for: message.actorID ?? message.id))
        }
        if !message.content.isEmpty {
          Text(message.isUser ? AttributedString(message.content) : chatMarkdown(message.content))
            .font(EchoFont.body).lineSpacing(EchoMetric.lineSpacing).textSelection(.enabled)
            .foregroundStyle(message.isUser ? Color.echo.onPrimary : Color.echo.textPrimary)
            .padding(.horizontal, message.isUser ? EchoSpacing.md : 0)
            .padding(.vertical, message.isUser ? EchoSpacing.xs : 0)
            .background {
              if message.isUser {
                UnevenRoundedRectangle(
                  topLeadingRadius: EchoRadius.bubble, bottomLeadingRadius: EchoRadius.bubble,
                  bottomTrailingRadius: EchoRadius.xs,
                  topTrailingRadius: continuing ? EchoRadius.xs : EchoRadius.bubble
                )
                .fill(Color.echo.primary)
              }
            }
            .frame(
              maxWidth: message.isUser ? width * 0.78 : .infinity,
              alignment: message.isUser ? .trailing : .leading)
        }
        if message.status.isIncomplete {
          Label(
            message.isUser
              ? String(localized: "回应未完成，消息已保留") : String(localized: "TA 好像走神了 · 这条回复未完成"),
            systemImage: "exclamationmark.circle"
          )
          .font(EchoFont.caption).foregroundStyle(Color.echo.error)
          if message.isAssistant {
            Button(String(localized: "重新编辑这条提问"), action: restoreQuestion).font(EchoFont.footnote)
              .buttonStyle(.borderless)
          }
        } else if message.status == .invalidated {
          Text(String(localized: "已被新的回应替代")).font(EchoFont.caption).foregroundStyle(
            Color.echo.textSecondary)
        } else if message.status == .cancelled {
          Text(String(localized: "本次回应已停止")).font(EchoFont.caption).foregroundStyle(
            Color.echo.textSecondary)
        } else if case .unknown = message.status {
          Text(String(localized: "消息状态暂不可用，请稍后同步查看")).font(EchoFont.caption).foregroundStyle(
            Color.echo.textSecondary)
        }
      }
      if !message.isUser { Spacer(minLength: EchoSpacing.md) }
    }
    .opacity(message.status == .invalidated ? 0.55 : 1)
  }
}
