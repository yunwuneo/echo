import SwiftUI

@main
struct CompanionApp: App {
  @NSApplicationDelegateAdaptor(PushAppDelegate.self) private var delegate
  var body: some Scene {
    Window("Echo", id: "main") { FoundationView().frame(minWidth: 480, minHeight: 320) }
  }
}
