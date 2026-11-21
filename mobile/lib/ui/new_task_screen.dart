import 'dart:async';
import 'package:flutter/material.dart';
import '../tasks/workspace_controller.dart';
import '../tasks/attachment_uploader.dart';
import '../tasks/native_files.dart';
import 'composer.dart';

class NewTaskScreen extends StatefulWidget {
  const NewTaskScreen({super.key, required this.controller});
  final WorkspaceController controller;
  @override State<NewTaskScreen> createState() => _NewTaskScreenState();
}
class _NewTaskScreenState extends State<NewTaskScreen> {
  final text = TextEditingController(), goal = TextEditingController();
  final files = <PickedAttachment>[];
  Map<String, dynamic>? options;
  String? cwd, model, effort, error;
  String agent = 'codex', target = 'bridge';
  bool plan = false, busy = false;
  Timer? preparation;
  bool refreshing = false;
  @override void initState() { super.initState(); unawaited(load()); preparation = Timer.periodic(const Duration(seconds: 5), (_) => unawaited(refreshPreparing())); }
  @override void dispose() {
    preparation?.cancel();
    if (!busy) { for (final file in files.where((file) => file.id == null)) { unawaited(NativeFiles.remove(file).catchError((Object _) {})); } }
    text.dispose(); goal.dispose(); super.dispose();
  }
  Future<void> refreshPreparing() async {
    final rows = ((options?['agents'] as Map?)?['data'] as List? ?? []).whereType<Map>();
    if (busy || refreshing || !rows.any((row) => row['preparing'] == true)) return;
    refreshing = true;
    try { final value = await widget.controller.loadOptions(forNew: true); if (mounted) setState(() => options = value); }
    catch (_) { /* Keep the existing selection and draft. */ } finally { refreshing = false; }
  }
  Future<void> load() async {
    try {
      final result = await widget.controller.loadOptions(forNew: true);
      final restored = await widget.controller.restoreAttachments(forNew: true);
      final agents = ((result['agents'] as Map?)?['data'] as List? ?? []).whereType<Map>().where((row) => row['available'] == true).toList();
      if (mounted) setState(() { options = result; files..clear()..addAll(restored); if (agents.isNotEmpty && !agents.any((row) => row['id'] == agent)) agent = agents.first['id'] as String; });
    }
    catch (_) { if (mounted) setState(() => error = '无法读取电脑项目和模型，请检查连接后重试'); }
  }
  Future<void> create() async {
    if (busy || cwd == null || (text.text.trim().isEmpty && files.isEmpty)) return;
    setState(() { busy = true; error = null; });
    try {
      await widget.controller.perform('thread/start', {'cwd': cwd, 'agentId': agent, 'target': target, 'workspaceMode': 'local',
        'text': text.text.trim().isEmpty ? '请查看所附文件。' : text.text,
        if (model != null) 'model': model, if (effort != null) 'effort': effort,
        if (plan) 'mode': 'plan', if (goal.text.trim().isNotEmpty && agent == 'codex' && target == 'bridge') 'goal': goal.text.trim()}, attachments: files);
      for (final file in files) { unawaited(NativeFiles.remove(file).catchError((Object _) {})); }
      if (mounted) Navigator.pop(context);
    } catch (_) { if (mounted) setState(() => error = widget.controller.error ?? '创建未完成，请检查原操作回执'); }
    finally { if (mounted) setState(() => busy = false); }
  }
  @override Widget build(BuildContext context) {
    final projects = ((options?['projects'] as Map?)?['data'] as List? ?? []).whereType<Map>().toList();
    final agents = ((options?['agents'] as Map?)?['data'] as List? ?? []).whereType<Map>().where((row) => row['available'] == true).toList();
    final models = agents.where((row) => row['id'] == agent).firstOrNull?['models'] as List? ?? [];
    final selectedCaps = agents.where((row) => row['id'] == agent).firstOrNull?['capabilities'];
    final canAttach = selectedCaps is Map && selectedCaps.containsKey('attachments') ? selectedCaps['attachments'] == true : agent == 'codex';
    final caps = options?['capabilities'] as Set<String>? ?? const <String>{};
    final desktopReady = (options?['runtime'] as Map?)?['desktop'] is Map && ((options?['runtime'] as Map)['desktop'] as Map)['attachReady'] == true;
    final codexBridge = agent == 'codex' && target == 'bridge';
    return PopScope(canPop: !busy, child: Scaffold(appBar: AppBar(title: const Text('新建任务')),
      body: options == null && error == null ? const Center(child: CircularProgressIndicator()) : SafeArea(child: ListView(
        padding: const EdgeInsets.all(20), children: [
          if (error != null) ...[Text(error!, style: TextStyle(color: Theme.of(context).colorScheme.error)), const SizedBox(height: 16)],
          if (options == null) TextButton(onPressed: load, child: const Text('重试')) else ...[
            DropdownButtonFormField<String>(initialValue: cwd, isExpanded: true, decoration: const InputDecoration(labelText: '项目'),
              items: [for (final row in projects) if (row['cwd'] is String) DropdownMenuItem(value: row['cwd'] as String,
                child: Text((row['name'] ?? row['cwd']).toString(), overflow: TextOverflow.ellipsis))], onChanged: busy ? null : (value) => setState(() => cwd = value)),
            const SizedBox(height: 16),
            DropdownButtonFormField<String>(initialValue: agent, isExpanded: true, decoration: const InputDecoration(labelText: 'Agent'),
              items: [for (final row in agents) DropdownMenuItem(value: row['id'] as String, child: Text((row['name'] ?? row['id']).toString()))],
              onChanged: busy ? null : (value) => setState(() { agent = value!; model = effort = null; plan = false; target = 'bridge'; })),
            if (agent == 'codex' && caps.contains('desktop-wake-safe-v2')) ...[
              const SizedBox(height: 16), DropdownButtonFormField<String>(initialValue: target, decoration: const InputDecoration(labelText: '执行入口'),
                items: [const DropdownMenuItem(value: 'bridge', child: Text('Host')), DropdownMenuItem(value: 'desktop', enabled: desktopReady,
                  child: Text(desktopReady ? 'Codex Desktop' : 'Codex Desktop · 尚未连接'))],
                onChanged: busy ? null : (value) => setState(() { target = value!; plan = false; })),
            ],
            const SizedBox(height: 16), ModelChoice(key: ValueKey('$agent:$model'), options: {'data': models}, model: model, effort: effort,
              enabled: !busy, onChanged: (m, e) => setState(() { model = m; effort = e; })),
            const SizedBox(height: 16), TextField(controller: text, enabled: !busy, minLines: 5, maxLines: 12,
              onChanged: (_) => setState(() {}), decoration: const InputDecoration(labelText: '任务内容', alignLabelWithHint: true)),
            const SizedBox(height: 12), AttachmentTray(files: files, enabled: !busy, onRemove: (file) { unawaited(() async {
              try { await widget.controller.discardAttachment(file, forNew: true); if (mounted) setState(() => files.remove(file)); }
              catch (_) { if (mounted) setState(() => error = '附件暂不可移除，请先确认发送结果或检查连接'); }
            }()); }),
            if (!canAttach && files.isNotEmpty) const Text('此 Agent 暂不支持附件，请移除附件后创建任务。'),
            if (canAttach && (caps.contains('attachments-v2') || caps.contains('attachments-v1'))) Align(alignment: Alignment.centerLeft,
              child: TextButton.icon(onPressed: busy ? null : () => unawaited(pickAttachments(context, files, () { if (mounted) setState(() {}); })),
                icon: const Icon(Icons.attach_file), label: Text(caps.contains('attachments-v2') ? '添加文件 · 单个 20 MiB' : '添加小附件 · 电脑端需更新以支持大文件'))),
            if (codexBridge && caps.contains('plan-v1')) SwitchListTile(contentPadding: EdgeInsets.zero, title: const Text('Plan 模式'),
              subtitle: const Text('使用前请明确选择模型'), value: plan, onChanged: busy ? null : (value) => setState(() => plan = value)),
            if (codexBridge && caps.contains('goal-v1')) TextField(controller: goal, enabled: !busy, maxLines: 3,
              decoration: const InputDecoration(labelText: 'Goal（可选）', hintText: '持续任务目标')),
            const SizedBox(height: 24), FilledButton(onPressed: busy || cwd == null || (text.text.trim().isEmpty && files.isEmpty) || (plan && model == null)
              || widget.controller.creationPending
              || !agents.any((row) => row['id'] == agent) || (target == 'desktop' && !desktopReady)
              || (!canAttach && files.isNotEmpty) ? null : () => unawaited(create()), child: Text(busy ? '正在创建…' : '创建任务')),
            if (busy) TextButton(onPressed: widget.controller.cancelUpload, child: const Text('停止上传')),
            if (widget.controller.creationPending) TextButton(onPressed: busy ? null : () async {
              setState(() => busy = true); await widget.controller.recoverPending();
              if (!context.mounted) return;
              if (!widget.controller.creationPending && widget.controller.error == null && widget.controller.selectedTaskId != null) { Navigator.pop(context); }
              else { setState(() { busy = false; error = widget.controller.error; }); }
            }, child: const Text('查询原任务创建回执')),
          ],
        ]))));
  }
}
