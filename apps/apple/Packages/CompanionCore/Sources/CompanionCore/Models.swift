import Foundation

public enum JSONValue: Codable, Hashable, Sendable {
  case string(String)
  case number(Double)
  case bool(Bool)
  case object([String: JSONValue])
  case array([JSONValue])
  case null
  public init(from decoder: any Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() {
      self = .null
    } else if let v = try? c.decode(String.self) {
      self = .string(v)
    } else if let v = try? c.decode(Bool.self) {
      self = .bool(v)
    } else if let v = try? c.decode(Double.self) {
      self = .number(v)
    } else if let v = try? c.decode([String: JSONValue].self) {
      self = .object(v)
    } else {
      self = .array(try c.decode([JSONValue].self))
    }
  }
  public func encode(to encoder: any Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .string(let v): try c.encode(v)
    case .number(let v): try c.encode(v)
    case .bool(let v): try c.encode(v)
    case .object(let v): try c.encode(v)
    case .array(let v): try c.encode(v)
    case .null: try c.encodeNil()
    }
  }
  public subscript(_ key: String) -> JSONValue {
    if case .object(let v) = self { v[key] ?? .null } else { .null }
  }
  public var string: String { if case .string(let v) = self { v } else { "" } }
  public var int: Int { if case .number(let v) = self { Int(v) } else { 0 } }
  public var bool: Bool { if case .bool(let v) = self { v } else { false } }
  public var array: [JSONValue] { if case .array(let v) = self { v } else { [] } }
  public var object: [String: JSONValue] { if case .object(let v) = self { v } else { [:] } }
  public static func strings(_ values: [String]) -> JSONValue {
    .array(values.map(JSONValue.string))
  }
}
public func converted<T: Decodable, U: Encodable>(_ value: U, to: T.Type = T.self) throws -> T {
  try JSONDecoder().decode(T.self, from: JSONEncoder().encode(value))
}
public struct Record: Identifiable, Hashable, Sendable {
  public let kind: String
  public let value: JSONValue
  public var id: String {
    value["id"].string.isEmpty ? value["world_id"].string : value["id"].string
  }
  public var name: String { value["name"].string }
  public subscript(_ key: String) -> JSONValue { value[key] }
  public init(kind: String, value: JSONValue) {
    self.kind = kind
    self.value = value
  }
}
public struct Credentials: Codable, Sendable {
  public var access_token: String
  public var refresh_token: String
  public var device_id: String
  public var owner_id: String
}
public struct Connection: Codable, Sendable {
  public var url: String
  public var instance: String
  public var epoch: String
  public var credentials: Credentials
  public var namespace: String {
    [url, instance, epoch, credentials.owner_id].joined(separator: "|")
  }
}
public struct APIError: Error, LocalizedError, Sendable {
  public let status: Int
  public let code: String
  public var errorDescription: String? {
    switch code {
    case "maintenance": return "服务器正在维护，稍后可自动重连。"
    case "push_disabled": return "服务器尚未配置通知中继。"
    case "push_binding_mismatch": return "通知票据与此设备不匹配或已过期，请使用新邀请重新绑定。"
    case "relay_rejected": return "通知中继拒绝了请求，请检查邀请、应用环境和票据有效期。"
    case "notification_unavailable": return "这条通知的原文已删除或无法访问，请同步后查看最新动态。"
    case "export_too_large": return "数据超过在线导出上限，请使用服务器备份工具。"
    default: break
    }
    return switch status {
    case 401: "设备会话失效，请重新配对。"
    case 409: "服务器内容已更改；你的编辑已保留，请比较新版本后再保存。"
    case 410: "正在重建本地缓存。"
    default: "请求失败（\(code)）。"
    }
  }
}
public struct SSEFrame: Sendable {
  public let id: String
  public let data: String
}
public struct SSEParser: Sendable {
  private var id = "", data: [String] = [], size = 0
  private var lineBytes: [UInt8] = []
  public mutating func consume(byte: UInt8) throws -> SSEFrame? {
    if byte != 10 {
      lineBytes.append(byte)
      guard lineBytes.count < 1_048_576 else {
        throw APIError(status: 413, code: "event_too_large")
      }
      return nil
    }
    if lineBytes.last == 13 { lineBytes.removeLast() }
    guard let line = String(bytes: lineBytes, encoding: .utf8) else {
      throw APIError(status: 400, code: "invalid_utf8_event")
    }
    lineBytes.removeAll(keepingCapacity: true)
    if line.hasPrefix(":") { return SSEFrame(id: "", data: "") }
    return try consume(line)
  }
  public init() {}
  public mutating func consume(_ line: String) throws -> SSEFrame? {
    size += line.utf8.count
    guard size < 1_048_576 else { throw APIError(status: 413, code: "event_too_large") }
    if line.isEmpty {
      defer {
        id = ""
        data = []
        size = 0
      }
      return data.isEmpty ? nil : SSEFrame(id: id, data: data.joined(separator: "\n"))
    }
    if line.hasPrefix("id:") { id = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces) }
    if line.hasPrefix("data:") {
      data.append(String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces))
    }
    return nil
  }
}
public func cursorIsNewer(_ lhs: String, than rhs: String) -> Bool {
  lhs.count == rhs.count ? lhs > rhs : lhs.count > rhs.count
}
