import SwiftUI

extension Color {
  static let echo = EchoPalette()
}

struct EchoPalette: Sendable {
  let primary = Color("EchoPrimary")
  let primaryPressed = Color("EchoPrimaryPressed")
  let onPrimary = Color("EchoOnPrimary")
  let primarySoft = Color("EchoPrimarySoft")
  let accent = Color("EchoAccent")
  let bg = Color("EchoBackground")
  let surface = Color("EchoSurface")
  let surfaceSunken = Color("EchoSurfaceSunken")
  let textPrimary = Color("EchoTextPrimary")
  let textSecondary = Color("EchoTextSecondary")
  let textTertiary = Color("EchoTextTertiary")
  let separator = Color("EchoSeparator")
  let border = Color("EchoBorder")
  let online = Color("EchoOnline")
  let success = Color("EchoSuccess")
  let warning = Color("EchoWarning")
  let error = Color("EchoError")
  let mauve = Color("EchoIdentityMauve")
  let slate = Color("EchoIdentitySlate")
  let moss = Color("EchoIdentityMoss")
  let gold = Color("EchoIdentityGold")
  let graphite = Color("EchoIdentityGraphite")
  let avatarLight = Color("EchoAvatarLight")
  let avatarMid = Color("EchoAvatarMid")
  let avatarDeep = Color("EchoAvatarDeep")

  func identity(for id: String) -> Color {
    let palette = [primary, mauve, slate, moss, gold, graphite]
    let value = id.utf8.reduce(UInt64(5381)) { ($0 &* 33) &+ UInt64($1) }
    return palette[Int(value % UInt64(palette.count))]
  }
}
