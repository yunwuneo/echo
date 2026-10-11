import Foundation
import OpenAPIRuntime
import Testing

@testable import CompanionCore

@Test func invalidServerAddressExplainsRequiredFormat() {
  let message = userFacingError(URLError(.badURL))
  #expect(message.contains("HTTPS"))
  #expect(!message.contains("NSURLErrorDomain"))
  #expect(!message.contains("-1000"))
}

@Test func wrappedTransportFailureKeepsRecoveryWithoutRequestData() {
  let error = ClientError(
    operationID: "previewImport", operationInput: "PRIVATE_IMPORT_CONTENT",
    baseURL: URL(string: "https://private.example/secret"),
    causeDescription: "Bearer PRIVATE_KEY", underlyingError: URLError(.cannotConnectToHost))
  let message = userFacingError(error)
  #expect(message.contains("确认服务器正在运行"))
  for secret in ["PRIVATE_IMPORT_CONTENT", "PRIVATE_KEY", "private.example", "previewImport"] {
    #expect(!message.contains(secret))
  }
}

@Test func wrappedAPIErrorRetainsUsefulImportReason() {
  let error = ClientError(
    operationID: "previewImport", operationInput: "private content",
    causeDescription: "request failed",
    underlyingError: APIError(status: 400, code: "invalid_import"))
  let message = userFacingError(error)
  #expect(message.contains("角色卡或世界书"))
  #expect(message.contains("重新导出"))
  #expect(!message.contains("invalid_import"))
}

@Test func unknownErrorsNeverExposeBackendOrLocalDetails() {
  let api = APIError(status: 500, code: "secret_token_echoed_by_backend")
  #expect(!api.localizedDescription.contains("secret_token"))
  let local = NSError(
    domain: "PrivateDatabase", code: 99,
    userInfo: [NSLocalizedDescriptionKey: "/Users/private/messages.sql API_KEY=secret"])
  let message = userFacingError(local)
  #expect(message.contains("数据与诊断"))
  #expect(!message.contains("/Users/"))
  #expect(!message.contains("API_KEY"))
}

@Test func fileAndCertificateFailuresOfferSpecificRecovery() {
  #expect(userFacingError(CocoaError(.fileReadTooLarge)).contains("10 MiB"))
  #expect(userFacingError(CocoaError(.fileReadNoPermission)).contains("重新选择文件"))
  #expect(userFacingError(URLError(.serverCertificateUntrusted)).contains("HTTPS 证书"))
  #expect(userFacingError(URLError(.notConnectedToInternet)).contains("Wi-Fi"))
}

@Test func unknownPersistedFailureCodesAreSanitized() {
  #expect(!userFacingFailure(code: "internal_host_secret").contains("internal_host_secret"))
  #expect(userFacingFailure(code: "source_invalidated").contains("原文或记忆已失效"))
  #expect(userFacingFailure(code: "tool_authorization_changed").contains("重新发起动作"))
  #expect(userFacingFailure(code: "regeneration_unsafe").contains("无法换一种回答"))
}

@Test func nestedFoundationErrorsAreUnwrapped() {
  let error = NSError(
    domain: "Wrapper", code: 1,
    userInfo: [NSUnderlyingErrorKey: URLError(.timedOut)])
  #expect(userFacingError(error).contains("服务器响应有些慢"))
}

@Test func conflictsAndSessionsKeepDistinctRecovery() {
  #expect(userFacingFailure(code: "revision_conflict", status: 409).contains("你的编辑已保留"))
  #expect(userFacingFailure(code: "invalid_pairing_code", status: 401).contains("新配对码"))
  #expect(userFacingFailure(code: "unauthorized", status: 401).contains("重新配对"))
}
