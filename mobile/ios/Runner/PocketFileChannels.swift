import CryptoKit
import Flutter
import UIKit
import UniformTypeIdentifiers

@MainActor
final class PocketFileChannels: NSObject, UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate {
  private enum Operation { case pick, importing, save, share }
  private var pending: FlutterResult?
  private var operation: Operation?
  private var exported: URL?

  private func presenter() -> UIViewController? {
    let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
      .first { $0.activationState == .foregroundActive }
    var controller = scene?.windows.first { $0.isKeyWindow }?.rootViewController
    while let next = controller?.presentedViewController { controller = next }
    return controller
  }

  func handle(_ channel: String, call: FlutterMethodCall, result: @escaping FlutterResult) {
    let arguments = call.arguments as? [String: Any] ?? [:]
    if channel == "files" && call.method == "remove" {
      do {
        guard let path = arguments["path"] as? String else { throw PocketStorageError.invalid }
        let root = try Self.uploadRoot()
        let file = URL(fileURLWithPath: path)
        try Self.validateUpload(file, root: root)
        try FileManager.default.removeItem(at: file)
        try Self.removeEmptyDirectory(file.deletingLastPathComponent())
        result(nil)
      } catch { result(FlutterError(code: "FILE_REMOVE", message: "无法移除所选文件", details: nil)) }
      return
    }
    guard pending == nil, let presenter = presenter() else {
      result(FlutterError(code: "FILE_BUSY", message: "请先完成当前系统文件窗口", details: nil)); return
    }
    if channel == "files" && call.method == "pick" {
      pending = result
      operation = .pick
      let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: false)
      picker.allowsMultipleSelection = true
      picker.delegate = self
      picker.presentationController?.delegate = self
      presenter.present(picker, animated: true)
      return
    }
    guard (channel == "file_save" && call.method == "save") ||
          (channel == "file_actions" && ["share", "open"].contains(call.method)) else {
      result(FlutterMethodNotImplemented); return
    }
    do {
      guard let path = arguments["path"] as? String else { throw PocketStorageError.invalid }
      let source = try Self.artifactURL(path)
      let name = Self.safeName(arguments["name"] as? String ?? "文件")
      let directory = FileManager.default.temporaryDirectory.appendingPathComponent("pocket-export-" + UUID().uuidString)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false,
        attributes: [.protectionKey: FileProtectionType.complete, .posixPermissions: 0o700])
      exported = directory.appendingPathComponent(name)
      guard let exported else { throw PocketStorageError.invalid }
      try FileManager.default.copyItem(at: source, to: exported)
      try Self.protectPrivateFile(exported)
      pending = result
      if channel == "file_save" {
        operation = .save
        let picker = UIDocumentPickerViewController(forExporting: [exported], asCopy: true)
        picker.delegate = self
        picker.presentationController?.delegate = self
        presenter.present(picker, animated: true)
      } else {
        operation = .share
        let activity = UIActivityViewController(activityItems: [exported], applicationActivities: nil)
        activity.popoverPresentationController?.sourceView = presenter.view
        activity.popoverPresentationController?.sourceRect = CGRect(x: presenter.view.bounds.midX,
          y: presenter.view.bounds.midY, width: 1, height: 1)
        activity.completionWithItemsHandler = { [weak self] _, _, _, error in
          Task { @MainActor in
            if error != nil { self?.finish(FlutterError(code: "FILE_ACTION", message: "文件分享未完成", details: nil)) }
            else { self?.finish(nil) }
          }
        }
        activity.presentationController?.delegate = self
        presenter.present(activity, animated: true)
      }
    } catch {
      cleanupExport()
      result(FlutterError(code: "FILE_ACTION", message: "文件不可读取，请重新下载后重试", details: nil))
    }
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    if operation == .save { finish(!urls.isEmpty); return }
    guard operation == .pick else { return }
    guard !urls.isEmpty, urls.count <= 3 else {
      finish(FlutterError(code: "FILE_LIMIT", message: "每次最多选择 3 个文件", details: nil)); return
    }
    operation = .importing
    DispatchQueue.global(qos: .userInitiated).async {
      let outcome: Result<[[String: Any]], Error>
      do { outcome = .success(try Self.importFiles(urls)) }
      catch { outcome = .failure(error) }
      DispatchQueue.main.async {
        switch outcome {
        case .success(let items): self.finish(items)
        case .failure: self.finish(FlutterError(code: "FILE_PICK",
          message: "读取未完成：每次最多 3 个文件，单个 20 MiB，合计 60 MiB", details: nil))
        }
      }
    }
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    if operation == .save { finish(false) }
    else { finish([]) }
  }

  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    if operation == .pick { finish([]) }
    else if operation == .save { finish(false) }
  }

  private func finish(_ value: Any?) {
    guard let callback = pending else { return }
    pending = nil
    operation = nil
    cleanupExport()
    callback(value)
  }

  private func cleanupExport() {
    guard let file = exported else { return }
    exported = nil
    try? FileManager.default.removeItem(at: file)
    try? Self.removeEmptyDirectory(file.deletingLastPathComponent())
  }

  nonisolated private static func removeEmptyDirectory(_ directory: URL) throws {
    guard try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).isEmpty else {
      throw PocketStorageError.invalid
    }
    try FileManager.default.removeItem(at: directory)
  }

  nonisolated static func safeName(_ value: String) -> String {
    let forbidden = CharacterSet.controlCharacters.union(CharacterSet(charactersIn: "/\\"))
    let cleaned = value.components(separatedBy: forbidden).joined(separator: "_")
    var result = ""
    var length = 0
    for character in cleaned {
      let bytes = String(character).utf8.count
      if length + bytes > 160 { break }
      result.append(character)
      length += bytes
    }
    return result.isEmpty || result == "." || result == ".." ? "文件" : result
  }

  nonisolated private static func protectPrivateFile(_ url: URL) throws {
    try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete, .posixPermissions: 0o600],
                                         ofItemAtPath: url.path)
    var file = url
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try file.setResourceValues(values)
  }

  nonisolated private static func uploadRoot() throws -> URL {
    let manager = FileManager.default
    let support = try manager.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                  appropriateFor: nil, create: true)
    let root = support.appendingPathComponent("pocket-uploads", isDirectory: true)
    if !manager.fileExists(atPath: root.path) {
      try manager.createDirectory(at: root, withIntermediateDirectories: false,
        attributes: [.protectionKey: FileProtectionType.complete, .posixPermissions: 0o700])
    }
    guard try manager.attributesOfItem(atPath: root.path)[.type] as? FileAttributeType == .typeDirectory else {
      throw PocketStorageError.invalid
    }
    var directory = root
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try directory.setResourceValues(values)
    return root.resolvingSymlinksInPath()
  }

  nonisolated private static func validateUpload(_ file: URL, root: URL) throws {
    let parent = file.deletingLastPathComponent()
    guard file.lastPathComponent == "content.tmp", UUID(uuidString: parent.lastPathComponent) != nil,
          parent.deletingLastPathComponent().resolvingSymlinksInPath() == root,
          try FileManager.default.attributesOfItem(atPath: parent.path)[.type] as? FileAttributeType == .typeDirectory,
          try FileManager.default.attributesOfItem(atPath: file.path)[.type] as? FileAttributeType == .typeRegular else {
      throw PocketStorageError.invalid
    }
  }

  nonisolated private static func importFiles(_ urls: [URL]) throws -> [[String: Any]] {
    let manager = FileManager.default
    let root = try uploadRoot()
    var created: [URL] = []
    var items: [[String: Any]] = []
    do {
      for source in urls {
        let access = source.startAccessingSecurityScopedResource()
        defer { if access { source.stopAccessingSecurityScopedResource() } }
        let directory = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try manager.createDirectory(at: directory, withIntermediateDirectories: false,
          attributes: [.protectionKey: FileProtectionType.complete, .posixPermissions: 0o700])
        let file = directory.appendingPathComponent("content.tmp")
        created.append(file)
        var failure: NSError?
        var copied: Result<[String: Any], Error>?
        NSFileCoordinator(filePresenter: nil).coordinate(readingItemAt: source, options: [], error: &failure) { coordinated in
          copied = Result {
            let metadata = try coordinated.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey, .contentTypeKey])
            guard metadata.isRegularFile == true, metadata.isSymbolicLink != true,
                  (metadata.fileSize ?? 0) <= 20 * 1024 * 1024 else { throw PocketStorageError.invalid }
            guard manager.createFile(atPath: file.path, contents: nil,
              attributes: [.protectionKey: FileProtectionType.complete, .posixPermissions: 0o600]) else {
              throw PocketStorageError.unavailable
            }
            let input = try FileHandle(forReadingFrom: coordinated)
            defer { try? input.close() }
            let output = try FileHandle(forWritingTo: file)
            defer { try? output.close() }
            var hash = SHA256()
            var length = 0
            while let bytes = try input.read(upToCount: 192 * 1024), !bytes.isEmpty {
              length += bytes.count
              guard length <= 20 * 1024 * 1024 else { throw PocketStorageError.invalid }
              hash.update(data: bytes)
              try output.write(contentsOf: bytes)
            }
            try output.synchronize()
            guard length > 0, metadata.fileSize == nil || metadata.fileSize == length else { throw PocketStorageError.invalid }
            try protectPrivateFile(file)
            return ["path": file.path, "filename": safeName(coordinated.lastPathComponent),
              "mimeType": metadata.contentType?.preferredMIMEType ?? "application/octet-stream", "size": length,
              "sha256": hash.finalize().map { String(format: "%02x", $0) }.joined()]
          }
        }
        if let failure { throw failure }
        guard let copied else { throw PocketStorageError.unavailable }
        items.append(try copied.get())
      }
      return items
    } catch {
      for file in created {
        try? manager.removeItem(at: file)
        try? removeEmptyDirectory(file.deletingLastPathComponent())
      }
      throw error
    }
  }

  nonisolated static func artifactURL(_ path: String) throws -> URL {
    let file = URL(fileURLWithPath: path)
    let parent = file.deletingLastPathComponent()
    let temporary = FileManager.default.temporaryDirectory.resolvingSymlinksInPath()
    let values = try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
    guard file.lastPathComponent == "content.tmp", parent.lastPathComponent.hasPrefix("pocket-artifact-"),
          parent.deletingLastPathComponent().resolvingSymlinksInPath() == temporary,
          try FileManager.default.attributesOfItem(atPath: parent.path)[.type] as? FileAttributeType == .typeDirectory,
          values.isRegularFile == true, values.isSymbolicLink != true,
          let size = values.fileSize, size <= 32 * 1024 * 1024 else { throw PocketStorageError.invalid }
    return file
  }
}
