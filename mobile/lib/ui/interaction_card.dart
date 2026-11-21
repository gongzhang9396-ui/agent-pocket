import 'dart:convert';
import 'package:flutter/material.dart';
import '../tasks/thread_page.dart';

class InteractionCard extends StatefulWidget {
  const InteractionCard({super.key, required this.items, required this.enabled, required this.onAction});
  final List<ThreadItem> items;
  final bool enabled;
  final Future<void> Function(String method, Map<String, dynamic> params) onAction;
  @override State<InteractionCard> createState() => _InteractionCardState();
}
class _InteractionCardState extends State<InteractionCard> {
  final answers = <String, Set<String>>{};
  bool busy = false;
  final controllers = <String, TextEditingController>{};
  List<String> response(ThreadItem item) {
    final selected = answers[(item.raw['questionId'] ?? 'question').toString()] ?? <String>{};
    final custom = controllers[item.id]?.text.trim() ?? '';
    return {...selected, if (custom.isNotEmpty) custom}.toList();
  }
  @override void dispose() { for (final controller in controllers.values) { controller.dispose(); } super.dispose(); }
  Future<void> submit(String method, Map<String, dynamic> params) async {
    if (busy) return; setState(() => busy = true);
    try { await widget.onAction(method, params); } catch (_) { /* Controller surfaces pending/failed receipt. */ }
    finally { if (mounted) setState(() => busy = false); }
  }
  @override Widget build(BuildContext context) {
    final first = widget.items.first.raw;
    final approval = widget.items.first.type == 'pocketApproval';
    final available = widget.enabled && !busy && widget.items.every((item) => item.raw['available'] == true &&
      item.raw['unavailableReason'] == null && item.raw['decision'] == null && item.raw['selectedOption'] == null && item.raw['submissionState'] == null);
    final decisions = (first['allowedDecisions'] as List?)?.whereType<String>().toSet() ??
      (first['owner'] == 'desktop' ? <String>{} : {'allowOnce', 'deny', 'cancel'});
    return Card(child: Padding(padding: const EdgeInsets.all(14), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Text(approval ? '需要审批' : '需要回答', style: Theme.of(context).textTheme.titleSmall), const SizedBox(height: 8),
      if (approval) ...[
        SelectableText(first['summary'] as String? ?? '请求允许执行一次'),
        if (first['command'] is String && (first['command'] as String).isNotEmpty) ...[const SizedBox(height: 8), SelectableText(first['command'] as String, style: const TextStyle(fontFamily: 'monospace'))],
        if (first['cwd'] is String) Padding(padding: const EdgeInsets.only(top: 8), child: SelectableText('目录：${first['cwd']}')),
        if (first['changes'] != null) ExpansionTile(title: const Text('查看文件变更'), children: [SelectableText(const JsonEncoder.withIndent('  ').convert(first['changes']))]),
        if (first['grantRoot'] != null || first['networkApprovalContext'] != null) SelectableText(const JsonEncoder.withIndent('  ').convert({
          if (first['grantRoot'] != null) 'grantRoot': first['grantRoot'], if (first['networkApprovalContext'] != null) 'network': first['networkApprovalContext']})),
        Wrap(spacing: 8, children: [for (final decision in ['allowOnce', 'deny', 'cancel']) if (decisions.contains(decision))
          TextButton(onPressed: available ? () => submit('approval/respond', {'requestId': first['requestId'] ?? first['id'], 'decision': decision}) : null,
            child: Text({'allowOnce': '允许一次', 'deny': '拒绝', 'cancel': '取消'}[decision]!))]),
      ] else ...[
        for (final item in widget.items) ...[
          SelectableText(item.raw['prompt'] as String? ?? '请选择或输入回答'), const SizedBox(height: 8),
          Wrap(spacing: 8, runSpacing: 4, children: [for (final option in item.raw['options'] as List? ?? [])
            ChoiceChip(label: Text(option is Map ? (option['label'] ?? '').toString() : option.toString()),
              selected: answers[(item.raw['questionId'] ?? 'question').toString()]?.contains((option is Map ? option['label'] : option).toString()) == true,
              onSelected: available ? (_) => setState(() {
                final key = (item.raw['questionId'] ?? 'question').toString(), label = (option is Map ? option['label'] : option).toString();
                if (item.raw['multiSelect'] == true) { final values = answers.putIfAbsent(key, () => <String>{}); if (!values.remove(label) && values.length < 10) values.add(label); }
                else { answers[key] = {label}; controllers[item.id]?.clear(); }
              }) : null)]),
          TextField(controller: controllers.putIfAbsent(item.id, () => TextEditingController()), enabled: available, minLines: 1, maxLines: 4,
            decoration: const InputDecoration(hintText: '也可以输入回答'),
            onChanged: (value) => setState(() { if (item.raw['multiSelect'] != true && value.trim().isNotEmpty) answers.remove((item.raw['questionId'] ?? 'question').toString()); })),
          const SizedBox(height: 12),
        ],
        Align(alignment: Alignment.centerRight, child: FilledButton(onPressed: available && widget.items.every((item) =>
          response(item).isNotEmpty && response(item).length <= 10)
          ? () => submit('question/respond', {'requestId': first['requestId'] ?? first['id'], 'answers': {
            for (final item in widget.items) (item.raw['questionId'] ?? 'question').toString(): {'answers': response(item)},
          }}) : null, child: const Text('提交回答'))),
      ],
      if (!available) Text(first['decision'] != null || first['selectedOption'] != null ? '已处理' :
        first['unavailableReason'] as String? ?? '此交互暂不可操作，请刷新或在电脑端处理', style: Theme.of(context).textTheme.bodySmall),
    ])));
  }
}
