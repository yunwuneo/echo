import XCTest

@MainActor final class CompanionUITests: XCTestCase {
  private let base = URL(
    string: ProcessInfo.processInfo.environment["ECHO2_UI_TEST_BASE_URL"] ?? "http://127.0.0.1:3012"
  )!
  private func control(_ path: String, method: String = "GET") async throws -> [String: Any] {
    var request = URLRequest(url: base.appendingPathComponent("__test/" + path))
    request.httpMethod = method
    let (data, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    return try JSONSerialization.jsonObject(with: data) as! [String: Any]
  }
  // Completion is server state; ordinary messages intentionally have no visible completion label.
  private func completedConversation(marker: String, replies: Int) async throws -> (
    user: String, reply: String
  ) {
    let deadline = Date().addingTimeInterval(40)
    while Date() < deadline {
      let messages = try await control("state")["messages"] as? [[String: Any]] ?? []
      if let index = messages.firstIndex(where: { ($0["content"] as? String) == marker }),
        messages[index]["status"] as? String == "completed"
      {
        let response = messages.dropFirst(index + 1).prefix { ($0["role"] as? String) != "user" }
          .filter {
            ($0["role"] as? String) == "assistant" && ($0["status"] as? String) == "completed"
          }
        if response.count >= replies, let reply = response.last?["id"] as? String {
          return (messages[index]["id"] as! String, reply)
        }
      }
      try await Task.sleep(for: .seconds(1))
    }
    XCTFail("Expected a persisted message and \(replies) completed replies for \(marker)")
    throw NSError(domain: "EchoUITest", code: 1)
  }

  private func attach(_ app: XCUIApplication, name: String) {
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = name
    shot.lifetime = .keepAlways
    add(shot)
  }

  private func designApp(
    dark: Bool = false, large: Bool = false, reducedMotion: Bool = false
  ) async throws -> XCUIApplication {
    _ = try await control("online", method: "POST")
    let code = try await control("code")["code"] as! String
    let app = XCUIApplication()
    app.launchEnvironment["ECHO2_UI_TEST_URL"] = base.absoluteString
    app.launchEnvironment["ECHO2_UI_TEST_CODE"] = code
    app.launchEnvironment["ECHO2_UI_TEST_RESET"] = "1"
    app.launchEnvironment["ECHO2_UI_TEST_DRAFT"] = ""
    if dark { app.launchEnvironment["ECHO2_UI_TEST_DARK"] = "1" }
    if reducedMotion { app.launchEnvironment["ECHO2_UI_TEST_REDUCE_MOTION"] = "1" }
    app.launchArguments = [
      "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN",
      "-AppleInterfaceStyle", dark ? "Dark" : "Light",
    ]
    if large {
      app.launchArguments += [
        "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL",
      ]
    }
    app.launch()
    let pair = app.buttons["配对"]
    // A grouped Form can keep rows outside the accessibility tree until scrolled into view.
    _ = pair.waitForExistence(timeout: 3)
    for _ in 0..<8 {
      if pair.exists && pair.isHittable { break }
      let form = app.scrollViews.firstMatch
      if form.exists { form.swipeUp() } else { app.swipeUp() }
    }
    if !pair.exists || !pair.isHittable { attach(app, name: "UI 优化 · 配对定位失败现场") }
    XCTAssertTrue(pair.exists && pair.isHittable)
    pair.tap()
    waitForRoot(app)
    app.launchEnvironment.removeValue(forKey: "ECHO2_UI_TEST_RESET")
    return app
  }

  private func waitForRoot(_ app: XCUIApplication) {
    #if os(iOS)
      XCTAssertTrue(app.tabBars.buttons["聊天"].waitForExistence(timeout: 20))
    #else
      XCTAssertTrue(app.buttons["设置"].firstMatch.waitForExistence(timeout: 20))
    #endif
  }

  private func selectTab(_ title: String, in app: XCUIApplication) {
    // Native iOS 26+ minimization exposes the selected tab as a collapsed
    // popup. Expand that system control before looking for the other tabs.
    let collapsed = app.tabBars.descendants(matching: .any)
      .matching(NSPredicate(format: "value == %@", "已折叠")).firstMatch
    if collapsed.exists && collapsed.isHittable { collapsed.tap() }
    let tab = app.tabBars.buttons[title]
    XCTAssertTrue(tab.waitForExistence(timeout: 10))
    tab.tap()
  }

  private func openSettings(_ app: XCUIApplication) {
    #if os(iOS)
      selectTab("我", in: app)
    #else
      app.buttons["设置"].firstMatch.tap()
    #endif
  }

  private func tapSettingsOption(_ identifier: String, in app: XCUIApplication) {
    let option = app.buttons[identifier].firstMatch
    for _ in 0..<10 where !option.isHittable { app.swipeUp() }
    XCTAssertTrue(option.waitForExistence(timeout: 10))
    XCTAssertTrue(option.isHittable)
    option.tap()
  }

  private func closeSettings(_ app: XCUIApplication) {
    #if os(iOS)
      selectTab("聊天", in: app)
    #else
      app.buttons["close-settings"].tap()
    #endif
  }

  private func openWorldSettings(_ app: XCUIApplication) {
    #if os(iOS)
      selectTab("TA", in: app)
      let settings = app.buttons["partner-settings"].firstMatch
      for _ in 0..<6 where !settings.isHittable { app.swipeUp() }
      XCTAssertTrue(settings.waitForExistence(timeout: 10))
      settings.tap()
    #else
      let manage = app.buttons["管理「星港联调」"].firstMatch
      XCTAssertTrue(manage.waitForExistence(timeout: 20))
      manage.tap()
    #endif
  }

  private func returnFromChat(_ app: XCUIApplication) {
    app.navigationBars.buttons.element(boundBy: 0).tap()
    waitForRoot(app)
  }

  private func openDesignRoom(_ app: XCUIApplication, name: String) {
    let room = app.buttons[name].firstMatch
    let title = app.staticTexts[name].firstMatch
    XCTAssertTrue(room.waitForExistence(timeout: 20) || title.exists)
    if room.exists { room.tap() } else { title.tap() }
    XCTAssertTrue(app.descendants(matching: .any)["chat-input"].waitForExistence(timeout: 10))
  }

  private func sendDesignMessage(_ app: XCUIApplication, marker: String, replies: Int) async throws
    -> String
  {
    let input = app.descendants(matching: .any)["chat-input"].firstMatch
    input.tap()
    input.typeText(marker)
    app.buttons["send-message"].tap()
    let state = try await completedConversation(marker: marker, replies: replies)
    let reply = app.descendants(matching: .any)["message-" + state.reply]
    XCTAssertTrue(reply.waitForExistence(timeout: 20))
    // Existence alone also succeeds for messages laid out behind the navigation bar.
    // Do not scroll here: sending should reveal the latest reply without manual intervention.
    let visibilityDeadline = Date().addingTimeInterval(5)
    while Date() < visibilityDeadline && !reply.isHittable {
      try await Task.sleep(for: .milliseconds(250))
    }
    if !reply.isHittable { attach(app, name: "UI 优化 · 最新回复未显示") }
    XCTAssertTrue(reply.isHittable, "Latest reply must be visible after sending")
    return state.reply
  }

  func testDockTabsSearchAndDetailNavigation() async throws {
    #if os(iOS)
      continueAfterFailure = false
      _ = try await control("design-live-clear", method: "POST")
      let app = try await designApp()
      XCTAssertEqual(app.tabBars.buttons.count, 4)
      for name in ["聊天", "回忆", "TA", "我"] {
        XCTAssertTrue(app.tabBars.buttons[name].isHittable)
      }
      XCTAssertFalse(app.descendants(matching: .any)["live-status-accessory"].exists)
      attach(app, name: "Dock v2 · 浅色空闲无状态条")
      selectTab("回忆", in: app)
      XCTAssertTrue(app.navigationBars["回忆"].waitForExistence(timeout: 5))
      attach(app, name: "Dock v2 · 回忆")
      selectTab("TA", in: app)
      XCTAssertTrue(app.buttons["partner-settings"].firstMatch.waitForExistence(timeout: 5))
      attach(app, name: "Dock v2 · TA")
      openSettings(app)
      XCTAssertTrue(app.buttons["open-notifications"].waitForExistence(timeout: 5))
      attach(app, name: "Dock v2 · 我")
      selectTab("聊天", in: app)
      let search = app.searchFields.firstMatch
      if !search.isHittable { app.swipeDown() }
      XCTAssertTrue(search.waitForExistence(timeout: 5))
      search.tap()
      search.typeText("私聊")
      XCTAssertTrue(app.buttons["阿岚私聊"].firstMatch.waitForExistence(timeout: 5))
      XCTAssertFalse(app.buttons["舰桥群聊"].exists)
      attach(app, name: "Dock v2 · 聊天搜索")
      search.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 2))
      let cancelSearch = app.buttons["取消"].firstMatch
      if cancelSearch.exists {
        cancelSearch.tap()
      } else if app.buttons["Cancel"].firstMatch.exists {
        app.buttons["Cancel"].firstMatch.tap()
      }
      openDesignRoom(app, name: "阿岚私聊")
      XCTAssertFalse(app.tabBars.firstMatch.isHittable, "Dock must be hidden in chat details")
      attach(app, name: "Dock v2 · 详情隐藏 Dock")
      returnFromChat(app)
      let restoredDock = NSPredicate(format: "hittable == true")
      let dockRestored = XCTNSPredicateExpectation(
        predicate: restoredDock, object: app.tabBars.buttons["聊天"])
      XCTAssertEqual(XCTWaiter.wait(for: [dockRestored], timeout: 5), .completed)
      XCTAssertFalse(app.descendants(matching: .any)["live-status-accessory"].exists)
    #endif
  }

  func testDockLiveStatusOpensConversationAndDisappears() async throws {
    #if os(iOS)
      continueAfterFailure = false
      _ = try await control("design-live-clear", method: "POST")
      let app = try await designApp()
      _ = try await control("design-live-start", method: "POST")
      let status = app.descendants(matching: .any)["live-status-accessory"].firstMatch
      let hasStatus = status.waitForExistence(timeout: 15)
      if !hasStatus { print(app.debugDescription) }
      XCTAssertTrue(hasStatus)
      XCTAssertTrue(status.label.contains("阿岚"))
      XCTAssertTrue(status.label.contains("正在"))
      for technicalWord in ["AI", "生成", "模型", "MCP"] {
        XCTAssertFalse(status.label.contains(technicalWord))
      }
      attach(app, name: "Dock v2 · 真实回应状态")
      status.tap()
      XCTAssertTrue(app.descendants(matching: .any)["chat-input"].waitForExistence(timeout: 10))
      XCTAssertFalse(app.tabBars.firstMatch.isHittable)
      _ = try await control("design-live-clear", method: "POST")
      returnFromChat(app)
      XCTAssertTrue(status.waitForNonExistence(timeout: 10))
      attach(app, name: "Dock v2 · 状态结束后恢复无空条")
    #endif
  }

  func testDockApprovalAccessoryOpensRealApproval() async throws {
    #if os(iOS)
      continueAfterFailure = false
      _ = try await control("design-live-clear", method: "POST")
      let initialCalls = try await control("state")["mcp_calls"] as? Int ?? 0
      _ = try await control("p4-seed", method: "POST")
      let app = try await designApp()
      let status = app.descendants(matching: .any)["live-status-accessory"].firstMatch
      let hasStatus = status.waitForExistence(timeout: 15)
      if !hasStatus { print(app.debugDescription) }
      XCTAssertTrue(hasStatus)
      XCTAssertTrue(status.label.contains("同意"))
      XCTAssertFalse(status.label.contains("MCP"))
      attach(app, name: "Dock v2 · 待你决定")
      status.tap()
      let approve = app.buttons["approve-tool"].firstMatch
      XCTAssertTrue(approve.waitForExistence(timeout: 10))
      XCTAssertTrue(
        app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "模拟器审批测试")).firstMatch
          .exists)
      attach(app, name: "Dock v2 · 审批参数")
      let beforeApproval = try await control("state")
      XCTAssertEqual(beforeApproval["mcp_calls"] as? Int, initialCalls)
      approve.tap()
      let deadline = Date().addingTimeInterval(20)
      var calls = initialCalls
      while Date() < deadline {
        calls = try await control("state")["mcp_calls"] as? Int ?? 0
        if calls == initialCalls + 1 { break }
        try await Task.sleep(for: .milliseconds(250))
      }
      XCTAssertEqual(calls, initialCalls + 1)
      app.buttons["完成"].firstMatch.tap()
      XCTAssertTrue(status.waitForNonExistence(timeout: 15))
      _ = try await control("design-live-clear", method: "POST")
    #endif
  }

  func testDockMemoriesShowSyncedSource() async throws {
    #if os(iOS)
      continueAfterFailure = false
      _ = try await control("design-live-clear", method: "POST")
      _ = try await control("p3-seed", method: "POST")
      let app = try await designApp()
      selectTab("回忆", in: app)
      let memory = app.buttons["memory-timeline-item"].firstMatch
      XCTAssertTrue(memory.waitForExistence(timeout: 10))
      attach(app, name: "Dock v2 · 有来源的真实回忆")
      memory.tap()
      let momentAppeared = app.navigationBars["一段回忆"].waitForExistence(timeout: 10)
      if !momentAppeared {
        attach(app, name: "Dock v2 · 回忆详情定位失败")
        print(app.debugDescription)
      }
      XCTAssertTrue(momentAppeared)
      let original = app.buttons["回到这段聊天"].firstMatch
      XCTAssertTrue(original.waitForExistence(timeout: 5))
      attach(app, name: "Dock v2 · 回忆中的原话")
      original.tap()
      XCTAssertTrue(app.descendants(matching: .any)["chat-input"].waitForExistence(timeout: 10))
      XCTAssertFalse(app.tabBars.firstMatch.isHittable)
    #endif
  }

  func testDockDarkLargeTextReducedMotion() async throws {
    #if os(iOS)
      continueAfterFailure = false
      _ = try await control("design-live-clear", method: "POST")
      let app = try await designApp(dark: true, large: true, reducedMotion: true)
      for name in ["聊天", "回忆", "TA", "我"] {
        XCTAssertTrue(app.tabBars.buttons[name].isHittable)
      }
      attach(app, name: "Dock v2 · 深色最大字体减弱动态效果")
      _ = try await control("design-live-start", method: "POST")
      let status = app.descendants(matching: .any)["quiet-live-status"].firstMatch
      let hasStatus = status.waitForExistence(timeout: 15)
      if !hasStatus { print(app.debugDescription) }
      XCTAssertTrue(hasStatus)
      XCTAssertTrue(status.isHittable)
      XCTAssertTrue(status.label.contains("阿岚"))
      attach(app, name: "Dock v2 · 深色最大字体实时状态")
      try app.performAccessibilityAudit(for: [.sufficientElementDescription, .textClipped])
      status.tap()
      XCTAssertTrue(app.buttons["send-message"].waitForExistence(timeout: 10))
      XCTAssertFalse(app.tabBars.firstMatch.isHittable)
      _ = try await control("design-live-clear", method: "POST")
    #endif
  }

  func testDockOpenMemoryClosesAfterRemoteForgetting() async throws {
    #if os(iOS)
      continueAfterFailure = false
      _ = try await control("design-live-clear", method: "POST")
      _ = try await control("p3-seed", method: "POST")
      let app = try await designApp()
      selectTab("回忆", in: app)
      let memory = app.buttons["memory-timeline-item"].firstMatch
      XCTAssertTrue(memory.waitForExistence(timeout: 10))
      memory.tap()
      let momentAppeared = app.navigationBars["一段回忆"].waitForExistence(timeout: 10)
      if !momentAppeared {
        attach(app, name: "Dock v2 · 回忆详情定位失败")
        print(app.debugDescription)
      }
      XCTAssertTrue(momentAppeared)
      _ = try await control("design-forget-memories", method: "POST")
      XCTAssertTrue(app.navigationBars["一段回忆"].waitForNonExistence(timeout: 20))
      XCTAssertFalse(app.buttons["memory-timeline-item"].exists)
      XCTAssertTrue(app.staticTexts["回忆从聊天开始"].waitForExistence(timeout: 10))
      attach(app, name: "Dock v2 · 跨端遗忘关闭旧回忆")
    #endif
  }

  func testDockSwitchServerClearsChatNavigation() async throws {
    #if os(iOS)
      continueAfterFailure = false
      _ = try await control("design-live-clear", method: "POST")
      let app = try await designApp()
      openDesignRoom(app, name: "阿岚私聊")
      // Exercise the visible iOS settings route after visiting a conversation.
      returnFromChat(app)
      openSettings(app)
      let change = app.buttons["切换服务器"].firstMatch
      XCTAssertTrue(change.waitForExistence(timeout: 10))
      change.tap()
      XCTAssertTrue(app.buttons["配对"].waitForExistence(timeout: 10))
      let code = try await control("code")["code"] as! String
      let codeField = app.secureTextFields["一次性配对码"]
      XCTAssertTrue(codeField.waitForExistence(timeout: 5))
      codeField.tap()
      let existingCodeLength = (codeField.value as? String ?? "").count
      codeField.typeText(
        String(repeating: XCUIKeyboardKey.delete.rawValue, count: existingCodeLength) + code)
      let pair = app.buttons["配对"]
      for _ in 0..<6 where !pair.isHittable { app.swipeUp() }
      pair.tap()
      waitForRoot(app)
      XCTAssertFalse(app.descendants(matching: .any)["chat-input"].exists)
      XCTAssertTrue(app.buttons["阿岚私聊"].firstMatch.waitForExistence(timeout: 10))
      attach(app, name: "Dock v2 · 切换服务器清除详情路径")
    #endif
  }

  func testDockScrollKeepsLiveStatusAccessible() async throws {
    #if os(iOS)
      continueAfterFailure = false
      _ = try await control("design-live-clear", method: "POST")
      _ = try await control("design-scroll-rooms", method: "POST")
      let app = try await designApp()
      _ = try await control("design-live-start", method: "POST")
      let status = app.descendants(matching: .any)["live-status-accessory"].firstMatch
      XCTAssertTrue(status.waitForExistence(timeout: 15))
      app.descendants(matching: .any)["chat-list"].firstMatch.swipeUp()
      app.descendants(matching: .any)["chat-list"].firstMatch.swipeUp()
      XCTAssertTrue(status.isHittable)
      attach(app, name: "Dock v2 · 下滑后系统收起状态")
      status.tap()
      XCTAssertTrue(app.descendants(matching: .any)["chat-input"].waitForExistence(timeout: 10))
      _ = try await control("design-live-clear", method: "POST")
    #endif
  }

  func testDockSystemReducedTransparency() async throws {
    #if os(iOS)
      continueAfterFailure = false
      let preferences = XCUIApplication(bundleIdentifier: "com.apple.Preferences")
      preferences.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
      preferences.launch()
      let accessibility = preferences.staticTexts["Accessibility"].firstMatch
      for _ in 0..<10 where !accessibility.isHittable { preferences.swipeUp() }
      XCTAssertTrue(accessibility.waitForExistence(timeout: 5))
      accessibility.tap()
      let display = preferences.staticTexts["Display & Text Size"].firstMatch
      XCTAssertTrue(display.waitForExistence(timeout: 5))
      display.tap()
      let transparency = preferences.switches["Reduce Transparency"].firstMatch
      for _ in 0..<6 where !transparency.isHittable { preferences.swipeUp() }
      XCTAssertTrue(transparency.waitForExistence(timeout: 5))
      let original = transparency.value as? String
      addTeardownBlock { @MainActor in
        preferences.activate()
        if transparency.exists && transparency.value as? String != original {
          transparency.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        }
        XCTAssertEqual(transparency.value as? String, original)
        preferences.terminate()
      }
      if original != "1" {
        transparency.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
      }
      XCTAssertEqual(transparency.value as? String, "1")
      attach(preferences, name: "Dock v2 · 系统降低透明度已开启")
      _ = try await control("design-live-clear", method: "POST")
      let app = try await designApp(dark: true)
      XCTAssertTrue(app.tabBars.buttons["聊天"].isHittable)
      _ = try await control("design-live-start", method: "POST")
      let status = app.descendants(matching: .any)["live-status-accessory"].firstMatch
      let hasStatus = status.waitForExistence(timeout: 15)
      if !hasStatus { print(app.debugDescription) }
      XCTAssertTrue(hasStatus)
      XCTAssertTrue(status.isHittable)
      attach(app, name: "Dock v2 · 系统降低透明度深色状态条")
      try app.performAccessibilityAudit(for: [.sufficientElementDescription])
      _ = try await control("design-live-clear", method: "POST")
    #endif
  }

  func testUIRefreshLightChatAndForms() async throws {
    #if os(iOS)
      continueAfterFailure = false
      let app = try await designApp()
      attach(app, name: "UI 优化 · 浅色会话列表")
      openDesignRoom(app, name: "阿岚私聊")
      let reply = try await sendDesignMessage(
        app, marker: "今天也想分享一个小故事-" + UUID().uuidString.prefix(6), replies: 1)
      XCTAssertFalse(app.buttons["谁来回应 · 自动"].exists)
      XCTAssertFalse(app.staticTexts["已完成"].exists)
      XCTAssertFalse(app.buttons["换一种回答"].exists)
      attach(app, name: "UI 优化 · 浅色一对一聊天")
      app.descendants(matching: .any)["message-" + reply].press(forDuration: 1)
      XCTAssertTrue(app.buttons["换一种回答"].waitForExistence(timeout: 5))
      XCTAssertTrue(app.buttons["复制"].exists)
      attach(app, name: "UI 优化 · 回复长按菜单")
      app.terminate()
      app.launch()
      openDesignRoom(app, name: "舰桥群聊")
      _ = try await sendDesignMessage(
        app, marker: "大家今天过得怎么样-" + UUID().uuidString.prefix(6), replies: 3)
      XCTAssertTrue(app.buttons["谁来回应 · 自动"].exists)
      attach(app, name: "UI 优化 · 浅色三角色群聊")
      app.buttons["聊天选项"].tap()
      app.buttons["主动消息设置"].tap()
      XCTAssertTrue(app.switches["autonomy-enabled"].waitForExistence(timeout: 10))
      attach(app, name: "UI 优化 · 主动消息设置")
      let daily = app.staticTexts["每日请求次数"].firstMatch
      for _ in 0..<6 where !daily.isHittable { app.swipeUp() }
      XCTAssertTrue(daily.isHittable)
      let inputBudget = app.staticTexts["每日输入上限"].firstMatch
      for _ in 0..<6 where !inputBudget.isHittable { app.swipeUp() }
      XCTAssertTrue(inputBudget.isHittable)
      XCTAssertTrue(app.buttons["save-autonomy"].isHittable)
      attach(app, name: "UI 优化 · 带标签的每日预算")
    #endif
  }

  func testUIRefreshDarkChat() async throws {
    #if os(iOS)
      continueAfterFailure = false
      let app = try await designApp(dark: true)
      openDesignRoom(app, name: "阿岚私聊")
      _ = try await sendDesignMessage(
        app, marker: "夜深了，晚安-" + UUID().uuidString.prefix(6), replies: 1)
      XCTAssertFalse(app.staticTexts["已完成"].exists)
      attach(app, name: "UI 优化 · 深色一对一聊天")
    #endif
  }

  func testUIRefreshLargeText() async throws {
    #if os(iOS)
      continueAfterFailure = false
      let app = try await designApp(dark: true, large: true)
      attach(app, name: "UI 优化 · 深色最大动态字体列表")
      openDesignRoom(app, name: "阿岚私聊")
      let replyID = try await sendDesignMessage(
        app, marker: "大字阅读-" + UUID().uuidString.prefix(6), replies: 1)
      XCTAssertTrue(app.buttons["send-message"].isHittable)
      XCTAssertTrue(app.buttons["聊天选项"].isHittable)
      attach(app, name: "UI 优化 · 深色最大动态字体聊天")
      let history = app.scrollViews["chat-history"]
      let returnToLatest = app.buttons["return-to-latest"]
      for _ in 0..<3 where !returnToLatest.isHittable { history.swipeDown() }
      XCTAssertTrue(
        returnToLatest.isHittable, "Reading history must expose a way back to the latest message")
      returnToLatest.tap()
      let latest = app.descendants(matching: .any)["message-" + replyID]
      let deadline = Date().addingTimeInterval(5)
      while Date() < deadline && !latest.isHittable {
        try await Task.sleep(for: .milliseconds(250))
      }
      XCTAssertTrue(latest.isHittable, "Return to latest must reveal the last reply")
    #endif
  }

  func testUIRefreshLongDraftExplainsLimit() async throws {
    #if os(iOS)
      continueAfterFailure = false
      let app = try await designApp()
      app.terminate()
      app.launchEnvironment["ECHO2_UI_TEST_DRAFT"] = String(repeating: "字", count: 16_001)
      app.launch()
      openDesignRoom(app, name: "阿岚私聊")
      let limit = app.staticTexts["message-length"]
      XCTAssertTrue(limit.waitForExistence(timeout: 10))
      XCTAssertEqual(limit.label, "超出 1 字，删减后可发送")
      XCTAssertFalse(app.buttons["send-message"].isEnabled)
      attach(app, name: "UI 优化 · 超长消息说明")
      // Replace only this synthetic draft through the same DEBUG fixture hook.
      app.terminate()
      app.launchEnvironment["ECHO2_UI_TEST_DRAFT"] = ""
      app.launch()
      openDesignRoom(app, name: "阿岚私聊")
      XCTAssertFalse(app.staticTexts["message-length"].exists)
    #endif
  }
  func testP6LargeTextDarkModeAccessibility() async throws {
    #if os(iOS)
      continueAfterFailure = false
      _ = try await control("online", method: "POST")
      let code = try await control("code")["code"] as! String
      let app = XCUIApplication()
      app.launchEnvironment["ECHO2_UI_TEST_URL"] = base.absoluteString
      app.launchEnvironment["ECHO2_UI_TEST_CODE"] = code
      app.launchEnvironment["ECHO2_UI_TEST_RESET"] = "1"
      app.launchEnvironment["ECHO2_UI_TEST_DARK"] = "1"
      app.launchArguments = [
        "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN", "-AppleInterfaceStyle", "Dark",
        "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL",
      ]
      app.launch()
      XCTAssertTrue(app.buttons["配对"].waitForExistence(timeout: 15))
      for _ in 0..<4 where !app.buttons["配对"].isHittable { app.swipeUp() }
      let connectionShot = XCTAttachment(screenshot: app.screenshot())
      connectionShot.name = "P6 深色最大动态字体配对"
      connectionShot.lifetime = .keepAlways
      add(connectionShot)
      app.buttons["配对"].tap()
      waitForRoot(app)
      try app.performAccessibilityAudit(for: [.sufficientElementDescription, .textClipped])
      openSettings(app)
      XCTAssertTrue(app.buttons["open-notifications"].waitForExistence(timeout: 10))
      app.buttons["open-notifications"].tap()
      XCTAssertTrue(app.buttons["close-notifications"].waitForExistence(timeout: 10))
      try app.performAccessibilityAudit(for: [.sufficientElementDescription, .textClipped])
      let shot = XCTAttachment(screenshot: app.screenshot())
      shot.name = "P6 深色最大动态字体通知"
      shot.lifetime = .keepAlways
      add(shot)
    #endif
  }
  func testP5NotificationSettingsExportAndColdStartRoute() async throws {
    continueAfterFailure = true
    _ = try await control("online", method: "POST")
    let code = try await control("code")["code"] as! String
    let app = XCUIApplication()
    app.launchEnvironment["ECHO2_UI_TEST_URL"] = base.absoluteString
    app.launchEnvironment["ECHO2_UI_TEST_CODE"] = code
    app.launchEnvironment["ECHO2_UI_TEST_RESET"] = "1"
    app.launchArguments = ["-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
    app.launch()
    XCTAssertTrue(app.buttons["配对"].waitForExistence(timeout: 15))
    app.buttons["配对"].tap()
    waitForRoot(app)
    openSettings(app)
    app.buttons["open-notifications"].tap()
    XCTAssertTrue(app.staticTexts["服务器尚未配置通知中继，仍可正常聊天与同步。"].waitForExistence(timeout: 10))
    let notificationShot = XCTAttachment(screenshot: app.screenshot())
    notificationShot.name = "P5 通知关闭时业务仍可用"
    notificationShot.lifetime = .keepAlways
    add(notificationShot)
    app.buttons["close-notifications"].tap()
    tapSettingsOption("open-operations", in: app)
    XCTAssertTrue(
      app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "0.6.0"))
        .firstMatch.waitForExistence(timeout: 10))
    let operationsShot = XCTAttachment(screenshot: app.screenshot())
    operationsShot.name = "P5 数据导出与诊断"
    operationsShot.lifetime = .keepAlways
    add(operationsShot)
    app.buttons["导出我的数据"].tap()
    let save = app.buttons["DOCPicker.actionButton"]
    XCTAssertTrue(save.waitForExistence(timeout: 20))
    let exportPicker = XCTAttachment(screenshot: app.screenshot())
    exportPicker.name = "P5 系统导出文件选择器"
    exportPicker.lifetime = .keepAlways
    add(exportPicker)
    save.tap()
    XCTAssertTrue(save.waitForNonExistence(timeout: 15))
    XCTAssertTrue(app.buttons["close-operations"].waitForExistence(timeout: 15))
    app.buttons["close-operations"].tap()
    closeSettings(app)
    // DEBUG injection exercises the same authenticated cold-start route, without
    // asserting the simulator is a real APNs-delivered physical notification.
    let event = try await control("p5-event", method: "POST")
    app.terminate()
    app.launchEnvironment.removeValue(forKey: "ECHO2_UI_TEST_RESET")
    app.launchEnvironment["ECHO2_UI_TEST_PUSH"] = String(
      data: try JSONSerialization.data(withJSONObject: event), encoding: .utf8)
    app.launch()
    XCTAssertTrue(
      app.descendants(matching: .any)["message-" + (event["message_id"] as! String)]
        .waitForExistence(timeout: 25))
    let route = XCTAttachment(screenshot: app.screenshot())
    route.name = "P5 冷启动通知认证后跳转原文"
    route.lifetime = .keepAlways
    add(route)
  }
  func testPairChatOfflineRestartAndRejoin() async throws {
    continueAfterFailure = false
    _ = try await control("online", method: "POST")
    let code = try await control("code")["code"] as! String
    let app = XCUIApplication()
    app.launchEnvironment["ECHO2_UI_TEST_URL"] = base.absoluteString
    app.launchEnvironment["ECHO2_UI_TEST_CODE"] = code
    app.launchEnvironment["ECHO2_UI_TEST_RESET"] = "1"
    app.launchArguments = ["-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
    app.launch()
    XCTAssertTrue(app.buttons["配对"].waitForExistence(timeout: 15))
    app.buttons["配对"].tap()
    openDesignRoom(app, name: "舰桥群聊")
    let composer = app.textFields["chat-input"].firstMatch
    let textView = app.textViews.firstMatch
    #if os(macOS)
      let marker = "Mac联调-" + UUID().uuidString.prefix(6)
    #else
      let marker = "iOS联调-" + UUID().uuidString.prefix(6)
    #endif
    let input = composer.waitForExistence(timeout: 5) ? composer : textView
    XCTAssertTrue(input.waitForExistence(timeout: 10))
    input.tap()
    input.typeText(marker)
    app.buttons["send-message"].tap()
    let sent = try await completedConversation(marker: marker, replies: 3)
    XCTAssertTrue(
      app.descendants(matching: .any)["message-" + sent.user]
        .descendants(matching: .staticText).matching(
          NSPredicate(format: "label CONTAINS %@", marker)
        )
        .firstMatch.waitForExistence(timeout: 25))
    let chat = XCTAttachment(screenshot: app.screenshot())
    chat.name = "群聊回复与发言者"
    chat.lifetime = .keepAlways
    add(chat)
    _ = try await control("offline", method: "POST")
    input.tap()
    input.typeText("离线-" + marker)
    app.buttons["send-message"].tap()
    XCTAssertTrue(
      app.descendants(matching: .any).matching(
        NSPredicate(format: "label CONTAINS %@", "已存到本机 · 联网后发送")
      )
      .firstMatch.waitForExistence(timeout: 10))
    app.terminate()
    app.launchEnvironment.removeValue(forKey: "ECHO2_UI_TEST_RESET")
    app.launch()
    openDesignRoom(app, name: "舰桥群聊")
    XCTAssertTrue(
      app.descendants(matching: .any).matching(
        NSPredicate(format: "label CONTAINS %@", "已存到本机 · 联网后发送")
      )
      .firstMatch.waitForExistence(timeout: 10))
    _ = try await control("online", method: "POST")
    let deadline = Date().addingTimeInterval(40)
    var count = 0
    while Date() < deadline {
      let state = try await control("state")
      let messages = state["messages"] as? [[String: Any]] ?? []
      count = messages.filter { ($0["content"] as? String) == "离线-" + marker }.count
      if count == 1 { break }
      try await Task.sleep(for: .seconds(1))
    }
    XCTAssertEqual(count, 1)
    let received = try await completedConversation(marker: "离线-" + marker, replies: 3)
    XCTAssertTrue(
      app.descendants(matching: .any)["message-" + received.user]
        .descendants(matching: .staticText).matching(
          NSPredicate(format: "label CONTAINS %@", "离线-" + marker)
        )
        .firstMatch.waitForExistence(timeout: 25))
    let restored = XCTAttachment(screenshot: app.screenshot())
    restored.name = "重启恢复后的群聊"
    restored.lifetime = .keepAlways
    add(restored)
  }
  func testP4ApprovalAutonomyAndRecap() async throws {
    continueAfterFailure = false
    _ = try await control("online", method: "POST")
    _ = try await control("p4-seed", method: "POST")
    let code = try await control("code")["code"] as! String
    let app = XCUIApplication()
    app.launchEnvironment["ECHO2_UI_TEST_URL"] = base.absoluteString
    app.launchEnvironment["ECHO2_UI_TEST_CODE"] = code
    app.launchEnvironment["ECHO2_UI_TEST_RESET"] = "1"
    app.launchArguments = ["-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
    app.launch()
    XCTAssertTrue(app.buttons["配对"].waitForExistence(timeout: 15))
    app.buttons["配对"].tap()
    waitForRoot(app)
    openSettings(app)
    tapSettingsOption("open-activity", in: app)
    let approve = app.buttons["approve-tool"].firstMatch
    XCTAssertTrue(approve.waitForExistence(timeout: 10))
    let initialState = try await control("state")
    let initialCalls = initialState["mcp_calls"] as? Int ?? 0
    let approval = XCTAttachment(screenshot: app.screenshot())
    approval.name = "具体工具审批参数"
    approval.lifetime = .keepAlways
    add(approval)
    approve.tap()
    let until = Date().addingTimeInterval(20)
    var count = 0
    while Date() < until {
      count = try await control("state")["mcp_calls"] as? Int ?? 0
      if count == initialCalls + 1 { break }
      try await Task.sleep(for: .seconds(1))
    }
    XCTAssertEqual(count, initialCalls + 1)
    app.buttons["完成"].firstMatch.tap()
    closeSettings(app)
    openWorldSettings(app)
    app.buttons["open-autonomy"].tap()
    let enabled = app.switches["autonomy-enabled"].firstMatch
    XCTAssertTrue(enabled.waitForExistence(timeout: 10))
    XCTAssertEqual(enabled.value as? String, "0")
    enabled.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
    XCTAssertEqual(enabled.value as? String, "1")
    app.buttons["save-autonomy"].tap()
    XCTAssertTrue(app.buttons["open-recaps"].waitForExistence(timeout: 10))
    let state = try await control("state")
    XCTAssertEqual((state["policy"] as? [String: Any])?["enabled"] as? Bool, true)
    app.terminate()
    _ = try await control("p4-background", method: "POST")
    let deadline = Date().addingTimeInterval(20)
    var hasRecap = false
    while Date() < deadline {
      let value = try await control("state")
      hasRecap = !((value["recaps"] as? [String: Any])?["items"] as? [[String: Any]] ?? []).isEmpty
      if hasRecap { break }
      try await Task.sleep(for: .seconds(1))
    }
    XCTAssertTrue(hasRecap)
    app.launchEnvironment.removeValue(forKey: "ECHO2_UI_TEST_RESET")
    app.launch()
    waitForRoot(app)
    openWorldSettings(app)
    app.buttons["open-recaps"].tap()
    let recap = app.buttons["recap-item"].firstMatch
    XCTAssertTrue(recap.waitForExistence(timeout: 10))
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = "客户端关闭后的真实回顾"
    shot.lifetime = .keepAlways
    add(shot)
    recap.tap()
    XCTAssertTrue(app.buttons["返回回顾"].waitForExistence(timeout: 10))
    XCTAssertTrue(
      app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "星港已收到"))
        .firstMatch.waitForExistence(timeout: 10))
  }
  func testMemoryCorrectionForgettingAndImportPreview() async throws {
    continueAfterFailure = false
    _ = try await control("online", method: "POST")
    _ = try await control("p3-seed", method: "POST")
    let code = try await control("code")["code"] as! String
    let app = XCUIApplication()
    app.launchEnvironment["ECHO2_UI_TEST_URL"] = base.absoluteString
    app.launchEnvironment["ECHO2_UI_TEST_CODE"] = code
    app.launchEnvironment["ECHO2_UI_TEST_RESET"] = "1"
    app.launchArguments = ["-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
    app.launch()
    XCTAssertTrue(app.buttons["配对"].waitForExistence(timeout: 15))
    app.buttons["配对"].tap()
    waitForRoot(app)
    openWorldSettings(app)
    app.buttons["open-memory"].tap()
    let item = app.buttons["memory-item"].firstMatch
    XCTAssertTrue(item.waitForExistence(timeout: 15))
    item.tap()
    let field = app.descendants(matching: .any).matching(identifier: "memory-content").firstMatch
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    field.tap()
    field.typeText("，这是合成测试")
    app.buttons["save-memory"].tap()
    XCTAssertTrue(item.waitForExistence(timeout: 10))
    let state = try await control("state")
    let memories = state["memories"] as! [[String: Any]]
    let edited = try XCTUnwrap(
      memories.first {
        ($0["content"] as? String)?.contains("合成测试") == true && ($0["manual"] as? Bool) == true
      })
    item.tap()
    let forget = app.buttons["forget-memory"]
    for _ in 0..<6 {
      if forget.isHittable { break }
      app.swipeUp()
    }
    XCTAssertTrue(forget.exists)
    forget.tap()
    app.buttons["确认忘记"].tap()
    XCTAssertTrue(app.buttons["forget-memory"].waitForNonExistence(timeout: 15))
    let afterForgetting = try await control("state")["memories"] as? [[String: Any]] ?? []
    let forgotten = afterForgetting.first { $0["id"] as? String == edited["id"] as? String }
    XCTAssertEqual(forgotten?["status"] as? String, "deleted")
    XCTAssertEqual(forgotten?["content"] as? String, "")
    app.navigationBars["记忆与来源"].buttons["完成"].tap()
    app.buttons["open-import"].tap()
    let json = app.descendants(matching: .any).matching(identifier: "import-json").firstMatch
    XCTAssertTrue(json.waitForExistence(timeout: 10))
    json.tap()
    let importName = "测试领航员-" + UUID().uuidString.prefix(6)
    json.typeText(
      #"{"spec":"chara_card_v2","spec_version":"2.0","data":{"name":"\#(importName)","description":"合成角色","system_prompt":"只用合成航海术语","extensions":{"unknown":true}}}"#
    )
    app.buttons["preview-import"].tap()
    let suggestion = app.switches["启用这些角色提示建议"]
    for _ in 0..<8 {
      if suggestion.isHittable { break }
      app.swipeUp()
    }
    XCTAssertTrue(suggestion.waitForExistence(timeout: 10))
    XCTAssertEqual(suggestion.value as? String, "0")
    suggestion.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
    XCTAssertEqual(suggestion.value as? String, "1")
    let commit = app.buttons["commit-import"]
    for _ in 0..<8 {
      if commit.isHittable { break }
      app.swipeUp()
    }
    XCTAssertTrue(commit.waitForExistence(timeout: 10))
    let preview = XCTAttachment(screenshot: app.screenshot())
    preview.name = "P3 导入预览与兼容报告"
    preview.lifetime = .keepAlways
    add(preview)
    commit.tap()
    XCTAssertTrue(app.alerts["导入已完成"].waitForExistence(timeout: 15))
    app.alerts["导入已完成"].buttons["好"].tap()
    let download = app.buttons["保存原始文件（含未知扩展）"]
    for _ in 0..<6 {
      if download.isHittable { break }
      app.swipeUp()
    }
    XCTAssertTrue(download.waitForExistence(timeout: 10))
    let completed = try await control("state")
    XCTAssertGreaterThanOrEqual(completed["import_count"] as! Int, 1)
    let importedCharacters = completed["imported_characters"] as! [[String: Any]]
    let importedCharacter = try XCTUnwrap(
      importedCharacters.first { $0["name"] as? String == String(importName) })
    XCTAssertEqual(importedCharacter["suggestions_enabled"] as? Bool, true)
    let final = XCTAttachment(screenshot: app.screenshot())
    final.name = "P3 导入完成"
    final.lifetime = .keepAlways
    add(final)
  }

}
