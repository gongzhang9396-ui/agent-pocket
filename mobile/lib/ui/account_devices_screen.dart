import 'dart:async';
import 'package:flutter/material.dart';
import '../session/pocket_session_service.dart';
import '../session/session_manager.dart';
import '../session/account_devices.dart';

class AccountDevicesScreen extends StatefulWidget {
  const AccountDevicesScreen({super.key, required this.service});
  final PocketSessionService service;
  @override State<AccountDevicesScreen> createState() => _AccountDevicesScreenState();
}
class _AccountDevicesScreenState extends State<AccountDevicesScreen> {
  List<Map<String, dynamic>> devices = const [];
  SessionRef? session;
  bool busy = false;
  String? error;
  @override void initState() { super.initState(); unawaited(load()); }
  Future<void> load() async {
    if (busy) return; setState(() { busy = true; error = null; });
    try {
      final ref = await widget.service.sessions.snapshot();
      final rows = await widget.service.accountDevices.devices(ref);
      if (mounted && widget.service.sessions.isCurrent(ref)) setState(() { session = ref; devices = rows; });
    } catch (_) { if (mounted) setState(() => error = '无法读取设备，请检查登录和网络'); }
    finally { if (mounted) setState(() => busy = false); }
  }
  Future<void> act(Map<String, dynamic> device, bool approve) async {
    if (busy || session == null) return;
    final confirmed = await showDialog<bool>(context: context, builder: (ctx) => AlertDialog(title: Text(approve ? '批准新设备' : '撤销设备'),
      content: Text(approve ? '请核对新设备显示的核对码：\n\n${deviceVerificationCode(device['id'] as String, device['encryption_public_key'] as String)}\n\n批准后它将获得账号密钥和任务访问权限。'
        : '撤销 ${device['name']} 后，该设备将无法继续访问账号。'), actions: [TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('返回')),
        FilledButton(onPressed: () => Navigator.pop(ctx, true), child: Text(approve ? '核对一致，批准' : '撤销'))]));
    if (confirmed != true || !mounted) return;
    setState(() { busy = true; error = null; });
    try {
      if (approve) { await widget.service.accountDevices.approve(session!, device); }
      else { await widget.service.accountDevices.revoke(session!, device['id'] as String); }
    } catch (_) { if (mounted) setState(() => error = '操作结果待确认，请刷新列表查看；不会自动重复提交'); }
    finally { if (mounted) setState(() => busy = false); }
    if (mounted) await load();
  }
  @override Widget build(BuildContext context) => Scaffold(appBar: AppBar(title: const Text('账号设备'), actions: [IconButton(onPressed: busy ? null : load, icon: const Icon(Icons.refresh))]),
    body: ListView(padding: const EdgeInsets.all(16), children: [
      if (busy) const LinearProgressIndicator(), if (error != null) Text(error!),
      for (final device in devices) Card(child: ListTile(title: Text(device['name'] as String), isThreeLine: device['status'] == 'pending',
        subtitle: Text(device['status'] == 'pending' ? '等待批准\n${deviceVerificationCode(device['id'] as String, device['encryption_public_key'] as String)}'
          : device['status'] == 'approved' ? (device['id'] == session?.credentials['deviceId'] ? '已批准 · 本机' : '已批准') : '已撤销'),
        trailing: device['status'] == 'revoked' || device['id'] == session?.credentials['deviceId'] ? null
          : TextButton(onPressed: busy ? null : () => unawaited(act(device, device['status'] == 'pending')), child: Text(device['status'] == 'pending' ? '批准' : '撤销')))),
    ]));
}
