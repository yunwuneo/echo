import SwiftUI

@main
struct CompanionApp: App {
  @UIApplicationDelegateAdaptor(PushAppDelegate.self) private var delegate
  var body: some Scene { WindowGroup { FoundationView() } }
}
