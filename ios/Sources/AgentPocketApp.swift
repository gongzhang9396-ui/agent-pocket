import SwiftUI

@main
struct AgentPocketApp: App {
    var body: some Scene { WindowGroup { PocketRoot() } }
}

struct PocketRoot: View {
    @AppStorage("relayOrigin") private var relayOrigin = ""
    @Environment(\.scenePhase) private var scenePhase
    @State private var address: RelayAddress?
    @State private var settingsPresented = false

    init() {
        _address = State(initialValue: RelayAddress.initialAddress(
            saved: UserDefaults.standard.string(forKey: "relayOrigin") ?? "",
            bundledDefault: Bundle.main.object(forInfoDictionaryKey: "AgentPocketDefaultRelayOrigin") as? String
        ))
    }

    var body: some View {
        Group {
            if let address {
                ConnectedPocket(address: address, onSettings: { settingsPresented = true })
                    .id(address.displayName)
            } else {
                RelaySetup(current: relayOrigin, canCancel: false, onSave: connect)
            }
        }
        .tint(Color(red: 0.0, green: 0.47, blue: 0.41))
        .sheet(isPresented: $settingsPresented) {
            RelaySetup(current: address?.displayName ?? relayOrigin, canCancel: true, onSave: connect)
        }
        .overlay {
            if scenePhase != .active {
                ZStack {
                    Color(.systemBackground).ignoresSafeArea()
                    Label("Agent Pocket", systemImage: "lock.shield")
                        .font(.title2).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func connect(_ next: RelayAddress) {
        relayOrigin = next.displayName
        address = next
        settingsPresented = false
    }
}

private struct ConnectedPocket: View {
    @StateObject private var browser: PocketBrowser
    @Environment(\.scenePhase) private var phase
    @Environment(\.openURL) private var openURL
    let onSettings: () -> Void

    init(address: RelayAddress, onSettings: @escaping () -> Void) {
        _browser = StateObject(wrappedValue: PocketBrowser(address: address))
        self.onSettings = onSettings
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Image(systemName: "lock.fill").font(.caption)
                Text(browser.address.origin.host ?? "Agent Pocket")
                    .font(.caption).lineLimit(1).truncationMode(.middle)
                Spacer()
                Button(action: onSettings) { Image(systemName: "gearshape") }
                    .accessibilityLabel("服务器设置")
                    .frame(minWidth: 44, minHeight: 40)
            }
            .padding(.leading, 16).padding(.trailing, 4)
            .foregroundStyle(.secondary)
            Divider()
            ZStack {
                PocketWebView(browser: browser)
                if browser.isLoading && browser.failure == nil {
                    VStack(spacing: 12) {
                        ProgressView()
                        Text("正在连接 Agent Pocket…").font(.callout).foregroundStyle(.secondary)
                    }
                    .padding(24).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
                    .allowsHitTesting(false)
                }
                if let failure = browser.failure {
                    VStack(spacing: 18) {
                        Image(systemName: "wifi.exclamationmark").font(.largeTitle).foregroundStyle(.secondary)
                        Text("连接暂时不可用").font(.title3.weight(.semibold))
                        Text(failure).multilineTextAlignment(.center).foregroundStyle(.secondary)
                        Button("重新打开", action: browser.load).buttonStyle(.borderedProminent)
                        Button("检查服务器地址", action: onSettings)
                        Text("重新打开只加载页面，不会自动重发消息。")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    .padding(28).frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color(.systemBackground))
                }
            }
        }
        .background(Color(.systemBackground))
        .confirmationDialog("离开 Agent Pocket", isPresented: Binding(
            get: { browser.externalLink != nil },
            set: { if !$0 { browser.externalLink = nil } }
        ), titleVisibility: .visible, presenting: browser.externalLink) { url in
            Button(RelayAddress.isAuthenticatorLink(url) ? "在验证器中打开" : "在外部应用中打开") {
                browser.externalLink = nil
                openURL(url)
            }
        } message: { url in
            Text(RelayAddress.isAuthenticatorLink(url)
                 ? "将验证器绑定链接交给系统打开；也可取消并在页面内手动添加。"
                 : "目标：\(url.host ?? url.scheme ?? "外部链接")")
        }
        .onChange(of: phase) { _, next in if next == .active { browser.resume() } }
        .onDisappear { browser.stop() }
    }
}

private struct RelaySetup: View {
    @Environment(\.dismiss) private var dismiss
    @State private var input: String
    @State private var validationError: String?
    @State private var pending: RelayAddress?
    @State private var confirmSwitch = false
    let current: String
    let canCancel: Bool
    let onSave: (RelayAddress) -> Void

    init(current: String, canCancel: Bool, onSave: @escaping (RelayAddress) -> Void) {
        self.current = current
        self.canCancel = canCancel
        self.onSave = onSave
        _input = State(initialValue: current)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 12) {
                        Image(systemName: "terminal.fill").font(.largeTitle).foregroundStyle(.tint)
                        Text("Agent Pocket").font(.largeTitle.weight(.semibold))
                        Text("随时查看电脑上的任务，继续对话与处理审批。")
                            .foregroundStyle(.secondary)
                    }.padding(.vertical, 12)
                }
                Section("服务器地址") {
                    TextField("https://relay.example.com", text: $input)
                        .keyboardType(.URL).textContentType(.URL)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .accessibilityLabel("服务器 HTTPS 地址")
                        .onSubmit(save)
                    if let validationError { Text(validationError).foregroundStyle(.red).font(.footnote) }
                    Button("连接服务器", action: save).disabled(input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                Section("首次使用") {
                    Text("连接后使用现有账号登录。如果提示批准新设备，请在已有 Android 客户端的账号设备列表中确认。")
                    Text("本版在独立的 iOS 应用内运行现有网页版，使用同一套加密、任务与审批流程。功能随服务器部署的网页版提供。")
                    Text("服务器需要启用 /app/。应用前台接收实时进度；后台不会保持长连接，也暂不提供系统推送。")
                }.font(.callout)
                if canCancel {
                    Section {
                        Text("切换服务器会关闭当前页面，未发送的草稿可能丢失。原服务器的加密设备记录会保留，再次连接可继续登录。")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle(canCancel ? "服务器设置" : "欢迎使用")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if canCancel { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } } }
            }
            .confirmationDialog("切换服务器？", isPresented: $confirmSwitch, titleVisibility: .visible) {
                Button("切换并打开登录页") { if let pending { onSave(pending) } }
            } message: { Text("请先处理当前页面中待确认的操作，并保存尚未发送的内容。") }
        }
    }

    private func save() {
        do {
            let next = try RelayAddress(input)
            validationError = nil
            if canCancel && next.displayName != current { pending = next; confirmSwitch = true }
            else { onSave(next); dismiss() }
        } catch { validationError = error.localizedDescription }
    }
}

