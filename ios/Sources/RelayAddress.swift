import Foundation

/// A Relay origin, never a login link, token, or arbitrary page URL.
struct RelayAddress: Equatable, Hashable {
    let origin: URL

    enum ValidationError: LocalizedError {
        case invalid
        var errorDescription: String? {
            "请输入完整的 HTTPS 服务器地址，例如 https://relay.example.com；不要包含账号、参数或配对链接。"
        }
    }

    init(_ input: String) throws {
        let value = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty,
              !value.contains("\\"),
              !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              var parts = URLComponents(string: value),
              parts.scheme?.lowercased() == "https",
              let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil,
              ["", "/", "/app", "/app/"].contains(parts.percentEncodedPath),
              parts.port == nil || (1...65535).contains(parts.port!) else {
            throw ValidationError.invalid
        }
        parts.scheme = "https"
        parts.host = host.lowercased()
        if parts.port == 443 { parts.port = nil }
        parts.path = ""
        guard let url = parts.url, url.host != nil else { throw ValidationError.invalid }
        origin = url
    }

    var appURL: URL { origin.appendingPathComponent("app", isDirectory: true) }
    var displayName: String { origin.absoluteString }

    /// An explicit saved choice always wins; a broken saved value must not switch servers silently.
    static func initialAddress(saved: String, bundledDefault: String?) -> RelayAddress? {
        let candidate = saved.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? (bundledDefault ?? "") : saved
        return try? RelayAddress(candidate)
    }

    func contains(_ url: URL) -> Bool {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme?.lowercased() == "https",
              parts.user == nil, parts.password == nil,
              parts.host?.lowercased() == origin.host?.lowercased(),
              (parts.port ?? 443) == (origin.port ?? 443) else { return false }
        return true
    }

    func allowsAppNavigation(_ url: URL) -> Bool {
        guard contains(url), let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        let path = parts.percentEncodedPath
        guard !path.lowercased().contains("%2f"), !path.lowercased().contains("%5c"),
              !path.lowercased().contains("%2e"), !path.contains("\\"),
              !path.split(separator: "/").contains("..") else { return false }
        return path == "/app" || path.hasPrefix("/app/")
    }

    static func isExternalUserLink(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return false }
        if scheme == "mailto" { return true }
        guard scheme == "https",
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil else { return false }
        return true
    }

    static func isAuthenticatorLink(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "otpauth" && url.host?.lowercased() == "totp"
    }
}

