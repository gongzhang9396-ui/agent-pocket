import 'thread_activity.dart';

class ThreadItem {
  const ThreadItem({required this.id, required this.turnId, required this.type, required this.raw, this.text});
  final String id;
  final String turnId;
  final String type;
  final String? text;
  final Map<String, dynamic> raw;
  String get artifactMessageId => raw['id'] is String && (raw['id'] as String).isNotEmpty ? '$turnId:$id' : id;
}

/// One history page, normalized without discarding unsupported interaction or
/// attachment fields. A later UI can render those according to capabilities.
class ThreadPage {
  const ThreadPage({required this.thread, required this.items, required this.hasMore, this.nextCursor, this.revision});
  final Map<String, dynamic> thread;
  final List<ThreadItem> items;
  final bool hasMore;
  final String? nextCursor;
  final String? revision;

  static ThreadPage fromResponse(Map<String, dynamic> response, String expectedThread, {String? requestedCursor}) {
    final thread = response['thread'];
    if (thread is! Map<String, dynamic> || thread['id'] != expectedThread) throw const FormatException('任务详情不匹配');
    final page = response['page'];
    if (page != null && page is! Map) throw const FormatException('历史分页格式无效');
    final hasMore = page is Map && page['hasMore'] == true;
    final cursor = page is Map ? page['nextCursor'] : null;
    final revision = page is Map ? page['revision'] : null;
    if (hasMore && (cursor is! String || cursor.trim().isEmpty || cursor == requestedCursor)) {
      throw const FormatException('历史分页游标无效');
    }
    if (revision != null && revision is! String) throw const FormatException('历史版本格式无效');
    final turns = thread['turns'];
    if (turns != null && turns is! List) throw const FormatException('任务消息格式无效');
    final orderedTurns = (turns as List? ?? const []).toList();
    if (page is Map && page['order'] == 'newest_first') {
      final reversed = orderedTurns.reversed.toList();
      orderedTurns..clear()..addAll(reversed);
    }
    final items = <ThreadItem>[];
    final seen = <String>{};
    for (final turn in orderedTurns) {
      if (turn is! Map || turn['id'] is! String || turn['items'] is! List) throw const FormatException('任务轮次格式无效');
      final turnId = turn['id'] as String;
      final values = turn['items'] as List;
      for (var index = 0; index < values.length; index++) {
        final item = values[index];
        if (item is! Map<String, dynamic> || item['type'] is! String) throw const FormatException('任务消息格式无效');
        final id = item['id'] is String && (item['id'] as String).isNotEmpty ? item['id'] as String : '$turnId:$index';
        if (!seen.add(id)) continue;
        final type = item['type'] as String;
        String? text;
        if (type == 'userMessage') {
          final content = item['content'];
          if (content is List) {
            final parts = <String>[];
            for (final part in content.whereType<Map>()) {
              if (part['type'] == 'text' && part['text'] is String) { parts.add(part['text'] as String); }
              else if (const {'image', 'localImage', 'inputImage'}.contains(part['type'])) { parts.add('[已添加图片]'); }
              else if (part['type'] == 'file') { parts.add('[已添加文件：${part['filename'] ?? part['name'] ?? '附件'}]'); }
            }
            text = parts.join('\n');
          }
        } else if (type == 'agentMessage') {
          text = item['text'] is String ? item['text'] as String : '';
        } else { text = itemActivity(item)?.text; }
        items.add(ThreadItem(id: id, turnId: turnId, type: type, text: text, raw: Map.unmodifiable(item)));
      }
    }
    final interactions = thread['interactionItems'];
    if (interactions != null && interactions is! List) throw const FormatException('任务交互格式无效');
    for (final item in interactions as List? ?? const []) {
      if (item is! Map<String, dynamic> || item['type'] is! String || item['id'] is! String || (item['id'] as String).isEmpty) {
        throw const FormatException('任务交互格式无效');
      }
      final id = item['id'] as String;
      final position = items.indexWhere((existing) => existing.id == id);
      final updated = ThreadItem(id: id, turnId: position < 0 ? '' : items[position].turnId, type: item['type'] as String, raw: Map.unmodifiable(item));
      if (position < 0) { seen.add(id); items.add(updated); }
      else { items[position] = updated; }
    }
    return ThreadPage(thread: Map.unmodifiable(thread), items: List.unmodifiable(items), hasMore: hasMore,
      nextCursor: hasMore ? cursor as String : null, revision: revision as String?);
  }
}
