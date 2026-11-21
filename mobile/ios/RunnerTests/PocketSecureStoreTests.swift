import CryptoKit
import Foundation
import Security
import XCTest
@testable import Runner

final class PocketSecureStoreTests: XCTestCase {
  private var root: URL!
  private var service: String!
  private var store: PocketSecureStore!

  override func setUpWithError() throws {
    root = FileManager.default.temporaryDirectory.appendingPathComponent("pocket-ios-tests-" + UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
    service = (Bundle.main.bundleIdentifier ?? "pocket-tests") + ".qa." + UUID().uuidString
    store = try PocketSecureStore(directory: root.appendingPathComponent("state"),
                                  marker: root.appendingPathComponent("required"), service: service)
  }

  private var query: [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service!,
     kSecAttrAccount as String: "primary", kSecAttrSynchronizable as String: false]
  }

  override func tearDownWithError() throws {
    if service != nil { SecItemDelete(query as CFDictionary) }
    if let root { try FileManager.default.removeItem(at: root) }
  }

  func testCredentialFenceAndClearPreserveInstallation() throws {
    XCTAssertNil(try store.credential("read"))
    let identifier = try XCTUnwrap(store.credential("installationId") as? String)
    let fixture = "{\"deviceId\":\"qa-device\",\"username\":\"fixture\"}"
    _ = try store.credential("write", json: fixture)
    XCTAssertEqual(try store.credential("isBlocked") as? Bool, false)
    _ = try store.credential("block")
    XCTAssertEqual(try store.credential("isBlocked") as? Bool, true)
    XCTAssertEqual(try store.credential("read") as? String, fixture)
    _ = try store.credential("write", json: fixture)
    try store.writeState("journal", json: "[]")
    _ = try store.credential("clear")
    XCTAssertNil(try store.credential("read"))
    XCTAssertEqual(try store.credential("isBlocked") as? Bool, true)
    XCTAssertEqual(try store.credential("installationId") as? String, identifier)
    XCTAssertEqual(try store.readState("journal"), "[]")
  }

  func testMissingKeychainCannotGenerateReplacementIdentity() throws {
    _ = try store.credential("installationId")
    XCTAssertEqual(SecItemDelete(query as CFDictionary), errSecSuccess)
    XCTAssertThrowsError(try store.credential("read"))
    XCTAssertThrowsError(try store.credential("installationId"))
    XCTAssertEqual(SecItemCopyMatching(query as CFDictionary, nil), errSecItemNotFound)
  }

  func testCorruptKeychainFailsClosed() throws {
    _ = try store.credential("installationId")
    XCTAssertEqual(SecItemUpdate(query as CFDictionary,
      [kSecValueData as String: Data("broken".utf8)] as CFDictionary), errSecSuccess)
    XCTAssertThrowsError(try store.credential("read"))
    XCTAssertThrowsError(try store.credential("installationId"))
  }

  func testStateEncryptionAuthenticationAndUTF8Limit() throws {
    let key = "../outside"
    try store.writeState(key, json: "{\"operationId\":\"fixture\"}")
    XCTAssertEqual(try store.readState(key), "{\"operationId\":\"fixture\"}")
    let stateDirectory = root.appendingPathComponent("state")
    let files = try FileManager.default.contentsOfDirectory(at: stateDirectory, includingPropertiesForKeys: nil)
    XCTAssertEqual(files.count, 1)
    XCTAssertEqual(files[0].lastPathComponent,
      SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined() + ".state")
    var data = try Data(contentsOf: files[0])
    data[data.count - 1] ^= 1
    try data.write(to: files[0], options: [.atomic, .completeFileProtection])
    XCTAssertThrowsError(try store.readState(key))
    XCTAssertThrowsError(try store.writeState("large", json: "\"" + String(repeating: "界", count: 400_000) + "\""))
  }

  func testSerializedWritesRetainNewestJournal() async throws {
    let queue = PocketStorageQueue(store: store)
    let written = expectation(description: "ordered writes")
    written.expectedFulfillmentCount = 30
    for sequence in 0..<30 {
      queue.perform { storage in
        try storage.writeState("concurrent", json: "{\"seq\":\(sequence)}")
        return nil
      } completion: { result in
        if case .failure(let error) = result { XCTFail("State write failed: \(error)") }
        written.fulfill()
      }
    }
    await fulfillment(of: [written], timeout: 30)
    XCTAssertEqual(try store.readState("concurrent"), "{\"seq\":29}")
  }

  func testArtifactPathsAndExportNames() throws {
    let privateFile = root.appendingPathComponent("private.txt")
    try Data("private fixture".utf8).write(to: privateFile)
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("pocket-artifact-" + UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = directory.appendingPathComponent("content.tmp")
    try Data("fixture".utf8).write(to: file)
    XCTAssertEqual(try PocketFileChannels.artifactURL(file.path), file)
    XCTAssertThrowsError(try PocketFileChannels.artifactURL(privateFile.path))
    try FileManager.default.removeItem(at: file)
    try FileManager.default.createSymbolicLink(at: file, withDestinationURL: privateFile)
    XCTAssertThrowsError(try PocketFileChannels.artifactURL(file.path))
    let name = PocketFileChannels.safeName("../folder/\n" + String(repeating: "界", count: 100))
    XCTAssertFalse(name.contains("/"))
    XCTAssertFalse(name.contains("\n"))
    XCTAssertLessThanOrEqual(name.utf8.count, 160)
  }
}
