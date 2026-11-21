import 'dart:async';
import 'package:flutter/material.dart';
import '../session/account_devices.dart';
import '../session/pocket_session_service.dart';
import '../session/session_manager.dart';
import 'scan_screen.dart';
import '../session/android_credential_store.dart';

class HostPairingScreen extends StatefulWidget {
  const HostPairingScreen({super.key, required this.service, this.initialCode = ''});
  final PocketSessionService service;
  final String initialCode;
  @override State<HostPairingScreen> createState() => _HostPairingScreenState();
}
class _HostPairingScreenState extends State<HostPairingScreen> {
  final input = TextEditingController(), name = TextEditingController();
  Map<String, dynamic>? host;
  HostPairingCode? code;
  SessionRef? session;
  String? message;
  bool busy = false;
  bool submitted = false;
  @override void initState() { super.initState(); input.text = widget.initialCode; }
  @override void dispose() { input.dispose(); name.dispose(); super.dispose(); }
  Future<void> inspect() async {
    setState(() { busy = true; message = null; host = null; });
    try {
      final parsed = HostPairingCode.parse(input.text), ref = await widget.service.sessions.snapshot();
      final value = await widget.service.accountDevices.inspectHost(ref, parsed);
      if (mounted) setState(() { host = value; code = parsed; session = ref; name.text = value['requested_name'] as String; submitted = value['approved_account_id'] != null; });
      if (value['approved_account_id'] == ref.credentials['accountId']) await _clearPending(parsed);
    } catch (error) { if (mounted) setState(() => message = '读取未完成：$error'); }
    finally { if (mounted) setState(() => busy = false); }
  }
  Future<void> approve() async {
    if (code == null || host == null || session == null || busy || submitted) return;
    setState(() { busy = true; submitted = true; message = null; });
    try { await widget.service.accountDevices.approveHost(session!, code!, host!, name.text.trim());
      await _clearPending(code!);
      if (mounted) setState(() => message = '已确认绑定，请保持电脑配对助手打开，并刷新查看连接状态。');
    } catch (_) { if (mounted) setState(() => message = '绑定结果待确认，请查询状态后再操作；不会自动重复提交。'); }
    finally { if (mounted) setState(() => busy = false); }
  }
  Future<void> _clearPending(HostPairingCode parsed) async {
    final pending = await AndroidCredentialStore.readPendingHost();
    if (pending?['enrollmentId'] == parsed.enrollmentId && pending?['secret'] == parsed.secret && pending?['endpoint'] == parsed.endpoint) {
      await AndroidCredentialStore.clearPendingHost();
    }
  }
  @override Widget build(BuildContext context) => Scaffold(appBar: AppBar(title: const Text('绑定电脑')),
    body: ListView(padding: const EdgeInsets.all(20), children: [
      const Text('在电脑上打开 Agent Pocket 配对助手，粘贴其中的配对链接。配对码有效期为 5 分钟。'), const SizedBox(height: 16),
      TextButton.icon(onPressed: busy ? null : () async {
        final value = await Navigator.push<String>(context, MaterialPageRoute(builder: (_) => const ScanScreen()));
        if (value != null && mounted) setState(() { input.text = value; host = null; });
      }, icon: const Icon(Icons.qr_code_scanner), label: const Text('扫描二维码')),
      TextField(controller: input, enabled: !busy, minLines: 2, maxLines: 5, decoration: const InputDecoration(labelText: '电脑配对码或链接')),
      const SizedBox(height: 12), TextButton(onPressed: busy ? null : () => unawaited(inspect()), child: const Text('读取 / 查询状态')),
      if (host != null) ...[
        TextField(controller: name, enabled: !busy && host!['approved_account_id'] == null, decoration: const InputDecoration(labelText: '电脑名称')),
        const SizedBox(height: 12), SelectableText('签名公钥：${host!['signing_public_key']}\n\n加密公钥：${host!['encryption_public_key']}'),
        const SizedBox(height: 12), const Text('确认这是自己电脑上的配对助手后再允许绑定。'),
        if (host!['approved_account_id'] == null) FilledButton(onPressed: busy || submitted ? null : () => unawaited(approve()), child: const Text('确认绑定这台电脑')),
      ],
      if (busy) const LinearProgressIndicator(), if (message != null) Text(message!),
    ]));
}
