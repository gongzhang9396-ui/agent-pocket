import 'dart:async';
import 'dart:io';
import 'package:flutter/material.dart';
import '../tasks/attachment_uploader.dart';
import '../tasks/native_files.dart';
import 'pocket_companion.dart';

class ModelChoice extends StatefulWidget {
  const ModelChoice({super.key, required this.options, required this.model, required this.effort, required this.onChanged, this.enabled = true});
  final Map options;
  final String? model, effort;
  final bool enabled;
  final void Function(String? model, String? effort) onChanged;
  @override State<ModelChoice> createState() => _ModelChoiceState();
}
class _ModelChoiceState extends State<ModelChoice> {
  @override Widget build(BuildContext context) {
    final models = (widget.options['data'] as List? ?? []).whereType<Map>().toList();
    if (widget.options['controlScope'] == 'none') return Text(widget.options['reason'] as String? ?? '当前任务不支持手机切换模型');
    final current = models.where((row) => (row['model'] ?? row['id']) == widget.model).firstOrNull;
    final efforts = (current?['supportedReasoningEfforts'] as List? ?? []).map((row) => row is Map ? row['reasoningEffort'] : row).whereType<String>().toSet();
    return Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      DropdownButtonFormField<String>(initialValue: current == null ? '' : widget.model,
        isExpanded: true, decoration: const InputDecoration(labelText: '模型'),
        items: [const DropdownMenuItem(value: '', child: Text('沿用当前模型')),
          for (final row in models) if (row['model'] is String || row['id'] is String)
            DropdownMenuItem(value: (row['model'] ?? row['id']) as String,
              child: Text((row['displayName'] ?? row['name'] ?? row['model'] ?? row['id']).toString(), overflow: TextOverflow.ellipsis))],
        onChanged: widget.enabled ? (value) => widget.onChanged(value == '' ? null : value, null) : null),
      if (efforts.isNotEmpty) ...[const SizedBox(height: 12), DropdownButtonFormField<String>(
        key: ValueKey(widget.model), initialValue: efforts.contains(widget.effort) ? widget.effort : '',
        decoration: const InputDecoration(labelText: '推理档位'), isExpanded: true,
        items: [const DropdownMenuItem(value: '', child: Text('使用模型默认值')),
          for (final effort in efforts) DropdownMenuItem(value: effort, child: Text(effort))],
        onChanged: widget.enabled ? (value) => widget.onChanged(widget.model, value == '' ? null : value) : null)],
    ]);
  }
}

class AttachmentTray extends StatelessWidget {
  const AttachmentTray({super.key, required this.files, required this.onRemove, required this.enabled});
  final List<PickedAttachment> files;
  final void Function(PickedAttachment) onRemove;
  final bool enabled;
  @override Widget build(BuildContext context) => Wrap(spacing: 8, runSpacing: 4, children: [
    for (final file in files) InputChip(label: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 200),
      child: Text('${file.filename} · ${(file.size / 1024).ceil()} KiB', overflow: TextOverflow.ellipsis)),
      avatar: file.mimeType.startsWith('image/') ? ClipRRect(borderRadius: BorderRadius.circular(4), child: Image(image: ResizeImage(FileImage(File(file.path)),
        width: 96, height: 96, policy: ResizeImagePolicy.fit), width: 24, height: 24, fit: BoxFit.cover, errorBuilder: (_, _, _) => const Icon(Icons.image_outlined, size: 18)))
        : const Icon(Icons.insert_drive_file_outlined, size: 18),
      onDeleted: enabled ? () => onRemove(file) : null),
  ]);
}

Future<void> pickAttachments(BuildContext context, List<PickedAttachment> files, VoidCallback changed) async {
  try {
    final picked = await NativeFiles.pick();
    if (files.length + picked.length > 3) {
      for (final file in picked) { await NativeFiles.remove(file); }
      throw StateError('每次最多添加 3 个附件');
    }
    files.addAll(picked); changed();
  } catch (_) {
    if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('无法添加文件：每次最多 3 个，单个 20 MiB，支持图片、文本/代码和 PDF')));
  }
}

class ChatComposer extends StatefulWidget {
  const ChatComposer({super.key, required this.canSend, required this.canPlan, required this.canAttach, required this.busy,
    required this.onSend, required this.models, this.progress, this.onCancelUpload, this.active = false, this.restoreFiles, this.discardFile, this.clearRevision = 0, this.disabledReason});
  final String? disabledReason;
  final int clearRevision;
  final Future<void> Function(PickedAttachment)? discardFile;
  final Future<List<PickedAttachment>> Function()? restoreFiles;
  final bool active;
  final bool canSend, canPlan, canAttach, busy;
  final Map models;
  final double? progress;
  final VoidCallback? onCancelUpload;
  final Future<void> Function(String text, String? model, String? effort, bool plan, List<PickedAttachment> files) onSend;
  @override State<ChatComposer> createState() => _ChatComposerState();
}
class _ChatComposerState extends State<ChatComposer> {
  final text = TextEditingController();
  final files = <PickedAttachment>[];
  String? model, effort;
  bool plan = false, modelsOpen = false;
  bool restoring = false;
  bool sending = false;
  @override void didUpdateWidget(ChatComposer oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.clearRevision != widget.clearRevision) {
      for (final file in files) { unawaited(NativeFiles.remove(file).catchError((Object _) {})); }
      files.clear(); text.clear();
    }
  }
  @override void initState() { super.initState(); if (widget.restoreFiles != null) {
    restoring = true;
    unawaited(() async {
      try { final restored = await widget.restoreFiles!(); if (mounted) setState(() => files.addAll(restored)); }
      catch (_) { /* Existing receipt and controller state remain available. */ }
      finally { if (mounted) setState(() => restoring = false); }
    }());
  } }
  @override void dispose() {
    if (!sending) { for (final file in files.where((file) => file.id == null)) { unawaited(NativeFiles.remove(file).catchError((Object _) {})); } }
    text.dispose(); super.dispose();
  }
  Future<void> send() async {
    if (!widget.canSend || widget.busy || restoring || sending || (text.text.trim().isEmpty && files.isEmpty)) return;
    sending = true;
    try {
      await widget.onSend(text.text.trim().isEmpty ? '请查看所附文件。' : text.text, model, effort, plan, List.of(files));
      for (final file in files) { unawaited(NativeFiles.remove(file).catchError((Object _) {})); }
      if (mounted) setState(() { text.clear(); files.clear(); });
    } catch (_) { /* The controller keeps the error and durable receipt. */ }
    finally { sending = false; }
  }
  @override Widget build(BuildContext context) => SafeArea(top: false, child: Material(color: Theme.of(context).scaffoldBackgroundColor.withValues(alpha: .84),
    child: SingleChildScrollView(child: Padding(padding: const EdgeInsets.fromLTRB(12, 6, 12, 8), child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      if (widget.progress != null) Row(children: [Expanded(child: LinearProgressIndicator(value: widget.progress)),
        TextButton(onPressed: widget.onCancelUpload, child: const Text('停止上传'))]),
      if (modelsOpen) Padding(padding: const EdgeInsets.only(bottom: 8), child: ModelChoice(key: ValueKey(model), options: widget.models,
        model: model, effort: effort, enabled: !widget.busy && !widget.active, onChanged: (m, e) => setState(() { model = m; effort = e; }))),
      if (widget.active) Text('正在回复，发送内容将作为追加指令；模型设置在下一轮生效。', style: Theme.of(context).textTheme.bodySmall),
      if (files.isNotEmpty) AttachmentTray(files: files, enabled: !widget.busy, onRemove: (file) {
        unawaited(() async {
          try { await (widget.discardFile?.call(file) ?? NativeFiles.remove(file)); if (mounted) setState(() => files.remove(file)); }
          catch (_) { if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('附件暂不可移除，请先确认发送结果或检查连接'))); }
        }());
      }),
      Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
        if (MediaQuery.viewInsetsOf(context).bottom == 0 && MediaQuery.sizeOf(context).height > 560) Padding(padding: const EdgeInsets.only(right: 6),
          child: PocketCompanion(frame: widget.busy || widget.active ? 1 : widget.canSend ? 0 : 2)),
        Expanded(child: TextField(controller: text, enabled: widget.canSend && !widget.busy, minLines: 1, maxLines: 5,
        decoration: InputDecoration(hintText: widget.canSend ? '继续对话…' : widget.disabledReason ?? '此任务暂不支持发送', filled: true, fillColor: Colors.white),
        onChanged: (_) => setState(() {}))),
      ]),
      Row(crossAxisAlignment: CrossAxisAlignment.end, children: [Expanded(child: Wrap(crossAxisAlignment: WrapCrossAlignment.center, children: [
        IconButton(onPressed: widget.busy || restoring || !widget.canSend || !widget.canAttach ? null : () => unawaited(pickAttachments(context, files, () { if (mounted) setState(() {}); })),
          icon: const Icon(Icons.attach_file), tooltip: '添加文件'),
        if ((widget.models['data'] as List? ?? []).isNotEmpty || widget.models['reason'] is String) TextButton(onPressed: widget.busy ? null : () => setState(() => modelsOpen = !modelsOpen),
          child: Text(model == null ? '模型' : '已选模型')),
        if (widget.canPlan) FilterChip(label: const Text('Plan'), selected: plan, onSelected: widget.busy || widget.active ? null : (value) => setState(() => plan = value)),
        ])), const SizedBox(width: 8),
        IconButton.filled(onPressed: widget.canSend && !widget.busy && !restoring && (text.text.trim().isNotEmpty || files.isNotEmpty) && (widget.active || !plan || model != null)
          ? () => unawaited(send()) : null, icon: widget.busy ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.arrow_upward), tooltip: '发送'),
      ]),
    ])))));
}
