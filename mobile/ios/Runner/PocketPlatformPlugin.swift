import CryptoKit
import Flutter
import UIKit
import UserNotifications

@MainActor
final class PocketPlatformPlugin: NSObject, UNUserNotificationCenterDelegate {
  private let storage = PocketStorageQueue()
  private let preferences = UserDefaults.standard
  private let files = PocketFileChannels()
  private var channels: [FlutterMethodChannel] = []
  private let configuration: FlutterMethodChannel
  private var configured = false
  private var pendingNotification: [String: String]?
  private var recentEvents: [String] = []

  init(messenger: FlutterBinaryMessenger) {
    configuration = FlutterMethodChannel(name: "agent_pocket/configuration", binaryMessenger: messenger)
    super.init()
    for name in ["credential_store", "secure_state", "cursors", "appearance", "settings", "background"] {
      let channel = FlutterMethodChannel(name: "agent_pocket/" + name, binaryMessenger: messenger)
      channel.setMethodCallHandler { [weak self] call, result in
        self?.handle(name, call: call, result: result)
      }
      channels.append(channel)
    }
    configuration.setMethodCallHandler { [weak self] call, result in
      guard let self else { return }
      if call.method == "read" { result(self.readConfiguration()) }
      else { result(FlutterMethodNotImplemented) }
    }
    for name in ["files", "file_save", "file_actions"] {
      let channel = FlutterMethodChannel(name: "agent_pocket/" + name, binaryMessenger: messenger)
      channel.setMethodCallHandler { [weak self] call, result in
        self?.files.handle(name, call: call, result: result)
      }
      channels.append(channel)
    }
    UNUserNotificationCenter.current().delegate = self
  }

  private func readConfiguration() -> [String: Any] {
    let raw = Bundle.main.object(forInfoDictionaryKey: "AgentPocketDefaultRelayOrigin") as? String ?? ""
    let origin = URLComponents(string: raw)
    let valid = origin?.scheme == "https" && origin?.host?.isEmpty == false && origin?.user == nil &&
      origin?.password == nil && origin?.query == nil && origin?.fragment == nil &&
      (origin?.path.isEmpty == true || origin?.path == "/")
    var result: [String: Any] = ["platform": "ios", "defaultRelayUrl": valid ? raw : "",
      "deviceName": UIDevice.current.model + " · Flutter",
      "version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.4.1",
      "versionCode": Int(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "") ?? 401,
      "supportsBackgroundConnection": false, "supportsInAppUpdates": false]
    if let pendingNotification { result["notification"] = pendingNotification; self.pendingNotification = nil }
    configured = true
    return result
  }

  private func handle(_ channel: String, call: FlutterMethodCall, result: @escaping FlutterResult) {
    let arguments = call.arguments as? [String: Any] ?? [:]
    switch channel {
    case "credential_store":
      let allowed = ["read", "write", "clear", "isBlocked", "block", "installationId",
                     "readPendingHost", "writePendingHost", "clearPendingHost"]
      guard allowed.contains(call.method) else { result(FlutterMethodNotImplemented); return }
      let json = arguments["json"] as? String
      storage.perform({ try $0.credential(call.method, json: json) }) { [weak self] outcome in
        if case .success = outcome, call.method == "clear" { self?.removeTaskNotifications() }
        self?.finish(outcome, code: "CREDENTIAL_STORE", result: result)
      }
    case "secure_state":
      guard let key = arguments["key"] as? String, !key.isEmpty, key.utf8.count <= 2048 else {
        result(FlutterError(code: "STATE_STORE", message: "本机状态标识无效", details: nil)); return
      }
      switch call.method {
      case "read":
        storage.perform({ try $0.readState(key) }) { [weak self] in self?.finish($0, code: "STATE_STORE", result: result) }
      case "write":
        guard let json = arguments["json"] as? String else {
          result(FlutterError(code: "STATE_STORE", message: "本机状态格式无效", details: nil)); return
        }
        storage.perform({ try $0.writeState(key, json: json); return nil }) { [weak self] in
          self?.finish($0, code: "STATE_STORE", result: result)
        }
      default: result(FlutterMethodNotImplemented)
      }
    case "cursors": cursor(call, arguments: arguments, result: result)
    case "appearance":
      if call.method == "read" { result(preferences.string(forKey: "pocket.skin")); return }
      guard call.method == "write", let skin = arguments["skin"] as? String,
            ["plain", "pixel", "oil"].contains(skin) else {
        result(FlutterError(code: "APPEARANCE", message: "外观设置无效", details: nil)); return
      }
      preferences.set(skin, forKey: "pocket.skin")
      result(nil)
    case "settings": settings(call, arguments: arguments, result: result)
    case "background":
      switch call.method {
      case "start": result(false)
      case "stop": result(nil)
      case "attention": attention(arguments); result(nil)
      default: result(FlutterMethodNotImplemented)
      }
    default: result(FlutterMethodNotImplemented)
    }
  }

  private func finish(_ outcome: Result<Any?, Error>, code: String, result: FlutterResult) {
    switch outcome {
    case .success(let value): result(value)
    case .failure:
      result(FlutterError(code: code, message: "无法读取或保存安全存储，请保留本机数据并重试", details: nil))
    }
  }

  private func cursor(_ call: FlutterMethodCall, arguments: [String: Any], result: @escaping FlutterResult) {
    guard let host = arguments["hostId"] as? String,
          host.range(of: "^[A-Za-z0-9_-]{1,64}$", options: .regularExpression) != nil else {
      result(FlutterError(code: "CURSOR", message: "电脑标识无效", details: nil)); return
    }
    let key = "legacy-cursor:" + host
    if call.method == "read" {
      storage.perform { store in
        guard let text = try store.readState(key) else { return Int64(0) }
        guard let data = text.data(using: .utf8), let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let sequence = value["seq"] as? Int64, sequence >= 0 else { throw PocketStorageError.invalid }
        return sequence
      } completion: { [weak self] in self?.finish($0, code: "CURSOR", result: result) }
    } else if call.method == "write", let number = arguments["seq"] as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(), let sequence = Int64(number.stringValue), sequence >= 0 {
      storage.perform { store in
        let data = try JSONSerialization.data(withJSONObject: ["seq": sequence])
        try store.writeState(key, json: String(decoding: data, as: UTF8.self))
        return nil
      } completion: { [weak self] in self?.finish($0, code: "CURSOR", result: result) }
    } else { result(FlutterError(code: "CURSOR", message: "事件位置无效", details: nil)) }
  }

  private func settings(_ call: FlutterMethodCall, arguments: [String: Any], result: @escaping FlutterResult) {
    let center = UNUserNotificationCenter.current()
    if call.method == "read" {
      center.getNotificationSettings { value in
        Task { @MainActor in
          let allowed = value.authorizationStatus == .authorized || value.authorizationStatus == .provisional
          result(["notifications": allowed && self.preferences.bool(forKey: "pocket.notifications")])
        }
      }
    } else if call.method == "write", let enabled = arguments["notifications"] as? Bool {
      if !enabled {
        preferences.set(false, forKey: "pocket.notifications")
        removeTaskNotifications()
        result(nil)
        return
      }
      center.requestAuthorization(options: [.alert, .sound]) { allowed, _ in
        Task { @MainActor in
          self.preferences.set(allowed, forKey: "pocket.notifications")
          if allowed { result(nil) }
          else { result(FlutterError(code: "SETTINGS", message: "请在系统设置中允许任务提醒", details: nil)) }
        }
      }
    } else { result(FlutterMethodNotImplemented) }
  }

  private func attention(_ arguments: [String: Any]) {
    guard preferences.bool(forKey: "pocket.notifications"),
          let host = arguments["hostId"] as? String, !host.isEmpty, host.utf8.count <= 64,
          let thread = arguments["threadId"] as? String, !thread.isEmpty, thread.utf8.count <= 100,
          let event = arguments["eventId"] as? String, !event.isEmpty, event.utf8.count <= 256,
          let account = arguments["accountId"] as? String, let device = arguments["deviceId"] as? String,
          !recentEvents.contains(event) else { return }
    storage.perform { store in
      guard try store.credential("isBlocked") as? Bool == false,
            let text = try store.credential("read") as? String,
            let data = text.data(using: .utf8), let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            value["accountId"] as? String == account, value["deviceId"] as? String == device,
            value["deviceStatus"] as? String == "approved" else { return false }
      return true
    } completion: { [weak self] outcome in
      guard let self, case .success(let allowed) = outcome, allowed as? Bool == true,
            self.preferences.bool(forKey: "pocket.notifications") else { return }
      self.recentEvents.append(event)
      if self.recentEvents.count > 256 { self.recentEvents.removeFirst() }
      let content = UNMutableNotificationContent()
      content.title = "Agent Pocket"
      content.body = "电脑任务有新的进展，请打开查看。"
      content.sound = .default
      content.userInfo = ["hostId": host, "threadId": thread, "accountId": account, "deviceId": device]
      let identifier = SHA256.hash(data: Data(event.utf8)).map { String(format: "%02x", $0) }.joined()
      UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "pocket-" + identifier,
                                                                  content: content, trigger: nil))
    }
  }

  private func removeTaskNotifications() {
    let center = UNUserNotificationCenter.current()
    center.getPendingNotificationRequests { values in
      UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: values.map(\.identifier).filter { $0.hasPrefix("pocket-") })
    }
    center.getDeliveredNotifications { values in
      UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: values.map { $0.request.identifier }.filter { $0.hasPrefix("pocket-") })
    }
  }

  nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                         willPresent notification: UNNotification,
                                         withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
    completionHandler([.banner, .sound])
  }

  nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                         withCompletionHandler completionHandler: @escaping () -> Void) {
    let info = response.notification.request.content.userInfo
    Task { @MainActor in
      defer { completionHandler() }
      guard let host = info["hostId"] as? String, let thread = info["threadId"] as? String else { return }
      let value = ["hostId": host, "threadId": thread]
      if self.configured { self.configuration.invokeMethod("notification", arguments: value) }
      else { self.pendingNotification = value }
    }
  }
}
