import CryptoKit
import Foundation
import Security

enum PocketStorageError: Error {
  case unavailable
  case invalid
  case recoveryRequired
}

final class PocketStorageQueue {
  private let queue = DispatchQueue(label: "com.agentpocket.secure-state")
  private var store: PocketSecureStore?

  init(store: PocketSecureStore? = nil) { self.store = store }

  func perform(_ operation: @escaping (PocketSecureStore) throws -> Any?,
               completion: @escaping @MainActor (Result<Any?, Error>) -> Void) {
    queue.async {
      let outcome: Result<Any?, Error>
      do {
        let current: PocketSecureStore
        if let existing = self.store { current = existing }
        else { current = try PocketSecureStore(); self.store = current }
        outcome = .success(try operation(current))
      } catch { outcome = .failure(error) }
      DispatchQueue.main.async { completion(outcome) }
    }
  }
}

/// Called only from the platform plugin's single storage queue.
final class PocketSecureStore {
  private struct Record: Codable {
    let version: Int
    let installationId: String
    let stateKey: Data
    var blocked: Bool
    var credentials: String? = nil
    var pendingHost: String? = nil
  }

  private let files = FileManager.default
  private let directory: URL
  private let marker: URL
  private let service: String
  private let markerContent = Data("agent-pocket-ios-keychain-v1\n".utf8)

  convenience init() throws {
    guard let identifier = Bundle.main.bundleIdentifier else { throw PocketStorageError.invalid }
    let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                              appropriateFor: nil, create: true)
    try self.init(directory: support.appendingPathComponent("PocketSecureState", isDirectory: true),
                  marker: support.appendingPathComponent("PocketKeychainRequired-v1"),
                  service: identifier + ".secure-state-v1")
  }

  init(directory: URL, marker: URL, service: String) throws {
    self.directory = directory
    self.marker = marker
    self.service = service
    if !files.fileExists(atPath: directory.path) {
      try files.createDirectory(at: directory, withIntermediateDirectories: false,
                               attributes: [.posixPermissions: 0o700, .protectionKey: FileProtectionType.complete])
    }
    try protect(directory, directory: true, excluded: true)
  }

  private var query: [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
     kSecAttrAccount as String: "primary", kSecAttrSynchronizable as String: false]
  }

  private func protect(_ url: URL, directory isDirectory: Bool, excluded: Bool) throws {
    let attributes = try files.attributesOfItem(atPath: url.path)
    guard attributes[.type] as? FileAttributeType == (isDirectory ? .typeDirectory : .typeRegular) else {
      throw PocketStorageError.invalid
    }
    try files.setAttributes([.protectionKey: FileProtectionType.complete,
                             .posixPermissions: isDirectory ? 0o700 : 0o600], ofItemAtPath: url.path)
    var mutable = url
    var values = URLResourceValues()
    values.isExcludedFromBackup = excluded
    try mutable.setResourceValues(values)
    let checked = try files.attributesOfItem(atPath: url.path)
    let protection = (checked[.protectionKey] as? FileProtectionType)?.rawValue ?? checked[.protectionKey] as? String
    guard protection == FileProtectionType.complete.rawValue,
          try mutable.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == excluded else {
      throw PocketStorageError.unavailable
    }
  }

  private func initialized() throws -> Bool {
    if files.fileExists(atPath: marker.path) {
      let attributes = try files.attributesOfItem(atPath: marker.path)
      guard attributes[.type] as? FileAttributeType == .typeRegular,
            (attributes[.size] as? NSNumber)?.intValue == markerContent.count,
            try Data(contentsOf: marker) == markerContent else {
        throw PocketStorageError.recoveryRequired
      }
      return true
    }
    return try !files.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).isEmpty
  }

  private func markRequired() throws {
    if files.fileExists(atPath: marker.path) {
      guard try initialized() else { throw PocketStorageError.recoveryRequired }
      return
    } else {
      try markerContent.write(to: marker, options: [.atomic, .completeFileProtection])
    }
    // This non-secret marker survives backup restore when ThisDeviceOnly keys do not.
    try protect(marker, directory: false, excluded: false)
    let handle = try FileHandle(forWritingTo: marker)
    defer { try? handle.close() }
    try handle.synchronize()
  }

  private func record(create: Bool) throws -> Record? {
    var request = query
    request[kSecReturnData as String] = true
    request[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(request as CFDictionary, &result)
    if status == errSecItemNotFound {
      guard try !initialized() else { throw PocketStorageError.recoveryRequired }
      if !create { return nil }
      let key = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
      let value = Record(version: 1, installationId: UUID().uuidString, stateKey: key, blocked: false)
      try save(value, adding: true)
      return value
    }
    // Lock-screen and Keychain failures must never be treated as a fresh install.
    guard status == errSecSuccess, let data = result as? Data, data.count <= 128 * 1024,
          let value = try? JSONDecoder().decode(Record.self, from: data), value.version == 1,
          UUID(uuidString: value.installationId) != nil, value.stateKey.count == 32 else {
      throw PocketStorageError.recoveryRequired
    }
    try markRequired()
    return value
  }

  private func save(_ value: Record, adding: Bool = false) throws {
    let data = try JSONEncoder().encode(value)
    guard data.count <= 128 * 1024 else { throw PocketStorageError.invalid }
    try markRequired()
    let status: OSStatus
    if adding {
      var item = query
      item[kSecValueData as String] = data
      item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
      status = SecItemAdd(item as CFDictionary, nil)
    } else {
      status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    }
    guard status == errSecSuccess else { throw PocketStorageError.unavailable }
  }

  func credential(_ method: String, json: String? = nil) throws -> Any? {
    switch method {
    case "read": return try record(create: false)?.credentials
    case "isBlocked": return try record(create: false)?.blocked ?? false
    case "installationId":
      guard let value = try record(create: true) else { throw PocketStorageError.unavailable }
      return value.installationId
    case "readPendingHost": return try record(create: false)?.pendingHost
    case "write", "block", "clear", "writePendingHost", "clearPendingHost":
      guard var value = try record(create: true) else { throw PocketStorageError.unavailable }
      switch method {
      case "write":
        guard let json else { throw PocketStorageError.invalid }
        try validateJSON(json, limit: 64 * 1024, objectOnly: true)
        value.credentials = json
        value.blocked = false
      case "block": value.blocked = true
      case "clear": value.credentials = nil; value.blocked = true
      case "writePendingHost":
        guard let json else { throw PocketStorageError.invalid }
        try validateJSON(json, limit: 8192, objectOnly: true)
        value.pendingHost = json
      default: value.pendingHost = nil
      }
      try save(value)
      return nil
    default: throw PocketStorageError.invalid
    }
  }

  private func validateJSON(_ value: String, limit: Int, objectOnly: Bool = false) throws {
    let data = Data(value.utf8)
    guard data.count <= limit else { throw PocketStorageError.invalid }
    let parsed = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    if objectOnly && !(parsed is [String: Any]) { throw PocketStorageError.invalid }
  }

  private func stateURL(_ key: String) throws -> URL {
    guard !key.isEmpty, key.utf8.count <= 2048 else { throw PocketStorageError.invalid }
    let name = SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
    return directory.appendingPathComponent(name + ".state")
  }

  func readState(_ key: String) throws -> String? {
    let url = try stateURL(key)
    let value = try record(create: false)
    guard files.fileExists(atPath: url.path) else { return nil }
    guard let value else { throw PocketStorageError.recoveryRequired }
    let attributes = try files.attributesOfItem(atPath: url.path)
    guard attributes[.type] as? FileAttributeType == .typeRegular,
          let size = (attributes[.size] as? NSNumber)?.intValue,
          size <= 1024 * 1024 + 32 else {
      throw PocketStorageError.invalid
    }
    try protect(url, directory: false, excluded: true)
    let box = try AES.GCM.SealedBox(combined: Data(contentsOf: url))
    let plain = try AES.GCM.open(box, using: SymmetricKey(data: value.stateKey),
                                 authenticating: Data(("agent-pocket-ios-state-v1\0" + key).utf8))
    guard plain.count <= 1024 * 1024, let text = String(data: plain, encoding: .utf8) else {
      throw PocketStorageError.invalid
    }
    return text
  }

  func writeState(_ key: String, json: String) throws {
    let url = try stateURL(key)
    try validateJSON(json, limit: 1024 * 1024)
    if files.fileExists(atPath: url.path) {
      guard try files.attributesOfItem(atPath: url.path)[.type] as? FileAttributeType == .typeRegular else {
        throw PocketStorageError.invalid
      }
    }
    guard let value = try record(create: true) else { throw PocketStorageError.unavailable }
    let box = try AES.GCM.seal(Data(json.utf8), using: SymmetricKey(data: value.stateKey),
                               authenticating: Data(("agent-pocket-ios-state-v1\0" + key).utf8))
    guard let combined = box.combined else { throw PocketStorageError.invalid }
    try combined.write(to: url, options: [.atomic, .completeFileProtection])
    try protect(url, directory: false, excluded: true)
    let handle = try FileHandle(forWritingTo: url)
    defer { try? handle.close() }
    try handle.synchronize()
  }
}
