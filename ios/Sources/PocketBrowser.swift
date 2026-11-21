import CryptoKit
import SwiftUI
import WebKit

@MainActor
final class PocketBrowser: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate {
    let address: RelayAddress
    let webView: WKWebView
    @Published private(set) var isLoading = true
    @Published private(set) var failure: String?
    @Published var externalLink: URL?
    private var loadingObservation: NSKeyValueObservation?
    private var deadline: Task<Void, Never>?

    init(address: RelayAddress) {
        self.address = address
        let configuration = WKWebViewConfiguration()
        // Independent persistent WebKit profile per Relay, separate from Safari.
        let digest = Array(SHA256.hash(data: Data(address.displayName.utf8)))
        let uuid = UUID(uuid: (digest[0], digest[1], digest[2], digest[3], digest[4], digest[5],
                               digest[6], digest[7], digest[8], digest[9], digest[10], digest[11],
                               digest[12], digest[13], digest[14], digest[15]))
        configuration.websiteDataStore = WKWebsiteDataStore(forIdentifier: uuid)
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.applicationNameForUserAgent = "AgentPocket-iOS/0.1"
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        webView.scrollView.backgroundColor = .systemBackground
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        loadingObservation = webView.observe(\.isLoading, options: [.new]) { [weak self] _, _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.isLoading = self.webView.isLoading
            }
        }
        load()
    }

    func load() {
        failure = nil
        isLoading = true
        webView.load(URLRequest(url: address.appURL, cachePolicy: .useProtocolCachePolicy, timeoutInterval: 25))
        deadline?.cancel()
        deadline = Task { [weak self] in
            try? await Task.sleep(for: .seconds(30))
            guard !Task.isCancelled, let self, self.isLoading else { return }
            self.webView.stopLoading()
            self.isLoading = false
            self.failure = "连接时间较长。请检查网络和服务器状态，然后重试。"
        }
    }

    func resume() {
        guard let current = webView.url, address.allowsAppNavigation(current), failure == nil else { return }
        // Use the existing web client's reconnect path, retaining drafts and write receipts.
        webView.evaluateJavaScript("document.dispatchEvent(new Event('visibilitychange'))", completionHandler: nil)
    }

    func stop() {
        deadline?.cancel()
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        // Replace the document so its WebSockets and plaintext memory are released.
        webView.loadHTMLString("", baseURL: nil)
        loadingObservation?.invalidate()
        loadingObservation = nil
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        let mainFrame = action.targetFrame?.isMainFrame ?? true
        if address.allowsAppNavigation(url) {
            if action.targetFrame == nil {
                decisionHandler(.cancel)
                webView.load(action.request)
            } else {
                decisionHandler(.allow)
            }
            return
        }
        decisionHandler(.cancel)
        guard mainFrame, action.navigationType == .linkActivated else {
            if mainFrame {
                failure = "页面试图离开已配置的服务器。请检查服务器地址与 HTTPS 配置。"
                isLoading = false
            }
            return
        }
        if RelayAddress.isExternalUserLink(url) || RelayAddress.isAuthenticatorLink(url) {
            externalLink = url
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void) {
        guard let url = response.response.url, address.allowsAppNavigation(url), response.canShowMIMEType else {
            decisionHandler(.cancel)
            if response.isForMainFrame { failure = "服务器未返回可显示的 Agent Pocket 页面。"; isLoading = false }
            return
        }
        if let http = response.response as? HTTPURLResponse, http.statusCode >= 400 {
            decisionHandler(.cancel)
            failure = "服务器返回 HTTP \(http.statusCode)。请确认已部署并启用了网页版 /app/。"
            isLoading = false
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        deadline?.cancel()
        isLoading = false
        failure = nil
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        fail(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        fail(error)
    }

    private func fail(_ error: Error) {
        let code = (error as NSError).code
        if code == NSURLErrorCancelled { return }
        deadline?.cancel()
        isLoading = false
        if [NSURLErrorServerCertificateUntrusted, NSURLErrorServerCertificateHasBadDate,
            NSURLErrorServerCertificateHasUnknownRoot, NSURLErrorSecureConnectionFailed].contains(code) {
            failure = "无法验证服务器的 HTTPS 证书。请修复服务器证书后重试。"
        } else {
            failure = "暂时无法连接服务器。请检查网络后重试。"
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        deadline?.cancel()
        isLoading = false
        failure = "iOS 已回收网页进程。重新打开后，请先核对上一条消息的结果；未发送的草稿可能需要重新输入。"
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // All new windows are handled by the navigation policy; no unbounded browser is created.
        nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable () -> Void) {
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable (Bool) -> Void) {
        // A hidden JavaScript dialog must never authorize an operation.
        completionHandler(false)
    }
}

struct PocketWebView: UIViewRepresentable {
    let browser: PocketBrowser
    func makeUIView(context: Context) -> WKWebView { browser.webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
    static func dismantleUIView(_ uiView: WKWebView, coordinator: ()) {
        uiView.stopLoading()
    }
}

