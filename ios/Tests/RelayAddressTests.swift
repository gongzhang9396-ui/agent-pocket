import Foundation

@main
struct RelayAddressTests {
    static func main() throws {
        let relay = try RelayAddress("  https://RELAY.example.com:443/app/  ")
        precondition(relay.displayName == "https://relay.example.com")
        precondition(relay.appURL.absoluteString == "https://relay.example.com/app/")
        precondition(RelayAddress.initialAddress(saved: "", bundledDefault: "https://RELAY.example.com:443/app/") == relay)
        precondition(RelayAddress.initialAddress(saved: " \n", bundledDefault: relay.displayName) == relay)
        precondition(RelayAddress.initialAddress(saved: "https://chosen.example.com", bundledDefault: relay.displayName)?.displayName == "https://chosen.example.com")
        precondition(RelayAddress.initialAddress(saved: "http://chosen.example.com", bundledDefault: relay.displayName) == nil)
        precondition(RelayAddress.initialAddress(saved: "", bundledDefault: "http://relay.example.com") == nil)
        precondition(RelayAddress.initialAddress(saved: "", bundledDefault: nil) == nil)
        let invalid = ["", "http://relay.example.com", "https://user:pass@relay.example.com",
                       "https://relay.example.com?token=x", "https://relay.example.com#pair=x",
                       "https://relay.example.com/admin", "https://relay.example.com:0",
                       "https://relay.example.com:65536", "https://relay.example.com/\\evil",
                       "https://relay.example.com/%61pp/", "https://relay.example.com\n.evil"]
        for value in invalid {
            do { _ = try RelayAddress(value); preconditionFailure("Accepted invalid Relay: \(value)") }
            catch { /* Expected. */ }
        }
        for text in ["https://relay.example.com/app/", "https://relay.example.com/app/#pair=local",
                     "https://relay.example.com/app/index.html", "https://relay.example.com:443/app/"] {
            precondition(relay.allowsAppNavigation(URL(string: text)!))
        }
        for text in ["http://relay.example.com/app/", "https://relay.example.com.evil/app/",
                     "https://relay.example.com:444/app/", "https://relay.example.com/admin",
                     "https://relay.example.com/app/../admin", "https://relay.example.com/app/%2e%2e/admin",
                     "https://relay.example.com/app/%2Fadmin", "javascript:alert(1)", "data:text/html,hello"] {
            precondition(!relay.allowsAppNavigation(URL(string: text)!))
        }
        precondition(RelayAddress.isExternalUserLink(URL(string: "https://docs.example.com/guide")!))
        precondition(!RelayAddress.isExternalUserLink(URL(string: "http://docs.example.com/guide")!))
        precondition(!RelayAddress.isExternalUserLink(URL(string: "file:///private/data")!))
        precondition(!RelayAddress.isExternalUserLink(URL(string: "https://user:pass@example.com")!))
        precondition(RelayAddress.isAuthenticatorLink(URL(string: "otpauth://totp/test?secret=TEST")!))
        precondition(!RelayAddress.isAuthenticatorLink(URL(string: "otpauth://hotp/test?secret=TEST")!))
        print("RelayAddress tests passed: startup defaults, saved server preference, HTTPS validation, origin isolation, app paths and external links")
    }
}

