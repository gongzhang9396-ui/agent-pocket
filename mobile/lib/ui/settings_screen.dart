import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter/foundation.dart';
import '../session/pocket_session_service.dart';
import '../session/native_configuration.dart';
import '../update/app_update.dart';
import 'account_devices_screen.dart';
import 'host_pairing_screen.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key, required this.service, required this.onLoginRequired});
  final PocketSessionService service;
  final VoidCallback onLoginRequired;
  @override State<SettingsScreen> createState() => _SettingsScreenState();
}
class _SettingsScreenState extends State<SettingsScreen> {
  late final updater = AppUpdate(widget.service);
  String? message;
  String version = '0.4.0';
  bool busy = false, cancelled = false;
  bool notifications = true;
  static const settings = MethodChannel('agent_pocket/settings');
  double? progress;
  @override void initState() { super.initState(); unawaited(() async {
    final config = await NativeConfiguration.read(); if (mounted) setState(() => version = config['version'] as String? ?? version);
    final values = await settings.invokeMapMethod<String, dynamic>('read'); if (mounted) setState(() => notifications = values?['notifications'] as bool? ?? true);
  }().catchError((Object _) { if (mounted) setState(() => message = '暂时无法读取应用设置'); })); }
  @override void dispose() { cancelled = true; super.dispose(); }
  Future<void> update() async {
    if (busy) return; setState(() { busy = true; cancelled = false; message = '正在检查更新…'; });
    try {
      final value = await updater.check();
      if (!mounted) return;
      if (value == null) { setState(() => message = '已是当前版本'); return; }
      final install = await showDialog<bool>(context: context, builder: (ctx) => AlertDialog(title: Text('更新到 ${value.version}'),
        content: Text('安装包 ${(value.size / 1024 / 1024).toStringAsFixed(1)} MiB。下载完成后由系统确认安装。'),
        actions: [TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('稍后')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('下载更新'))]));
      if (install != true || !mounted) return;
      setState(() { progress = 0; message = '正在下载并验证更新…'; });
      await updater.downloadAndInstall(value, cancelled: () => cancelled || !mounted, progress: (bytes, total) { if (mounted) setState(() => progress = bytes / total); });
      if (mounted) setState(() => message = '已打开系统安装确认');
    } catch (error) { if (mounted) setState(() => message = '更新未完成：$error'); }
    finally { if (mounted) setState(() { busy = false; progress = null; }); }
  }
  Future<void> password() async {
    final current = TextEditingController(), next = TextEditingController(), repeat = TextEditingController();
    try {
      final accepted = await showDialog<bool>(context: context, builder: (ctx) => AlertDialog(title: const Text('修改账号密码'),
        content: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: current, obscureText: true, decoration: const InputDecoration(labelText: '当前密码')),
          const SizedBox(height: 12), TextField(controller: next, obscureText: true, decoration: const InputDecoration(labelText: '新密码（12–128 位）')),
          const SizedBox(height: 12), TextField(controller: repeat, obscureText: true, decoration: const InputDecoration(labelText: '再次输入新密码')),
        ])), actions: [TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('返回')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('修改'))]));
      if (accepted != true || !mounted) return;
      if (next.text != repeat.text) { setState(() => message = '两次新密码不一致'); return; }
      setState(() { busy = true; message = null; });
      try { await widget.service.changePassword(current.text, next.text); if (mounted) setState(() => message = '密码已修改，其他登录会话已退出'); }
      catch (_) { if (mounted) setState(() => message = '修改未完成或结果待确认，请核对当前密码；不会自动重复提交'); }
      finally { if (mounted) setState(() => busy = false); }
    } finally { current.dispose(); next.dispose(); repeat.dispose(); }
  }
  @override Widget build(BuildContext context) => Scaffold(appBar: AppBar(title: const Text('设置')),
    body: ListView(padding: const EdgeInsets.all(16), children: [
      ListTile(title: const Text('账号设备'), subtitle: const Text('批准新设备、查看和撤销设备'), leading: const Icon(Icons.devices),
        onTap: busy ? null : () => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => AccountDevicesScreen(service: widget.service)))),
      ListTile(title: const Text('绑定电脑'), leading: const Icon(Icons.qr_code_scanner), onTap: busy ? null : () => Navigator.push(context,
        MaterialPageRoute<void>(builder: (_) => HostPairingScreen(service: widget.service)))),
      SwitchListTile(title: const Text('任务提醒'), subtitle: Text(defaultTargetPlatform == TargetPlatform.iOS
        ? '应用打开时提醒，回到前台后同步任务' : '任务完成或需要处理时通知'), value: notifications,
        onChanged: busy ? null : (value) async { try { await settings.invokeMethod<void>('write', {'notifications': value}); if (mounted) setState(() => notifications = value); }
          catch (_) { if (mounted) setState(() => message = '设置保存失败'); } }),
      ListTile(title: const Text('修改密码'), leading: const Icon(Icons.lock_outline), onTap: busy ? null : () => unawaited(password())),
      if (defaultTargetPlatform == TargetPlatform.iOS)
        ListTile(title: const Text('版本信息'), subtitle: Text('当前版本 $version · 通过电脑安装测试版本'), leading: const Icon(Icons.info_outline))
      else
        ListTile(title: const Text('检查更新'), subtitle: Text('当前版本 $version'), leading: const Icon(Icons.system_update), onTap: busy ? null : () => unawaited(update())),
      if (progress != null) LinearProgressIndicator(value: progress),
      if (busy && progress != null) TextButton(onPressed: () => setState(() => cancelled = true), child: const Text('取消下载')),
      if (message != null) Padding(padding: const EdgeInsets.all(16), child: Text(message!)),
      const Divider(),
      ListTile(title: const Text('重新登录'), subtitle: const Text('保留已批准的设备身份'), leading: const Icon(Icons.login), onTap: busy ? null : () {
        Navigator.pop(context); widget.onLoginRequired();
      }),
      ListTile(title: const Text('退出并清除本机登录身份'), leading: const Icon(Icons.logout), onTap: busy ? null : () async {
        final accepted = await showDialog<bool>(context: context, builder: (ctx) => AlertDialog(title: const Text('清除本机登录身份？'),
          content: const Text('清除后，再次登录将作为新设备申请批准。服务器上的任务会保留。'), actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('返回')),
            FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('退出并清除'))]));
        if (accepted != true || !mounted) return;
        setState(() => busy = true);
        try { await widget.service.forgetDevice(); if (context.mounted) { Navigator.pop(context); widget.onLoginRequired(); } }
        catch (_) { if (mounted) setState(() { busy = false; message = '无法完成退出，请保留数据并重试'; }); }
      }),
    ]));
}
