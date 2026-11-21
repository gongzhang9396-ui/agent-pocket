import 'dart:async';
import 'package:flutter/material.dart';
import 'session/pocket_session_service.dart';
import 'session/session_manager.dart';
import 'tasks/workspace_controller.dart';
import 'ui/workspace_screen.dart';
import 'ui/appearance.dart';
import 'session/native_configuration.dart';
import 'dart:convert';
import 'package:crypto/crypto.dart';
import 'ui/scan_screen.dart';
import 'ui/host_pairing_screen.dart';
import 'session/account_devices.dart';
import 'session/android_credential_store.dart';

void main() => runApp(const PocketDevelopmentApp());

class PocketDevelopmentApp extends StatefulWidget {
  const PocketDevelopmentApp({super.key});
  @override State<PocketDevelopmentApp> createState() => _PocketDevelopmentAppState();
}

class _PocketDevelopmentAppState extends State<PocketDevelopmentApp> {
  final appearance = AppearanceController();
  @override void initState() { super.initState(); unawaited(appearance.load()); }
  @override void dispose() { appearance.dispose(); super.dispose(); }
  @override Widget build(BuildContext context) => AnimatedBuilder(animation: appearance, builder: (context, _) => MaterialApp(
    title: 'Agent Pocket', theme: appearance.skin.theme(),
    home: _DevelopmentEntry(skin: appearance.skin, onSkinChange: appearance.select),
  ));
}

enum _EntryPhase { loading, missing, login, pending, ready, failed }

class _DevelopmentEntry extends StatefulWidget {
  const _DevelopmentEntry({required this.skin, required this.onSkinChange});
  final PocketSkin skin;
  final Future<void> Function(PocketSkin) onSkinChange;
  @override State<_DevelopmentEntry> createState() => _DevelopmentEntryState();
}

class _DevelopmentEntryState extends State<_DevelopmentEntry> {
  final _password = TextEditingController();
  final _newUsername = TextEditingController(), _relay = TextEditingController();
  String _deviceName = 'Android';
  String? _verificationCode;
  bool _advanced = false;
  Timer? _approvalTimer;
  String? _pendingPairing;
  Map<String, dynamic>? _pendingNotification;
  final _invite = TextEditingController();
  bool _useInvite = false;
  PocketSessionService? _service;
  WorkspaceController? _workspace;
  _EntryPhase _phase = _EntryPhase.loading;
  String? _username;
  String? _error;
  bool _busy = false;
  int _entryGeneration = 0;

  @override void initState() {
    super.initState();
    NativeConfiguration.channel.setMethodCallHandler((call) async {
      if (call.method == 'link' && call.arguments is Map && call.arguments['uri'] is String) await _handleLink(call.arguments['uri'] as String);
      if (call.method == 'notification' && call.arguments is Map) await _openNotification(Map<String, dynamic>.from(call.arguments as Map));
    });
    unawaited(_load());
  }
  @override void dispose() { _entryGeneration++; _approvalTimer?.cancel(); _password.dispose(); _newUsername.dispose(); _relay.dispose(); _invite.dispose(); super.dispose(); }

  Future<void> _load() async {
    final generation = ++_entryGeneration;
    try {
      final service = await PocketSessionService.shared();
      if (!mounted || generation != _entryGeneration) return;
      _service = service;
      final config = await NativeConfiguration.read();
      if (!mounted || generation != _entryGeneration) return;
      if (_relay.text.isEmpty) _relay.text = config['defaultRelayUrl'] as String? ?? '';
      _deviceName = config['deviceName'] as String? ?? 'Android';
      final pending = await AndroidCredentialStore.readPendingHost();
      if (!mounted || generation != _entryGeneration) return;
      if (_pendingPairing == null && pending != null) {
        _pendingPairing = Uri(scheme: 'agentpocket', host: 'relay-host', queryParameters: {
          'relay': pending['endpoint'] as String, 'enrollmentId': pending['enrollmentId'] as String, 'secret': pending['secret'] as String}).toString();
      }
      if (config['initialLink'] is String) await _handleLink(config['initialLink'] as String, opening: false);
      if (config['notification'] is Map) _pendingNotification = Map<String, dynamic>.from(config['notification'] as Map);
      try {
        final session = await service.sessions.snapshot(approvedOnly: false);
        if (!mounted || generation != _entryGeneration) return;
        if (session.credentials['deviceStatus'] == 'approved' && session.credentials['contentKey'] is String &&
            (session.credentials['contentKey'] as String).isNotEmpty) {
          _workspace = WorkspaceController.fromService(service);
          unawaited(service.background.start());
          _approvalTimer?.cancel();
          if (mounted) setState(() => _phase = _EntryPhase.ready);
          if (_pendingPairing != null) {
            final value = _pendingPairing!; _pendingPairing = null;
            WidgetsBinding.instance.addPostFrameCallback((_) { if (mounted) {
              Navigator.push(context, MaterialPageRoute<void>(
              builder: (_) => HostPairingScreen(service: service, initialCode: value)));
            } });
          }
          if (_pendingNotification != null) {
            final value = _pendingNotification!; _pendingNotification = null;
            WidgetsBinding.instance.addPostFrameCallback((_) => unawaited(_openNotification(value)));
          }
        } else if (session.credentials['deviceStatus'] == 'pending') {
          final hex = sha256.convert(utf8.encode('agent-pocket-device-v1\u0000${session.credentials['deviceId']}\u0000${session.credentials['deviceEncryptionPublicKey']}')).bytes
            .take(8).map((byte) => byte.toRadixString(16).padLeft(2, '0')).join().toUpperCase();
          _verificationCode = List.generate(4, (index) => hex.substring(index * 4, index * 4 + 4)).join(' ');
          _approvalTimer?.cancel();
          _approvalTimer = Timer.periodic(const Duration(seconds: 4), (_) { if (!_busy && _phase == _EntryPhase.pending) unawaited(_checkApproval()); });
          if (mounted) setState(() => _phase = _EntryPhase.pending);
        } else {
          if (mounted) setState(() { _phase = _EntryPhase.failed; _error = '设备身份不完整，请保留本机应用数据并联系管理员恢复'; });
        }
      } on SignInRequired {
        final stored = await service.sessions.store.load();
        if (!mounted || generation != _entryGeneration) return;
        if (mounted) { setState(() {
          _username = stored?['username'] is String ? stored!['username'] as String : null;
          _phase = stored == null ? _EntryPhase.missing : _EntryPhase.login;
        }); }
      }
    } catch (_) {
      if (mounted && generation == _entryGeneration) setState(() { _phase = _EntryPhase.failed; _error = '无法读取原有设备身份，请保留本机应用数据并联系管理员恢复'; });
    }
  }

  Future<void> _handleLink(String value, {bool opening = true}) async {
    try {
      final code = HostPairingCode.parse(value);
      await AndroidCredentialStore.savePendingHost({'endpoint': code.endpoint, 'enrollmentId': code.enrollmentId, 'secret': code.secret, 'capturedAt': DateTime.now().millisecondsSinceEpoch});
      if (!mounted) return;
      setState(() { _pendingPairing = value; if (_phase == _EntryPhase.missing || _phase == _EntryPhase.loading) _relay.text = code.endpoint; });
      if (opening && _phase == _EntryPhase.ready && _service != null) {
        _pendingPairing = null;
        await Navigator.push(context, MaterialPageRoute<void>(builder: (_) => HostPairingScreen(service: _service!, initialCode: value)));
      }
    } catch (_) { if (mounted) setState(() => _error = '配对链接无法读取，请确认来自自己的电脑'); }
  }
  Future<void> _openNotification(Map<String, dynamic> value) async {
    final hostId = value['hostId'], threadId = value['threadId'];
    if (hostId is! String || hostId.isEmpty || hostId.length > 64 || threadId is! String || threadId.isEmpty || threadId.length > 100) return;
    final workspace = _workspace;
    if (_phase != _EntryPhase.ready || workspace == null) { _pendingNotification = value; return; }
    try {
      await workspace.refresh();
      if (!mounted || _workspace != workspace) return;
      final host = workspace.hosts.where((host) => host.id == hostId).firstOrNull;
      if (host == null) return;
      await workspace.selectHost(host);
      if (mounted && _workspace == workspace) await workspace.openTask(threadId);
    } catch (_) { /* A revoked/offline host remains inaccessible. */ }
  }

  Future<void> _login() async {
    if (_busy || _service == null || _password.text.isEmpty) return;
    setState(() { _busy = true; _error = null; });
    try {
      if (_phase == _EntryPhase.missing) {
        final invite = _useInvite ? Uri.tryParse(_invite.text.trim()) : null;
        await _service!.enrollment.login(_relay.text.trim(), _newUsername.text.trim(), _password.text, _deviceName,
          inviteId: invite?.queryParameters['inviteId'], inviteSecret: invite?.queryParameters['secret']);
      } else { await _service!.loginExisting(_password.text); }
      if (!mounted) return;
      _password.clear();
      await _load();
    } catch (error) { if (mounted) setState(() => _error = '登录未完成：$error。设备身份已保留'); }
    finally { if (mounted) setState(() => _busy = false); }
  }

  Future<void> _checkApproval() async {
    if (_busy || _service == null) return;
    setState(() { _busy = true; _error = null; });
    try {
      if (await _service!.checkPendingDevice()) { await _load(); }
      else if (mounted) { setState(() => _error = '仍在等待已信任设备批准'); }
    } on SignInRequired {
      if (mounted) setState(() { _phase = _EntryPhase.login; _error = '登录已失效，请重新登录'; });
    } catch (_) { if (mounted) setState(() => _error = '暂时无法检查设备状态，请稍后重试'); }
    finally { if (mounted) setState(() => _busy = false); }
  }

  Future<void> _requireLogin() async {
    if (_phase != _EntryPhase.ready) return;
    final generation = ++_entryGeneration;
    setState(() { _workspace = null; _phase = _EntryPhase.loading; });
    try {
      await _service?.sessions.requireLogin();
      await _service?.background.stop();
      final stored = await _service?.sessions.store.load();
      if (!mounted || generation != _entryGeneration) return;
      if (mounted) { setState(() {
        _workspace = null;
        _username = stored?['username'] is String ? stored!['username'] as String : null;
        _phase = stored == null ? _EntryPhase.missing : _EntryPhase.login;
        _error = null;
      }); }
    } catch (_) {
      if (mounted && generation == _entryGeneration) setState(() { _workspace = null; _phase = _EntryPhase.failed; _error = '无法读取原有设备身份，请保留本机应用数据并联系管理员恢复'; });
    }
  }

  @override Widget build(BuildContext context) {
    if (_phase == _EntryPhase.ready && _workspace != null) {
      return WorkspaceScreen(controller: _workspace!, onLoginRequired: () => unawaited(_requireLogin()),
        skin: widget.skin, onSkinChange: widget.onSkinChange);
    }
    return Scaffold(
      backgroundColor: Theme.of(context).scaffoldBackgroundColor,
      appBar: AppBar(title: const Text('Agent Pocket'), backgroundColor: Theme.of(context).scaffoldBackgroundColor),
      body: SafeArea(child: Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 420),
        child: SingleChildScrollView(padding: const EdgeInsets.all(24), child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
            if (_phase == _EntryPhase.loading) const Center(child: CircularProgressIndicator())
            else if (_phase == _EntryPhase.failed) Text(_error ?? '设备身份无法读取')
            else if (_phase == _EntryPhase.pending) ...[
              const Text('新设备等待批准', style: TextStyle(fontSize: 22)),
              const SizedBox(height: 12), const Text('请在已信任设备上批准，然后检查状态。'),
              if (_verificationCode != null) Padding(padding: const EdgeInsets.only(top: 16), child: SelectableText('设备核对码：$_verificationCode')),
              const SizedBox(height: 20), FilledButton(onPressed: _busy ? null : () => unawaited(_checkApproval()), child: const Text('检查批准状态')),
            ] else if (_phase == _EntryPhase.login || _phase == _EntryPhase.missing) ...[
              Text(_phase == _EntryPhase.missing ? '登录 Agent Pocket' : '重新登录', style: const TextStyle(fontSize: 22)),
              if (_username != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_username!)),
              if (_phase == _EntryPhase.missing) ...[
                if (_relay.text.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 8), child: Text(Uri.tryParse(_relay.text)?.host ?? _relay.text)),
                const SizedBox(height: 12), OutlinedButton.icon(onPressed: _busy ? null : () async {
                  final value = await Navigator.push<String>(context, MaterialPageRoute(builder: (_) => const ScanScreen()));
                  if (value == null || !mounted) return;
                  try {
                    final code = HostPairingCode.parse(value);
                    await AndroidCredentialStore.savePendingHost({'endpoint': code.endpoint, 'enrollmentId': code.enrollmentId, 'secret': code.secret, 'capturedAt': DateTime.now().millisecondsSinceEpoch});
                    if (mounted) setState(() { _relay.text = code.endpoint; _pendingPairing = value; _error = null; });
                  } catch (_) { if (mounted) setState(() => _error = '二维码不是有效的电脑配对码'); }
                }, icon: const Icon(Icons.qr_code_scanner), label: const Text('扫描电脑配对码')),
                const SizedBox(height: 16), TextField(controller: _newUsername, enabled: !_busy, autofillHints: const [AutofillHints.username],
                  decoration: const InputDecoration(labelText: '账号')),
                if (_advanced || _relay.text.isEmpty) ...[const SizedBox(height: 16), TextField(controller: _relay, enabled: !_busy,
                  decoration: const InputDecoration(labelText: '服务器地址'))]
                else Align(alignment: Alignment.centerRight, child: TextButton(onPressed: () => setState(() => _advanced = true), child: const Text('连接设置'))),
                if (_advanced) SwitchListTile(contentPadding: EdgeInsets.zero, title: const Text('使用邀请链接'), value: _useInvite,
                  onChanged: _busy ? null : (value) => setState(() => _useInvite = value)),
                if (_useInvite) TextField(controller: _invite, enabled: !_busy, decoration: const InputDecoration(labelText: '邀请链接')),
              ],
              const SizedBox(height: 16), TextField(controller: _password, obscureText: true,
                enabled: !_busy, decoration: const InputDecoration(labelText: '密码', border: OutlineInputBorder()),
                onSubmitted: (_) => unawaited(_login())),
              const SizedBox(height: 16), FilledButton(onPressed: _busy ? null : () => unawaited(_login()), child: const Text('登录')),
            ],
            if (_error != null && _phase != _EntryPhase.failed) ...[const SizedBox(height: 16), Text(_error!, style: const TextStyle(color: Colors.redAccent))],
          ],
        )),
      ))),
    );
  }
}
