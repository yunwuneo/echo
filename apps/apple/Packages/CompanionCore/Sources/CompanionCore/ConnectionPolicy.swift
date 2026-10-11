import Foundation

public enum ConnectionPolicy {
  public static let version = 1
  public static func serverURL(_ value: String, allowLocal: Bool = false) throws -> URL {
    guard var parts = URLComponents(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
      let host = parts.host, !host.isEmpty, parts.user == nil, parts.password == nil,
      parts.query == nil, parts.fragment == nil
    else { throw URLError(.badURL) }
    var permitted = parts.scheme?.lowercased() == "https"
    #if DEBUG
      if allowLocal && parts.scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(host) {
        permitted = true
      }
    #endif
    guard permitted else { throw URLError(.badURL) }
    parts.host = host.lowercased()
    parts.scheme = parts.scheme?.lowercased()
    if parts.scheme == "https" && parts.port == 443 { parts.port = nil }
    while parts.path.hasSuffix("/") { parts.path.removeLast() }
    guard let url = parts.url else { throw URLError(.badURL) }
    return url
  }
}
