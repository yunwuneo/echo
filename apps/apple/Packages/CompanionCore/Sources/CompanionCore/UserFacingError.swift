import Foundation
import OpenAPIRuntime

/// Presentation text deliberately excludes server messages, URLs, request bodies and credentials.
public func userFacingError(_ error: any Error) -> String {
  describeError(error, depth: 0)
}

private func describeError(_ error: any Error, depth: Int) -> String {
  guard depth < 8 else { return genericFailure }
  if let error = error as? APIError {
    return userFacingFailure(code: error.code, status: error.status)
  }
  if let error = error as? ClientError {
    return describeError(error.underlyingError, depth: depth + 1)
  }
  if error is CancellationError { return "操作已取消。需要时可以重新尝试。" }
  let value = error as NSError
  if value.domain == NSURLErrorDomain {
    return switch URLError.Code(rawValue: value.code) {
    case .badURL, .unsupportedURL:
      "服务器地址格式不正确。请输入完整的 HTTPS 地址，例如 https://example.com。"
    case .notConnectedToInternet, .dataNotAllowed, .internationalRoamingOff:
      "当前网络不可用。请检查 Wi-Fi 或蜂窝网络后重试。"
    case .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed:
      "暂时连不上服务器。请检查服务器地址，并确认服务器正在运行。"
    case .timedOut:
      "服务器响应有些慢。请稍后重试，或检查服务器连接。"
    case .networkConnectionLost:
      "连接中断了。请在网络恢复后重试。"
    case .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate,
      .serverCertificateNotYetValid, .serverCertificateHasUnknownRoot,
      .clientCertificateRejected, .clientCertificateRequired,
      .appTransportSecurityRequiresSecureConnection:
      "无法建立安全连接。请检查服务器的 HTTPS 证书和设备日期。"
    case .cancelled:
      "操作已取消。需要时可以重新尝试。"
    default:
      "连接暂时遇到了问题。请检查网络和服务器地址后重试。"
    }
  }
  if value.domain == NSCocoaErrorDomain {
    switch CocoaError.Code(rawValue: value.code) {
    case .fileReadTooLarge:
      return "文件太大，暂时无法读取。请选择不超过 5 MiB 的 JSON 或 10 MiB 的 PNG 文件。"
    case .fileReadNoPermission, .fileWriteNoPermission:
      return "没有访问这个文件位置的权限。请重新选择文件，或保存到有权限的文件夹。"
    case .fileNoSuchFile, .fileReadNoSuchFile:
      return "找不到这个文件，可能已被移动。请重新选择文件。"
    case .fileWriteOutOfSpace:
      return "设备存储空间不足。请腾出一些空间后重新保存。"
    case .userCancelled:
      return "操作已取消。需要时可以重新选择文件。"
    default: break
    }
  }
  if value.domain == "EchoPush", value.code == 403 {
    return "系统通知尚未获准。请在系统设置中允许 Echo 发送通知。"
  }
  if error is DecodingError {
    return "内容格式暂时无法识别。请检查填写的内容，并确认客户端与服务器版本兼容。"
  }
  if let underlying = value.userInfo[NSUnderlyingErrorKey] as? any Error {
    return describeError(underlying, depth: depth + 1)
  }
  return genericFailure
}

private let genericFailure = "操作暂时没有完成。请稍后重试；如果仍有问题，可在“数据与诊断”中查看服务器状态。"

/// Covers persisted background failure codes as well as HTTP errors without exposing raw codes.
public func userFacingFailure(code: String, status: Int = 0) -> String {
  switch code {
  case "maintenance": return "服务器正在维护。请稍后再试，连接会自动恢复。"
  case "not_connected", "pairing_required": return "还没有连接服务器。请先在设置中完成设备配对。"
  case "invalid_pairing_code": return "配对码无效或已过期。请在服务器获取新配对码后重试。"
  case "pairing_rate_limited": return "配对尝试过于频繁。请稍等片刻后再试。"
  case "instance_changed_repair_required": return "服务器已恢复或更换实例。请重新配对此设备。"
  case "server_upgrade_required": return "服务器版本暂不支持此功能。请更新服务器后重新连接。"
  case "connection_changed": return "当前服务器连接已切换。请在新连接中重新打开此页面。"
  case "keychain_read", "keychain_write": return "暂时无法访问设备的安全凭据。请解锁设备后重试。"
  case "push_disabled": return "服务器尚未配置通知中继。可在配置完成后重新开启通知。"
  case "push_binding_mismatch": return "通知凭据与此设备不匹配或已过期。请使用新邀请重新绑定。"
  case "relay_rejected": return "通知中继拒绝了请求。请检查邀请、应用环境和票据有效期。"
  case "notification_unavailable": return "这条通知的原文已删除或无法访问。请同步后查看最新动态。"
  case "export_too_large": return "数据超过在线导出上限。请使用服务器备份工具导出。"
  case "invalid_import", "import_needs_repair":
    return "文件不是有效的角色卡或世界书，或包含无法导入的内容。请检查 JSON 格式或重新导出角色卡后再预览。"
  case "import_too_large": return "文件超过导入上限。请使用不超过 5 MiB 的 JSON 或 10 MiB 的 PNG。"
  case "too_many_entries": return "世界书条目过多。请拆分成每份不超过 2,000 条后再导入。"
  case "import_preview_stale": return "导入内容或角色权限已改变。请重新预览后再确认导入。"
  case "import_already_committed": return "这份内容已经导入。请刷新页面查看导入结果。"
  case "active_runs": return "相关对话还在处理中。请等待回复结束，或取消后续运行后再操作。"
  case "audience_expansion": return "这项修改会让更多角色看到原本私有的内容。请只保留原有可知角色后再保存。"
  case "memory_invalidated", "source_invalidated": return "相关原文或记忆已失效。请刷新后查看最新内容。"
  case "invalid_supersedes": return "选中的替代记忆已不可用。请重新选择要替代的记忆。"
  case "embedding_dimensions", "invalid_embedding": return "语义索引的维度与连接配置不一致。请检查记忆设置中的连接与向量维度。"
  case "embedding_unavailable": return "语义索引暂时不可用，仍可按关键词回忆。请检查嵌入连接后重试。"
  case "memory_context_budget": return "这次记忆整理超出了上下文容量。请调整聊天连接的容量或回复额度后重试。"
  case "memory_context_changed", "context_changed": return "相关内容在处理期间发生了变化。请刷新后重试。"
  case "invalid_extraction", "ungrounded_extraction": return "整理结果未能通过原文核对。可以重试整理，或手动修正已有记忆。"
  case "autonomy_disabled": return "后台行动当前已暂停。需要继续时，请检查总开关与世界中的对应权限。"
  case "background_budget_exceeded": return "今天的后台额度已用完。可以等待次日重置，或在预算设置中调整。"
  case "invalid_endpoint", "insecure_endpoint": return "服务地址不符合连接要求。请填写完整的 HTTPS 地址。"
  case "blocked_destination", "invalid_allowlist": return "此服务地址不在允许访问的范围内。请检查地址和该连接的内网 IP 授权。"
  case "credential_required", "invalid_auth_header": return "连接的认证信息不完整。请检查凭据及密钥请求头。"
  case "mcp_connect_failed", "mcp_origin_changed": return "暂时无法连接工具服务。请检查地址、认证方式和服务状态后重新发现工具。"
  case "mcp_response_limit", "mcp_discovery_limit": return "工具服务返回的内容超过处理上限。请减少该服务的工具或返回内容后重试。"
  case "tool_not_granted", "tool_scope_denied", "scope_required", "scope_limit":
    return "此动作未在已授权的参数范围内。请检查具体工具与资源参数的授权。"
  case "tool_schema_changed", "tool_authorization_changed", "tool_arguments_changed":
    return "工具定义、参数或授权已发生变化。请核对最新内容后重新发起动作。"
  case "approval_inactive", "approval_expired": return "这项动作已结束或批准已过期。请刷新工具记录查看最新状态。"
  case "invalid_tool_arguments": return "工具参数不符合要求。请对照工具参数定义检查后重试。"
  case "tool_loop_limit": return "这轮已达到工具调用次数上限。请查看已完成的动作后再继续。"
  case "credential_reflected": return "工具返回包含敏感凭据，已停止展示。请检查该工具服务的返回内容。"
  case "invalid_expiry": return "到期时间不在允许范围内。请选择有效的未来时间后再保存。"
  case "empty_room", "invalid_addressee", "invalid_actor": return "所选角色已不在这个对话中。请检查成员并重新选择回应者。"
  case "regeneration_unsafe": return "这一轮之后已有新内容或工具动作，无法换一种回答。可以继续发送消息。"
  case "invalid_budget", "background_config_missing": return "回复或预算配置不完整。请检查聊天连接和后台预算设置。"
  default: break
  }
  return switch status {
  case 401: "设备会话已失效。请重新配对此设备。"
  case 403: "当前没有执行这项操作的权限。请检查角色和工具的授权设置。"
  case 404: "这项内容已不存在或无法访问。请刷新页面查看最新内容。"
  case 409: "服务器内容已更改。你的编辑已保留，请比较新版本后再保存。"
  case 410: "本地内容需要重新同步。请稍等片刻后查看。"
  case 413: "内容超过了处理上限。请缩短文字或拆分文件后重试。"
  case 429: "请求有些频繁，服务暂时忙碌。请稍等片刻后重试。"
  case 400, 422: "填写的内容不符合要求。请检查必填项和格式后再试。"
  case 500...599: "服务器暂时无法处理这项操作。请稍后重试，或检查服务器运行状态。"
  default: genericFailure
  }
}
