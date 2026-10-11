import SwiftUI

enum EchoMotion {
  static func message(reduceMotion: Bool) -> Animation {
    reduceMotion ? .easeInOut(duration: 0.15) : .spring(response: 0.38, dampingFraction: 0.86)
  }

  static func send(reduceMotion: Bool) -> Animation {
    reduceMotion ? .easeInOut(duration: 0.15) : .spring(response: 0.32, dampingFraction: 0.9)
  }

  static let subtle = Animation.easeInOut(duration: 0.2)
  static let typing = Animation.easeInOut(duration: 1.2)
}
