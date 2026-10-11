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
      app.launchArguments = ["-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN", "-AppleInterfaceStyle", "Dark", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
      app.launch()
      XCTAssertTrue(app.buttons["配对"].waitForExistence(timeout: 15))
      for _ in 0..<4 where !app.buttons["配对"].isHittable { app.swipeUp() }
      let connectionShot = XCTAttachment(screenshot: app.screenshot())
      connectionShot.name = "P6 深色最大动态字体配对"
      connectionShot.lifetime = .keepAlways
      add(connectionShot)
      app.buttons["配对"].tap()
      XCTAssertTrue(app.buttons["设置"].firstMatch.waitForExistence(timeout: 20))
      try app.performAccessibilityAudit(for: [.sufficientElementDescription, .textClipped])
      app.buttons["设置"].firstMatch.tap()
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
    XCTAssertTrue(app.buttons["设置"].firstMatch.waitForExistence(timeout: 20))
    app.buttons["设置"].firstMatch.tap()
    app.buttons["open-notifications"].tap()
    XCTAssertTrue(app.staticTexts["服务器尚未配置通知中继，仍可正常聊天与同步。"].waitForExistence(timeout: 10))
    let notificationShot = XCTAttachment(screenshot: app.screenshot())
    notificationShot.name = "P5 通知关闭时业务仍可用"
    notificationShot.lifetime = .keepAlways
    add(notificationShot)
    app.buttons["close-notifications"].tap()
    app.buttons["open-operations"].tap()
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
    app.buttons["close-settings"].tap()
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
    let room = app.buttons["舰桥群聊"].firstMatch
    let link = app.staticTexts["舰桥群聊"].firstMatch
    XCTAssertTrue(link.waitForExistence(timeout: 20))
    if room.exists { room.tap() } else { link.tap() }
    let composer = app.textFields["写下你的故事…"].firstMatch
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
    app.buttons["发送"].tap()
    XCTAssertTrue(
      app.descendants(matching: .any).matching(
        NSPredicate(format: "label CONTAINS %@ AND value == %@", marker, "已完成")
      ).firstMatch.waitForExistence(timeout: 25))
    let chat = XCTAttachment(screenshot: app.screenshot())
    chat.name = "群聊回复与发言者"
    chat.lifetime = .keepAlways
    add(chat)
    _ = try await control("offline", method: "POST")
    input.tap()
    input.typeText("离线-" + marker)
    app.buttons["发送"].tap()
    XCTAssertTrue(
      app.descendants(matching: .any).matching(
        NSPredicate(format: "label CONTAINS %@", "待发送 · 尚未被服务器接收")
      )
      .firstMatch.waitForExistence(timeout: 10))
    app.terminate()
    app.launchEnvironment.removeValue(forKey: "ECHO2_UI_TEST_RESET")
    app.launch()
    XCTAssertTrue(link.waitForExistence(timeout: 15))
    if room.exists { room.tap() } else { link.tap() }
    XCTAssertTrue(
      app.descendants(matching: .any).matching(
        NSPredicate(format: "label CONTAINS %@", "待发送 · 尚未被服务器接收")
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
    XCTAssertTrue(
      app.descendants(matching: .any).matching(
        NSPredicate(format: "label CONTAINS %@ AND value == %@", "离线-" + marker, "已完成")
      ).firstMatch.waitForExistence(timeout: 25))
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
    let manage = app.buttons["管理「星港联调」"].firstMatch
    XCTAssertTrue(manage.waitForExistence(timeout: 20))
    app.buttons["设置"].firstMatch.tap()
    app.buttons["open-activity"].tap()
    let approve = app.buttons["approve-tool"].firstMatch
    XCTAssertTrue(approve.waitForExistence(timeout: 10))
    let initialState = try await control("state")
    XCTAssertEqual(initialState["mcp_calls"] as? Int, 0)
    let approval = XCTAttachment(screenshot: app.screenshot())
    approval.name = "具体工具审批参数"
    approval.lifetime = .keepAlways
    add(approval)
    approve.tap()
    let until = Date().addingTimeInterval(20)
    var count = 0
    while Date() < until {
      count = try await control("state")["mcp_calls"] as? Int ?? 0
      if count == 1 { break }
      try await Task.sleep(for: .seconds(1))
    }
    XCTAssertEqual(count, 1)
    app.buttons["完成"].firstMatch.tap()
    app.buttons["完成"].firstMatch.tap()
    manage.tap()
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
    XCTAssertTrue(manage.waitForExistence(timeout: 20))
    manage.tap()
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
    let manage = app.buttons["管理「星港联调」"].firstMatch
    XCTAssertTrue(manage.waitForExistence(timeout: 20))
    manage.tap()
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
    XCTAssertTrue(
      memories.contains {
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
    XCTAssertTrue(
      app.staticTexts["尚无记忆。开启整理后，服务器在积累 8 条消息或空闲 60 秒后提取；原对话仍可正常使用。"].waitForExistence(timeout: 15)
    )
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
