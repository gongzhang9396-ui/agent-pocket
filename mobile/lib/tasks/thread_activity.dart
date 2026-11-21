class ThreadActivity {
  const ThreadActivity(this.title, this.text, this.status);
  final String title;
  final String text;
  final String status;
}

String statusType(dynamic value) => value is String ? value : value is Map && value['type'] is String ? value['type'] as String : '';
bool runningStatus(dynamic value) => const {'inProgress', 'in_progress', 'active', 'running', 'started'}.contains(statusType(value));
bool finishedStatus(dynamic value) => const {'completed', 'failed', 'interrupted', 'cancelled', 'canceled'}.contains(statusType(value));
String _text(dynamic value) => value is String ? value : '';

/// Only the provider's public summary is displayable. Missing summaries never
/// fall back to raw reasoning content or encrypted replay fields.
ThreadActivity? itemActivity(Map item) {
  final status = statusType(item['status']);
  switch (item['type']) {
    case 'reasoning':
      final parts = item['summary'];
      return ThreadActivity('思考摘要', parts is List ? parts.map((part) => part is String ? part : part is Map ? _text(part['text']) : '')
        .where((part) => part.isNotEmpty).join('\n\n') : '', status);
    case 'plan':
      final steps = item['plan'];
      final lines = [_text(item['explanation']), if (steps is List) ...steps.whereType<Map>().map((step) =>
        '${step['status'] == 'completed' ? '✓' : runningStatus(step['status']) ? '→' : '○'} ${_text(step['step'])}')];
      return ThreadActivity('执行计划', _text(item['text']).isNotEmpty ? _text(item['text']) : lines.where((line) => line.isNotEmpty).join('\n'), status);
    case 'commandExecution':
      final command = item['command'];
      return ThreadActivity('执行命令', [command is List ? command.join(' ') : _text(command), _text(item['aggregatedOutput'] ?? item['output'])]
        .where((part) => part.isNotEmpty).join('\n'), status);
    case 'fileChange':
      final changes = item['changes'];
      return ThreadActivity('修改文件', changes is List ? changes.whereType<Map>().map((change) =>
        [_text(change['path']), _text(change['diff'])].where((part) => part.isNotEmpty).join('\n')).join('\n\n') : '', status);
    case 'diff': return ThreadActivity('文件差异', _text(item['diff']), status);
    case 'mcpToolCall':
    case 'dynamicToolCall':
    case 'collabToolCall':
    case 'collabAgentToolCall':
      return ThreadActivity('调用工具', [_text(item['server']), _text(item['tool'])].where((part) => part.isNotEmpty).join(' · '), status);
    case 'webSearch':
      final action = item['action'];
      return ThreadActivity('搜索资料', _text(item['query']).isNotEmpty ? _text(item['query']) : action is Map ? _text(action['query'] ?? action['url']) : '', status);
    case 'imageView': return ThreadActivity('查看图片', _text(item['path']), status);
    case 'contextCompaction': return ThreadActivity('整理上下文', '', status);
    case 'imageGeneration': return ThreadActivity('生成图片', '', status);
    case 'subAgentActivity': return ThreadActivity('子代理执行', '', status);
    case 'sleep': return ThreadActivity('等待唤醒', '', status);
    case 'enteredReviewMode': return ThreadActivity('进入审查', '', status);
    case 'exitedReviewMode': return ThreadActivity('结束审查', '', status);
    default: return null;
  }
}

String activityStatus(String value) {
  if (runningStatus(value)) return '进行中';
  return const {'completed': '已完成', 'failed': '失败', 'interrupted': '已中断', 'cancelled': '已取消', 'canceled': '已取消', 'declined': '已拒绝'}[value] ?? '';
}

Map<String, dynamic>? activityEventItem(String type, Map payload, Map? previous, String turnId) {
  if (type == 'activity.updated' && payload['item'] is Map) {
    final item = Map<String, dynamic>.from(payload['item'] as Map);
    return itemActivity(item) == null ? null : item;
  }
  if (type == 'command.updated') {
    if (payload['item'] is Map) {
      return {...?previous, ...Map<String, dynamic>.from(payload['item'] as Map),
        if (payload['item']['aggregatedOutput'] == null && previous != null) 'aggregatedOutput': previous['aggregatedOutput'] ?? ''};
    }
    if (payload['itemId'] is String && payload['delta'] is String) {
      return {...?previous, 'id': payload['itemId'], 'type': 'commandExecution', 'status': previous?['status'] ?? 'inProgress',
        'aggregatedOutput': '${_text(previous?['aggregatedOutput'])}${payload['delta']}', 'truncated': payload['truncated'] == true};
    }
  }
  if (type == 'plan.updated' && payload['plan'] is List) {
    return {'id': 'pocket-plan-$turnId', 'type': 'plan', 'explanation': payload['explanation'], 'plan': payload['plan']};
  }
  return null;
}
