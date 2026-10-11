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
    userFacingFailure(code: code, status: status)
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
