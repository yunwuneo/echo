import SwiftUI

struct EchoAvatar: View {
  let name: String
  var id: String? = nil
  var size: CGFloat = EchoMetric.smallAvatar

  var body: some View {
    Text(String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(1)))
      .font(size > EchoMetric.smallAvatar ? EchoFont.headline : EchoFont.footnote)
      .fontWeight(.semibold)
      .dynamicTypeSize(.large)
      .foregroundStyle(.white)
      .frame(width: size, height: size)
      .background {
        Circle().fill(
          RadialGradient(
            colors: [Color.echo.avatarLight, Color.echo.avatarMid, Color.echo.avatarDeep],
            center: .topLeading, startRadius: 0, endRadius: size))
      }
      .overlay { Circle().strokeBorder(Color.echo.identity(for: id ?? name).opacity(0.18)) }
      .accessibilityHidden(true)
  }
}

struct EchoSettingsRow: View {
  let title: String
  let subtitle: String
  let symbol: String
  var color: Color = Color.echo.primary
  var value: String? = nil
  var disclosure = true

  var body: some View {
    HStack(spacing: EchoSpacing.sm) {
      Image(systemName: symbol)
        .font(EchoFont.footnote.weight(.semibold))
        .dynamicTypeSize(.large)
        .foregroundStyle(.white)
        .frame(width: EchoMetric.icon, height: EchoMetric.icon)
        .background(color, in: RoundedRectangle(cornerRadius: EchoRadius.sm, style: .continuous))
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: EchoSpacing.xxs) {
        Text(title).font(EchoFont.body).foregroundStyle(Color.echo.textPrimary)
        if !subtitle.isEmpty {
          Text(subtitle).font(EchoFont.footnote).foregroundStyle(Color.echo.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      Spacer(minLength: EchoSpacing.xs)
      if let value { Text(value).font(EchoFont.callout).foregroundStyle(Color.echo.textSecondary) }
      if disclosure {
        Image(systemName: "chevron.right").font(EchoFont.caption.weight(.semibold))
          .foregroundStyle(Color.echo.textTertiary).accessibilityHidden(true)
      }
    }
    .padding(.vertical, EchoSpacing.xxs)
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
  }
}

struct EchoEmptyState: View {
  let title: String
  let description: String
  var symbol = "bubble.left.and.bubble.right"
  let actionTitle: String
  let action: () -> Void

  var body: some View {
    VStack(spacing: EchoSpacing.sm) {
      Image(systemName: symbol).font(EchoFont.title)
        .dynamicTypeSize(.large)
        .foregroundStyle(Color.echo.primary)
        .frame(width: EchoMetric.heroIcon, height: EchoMetric.heroIcon)
        .background(Color.echo.primarySoft, in: Circle()).accessibilityHidden(true)
      Text(title).font(EchoFont.title).foregroundStyle(Color.echo.textPrimary)
      Text(description).font(EchoFont.callout).foregroundStyle(Color.echo.textSecondary)
        .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
      Button(actionTitle, action: action).buttonStyle(.borderedProminent)
        .padding(.top, EchoSpacing.sm)
    }
    .padding(EchoSpacing.lg)
    .frame(maxWidth: 360)
  }
}
