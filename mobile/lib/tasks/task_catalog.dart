typedef HostRead = Future<dynamic> Function(String method, [Map<String, dynamic> params]);

/// Loads complete paginated catalogs from one Host without guessing its agent
/// capabilities. An invalid or repeated cursor fails visibly, not as a partial
/// success that could hide older conversations.
class TaskCatalog {
  TaskCatalog(this.read, {this.maxPagesPerAgent = 100});
  final HostRead read;
  final int maxPagesPerAgent;

  Future<List<Map<String, dynamic>>> load(Set<String> capabilities) async {
    final agents = <String?>[null];
    if (capabilities.contains('agents-v1')) {
      final catalog = await read('agent/list');
      if (catalog is! Map || catalog['data'] is! List) throw const FormatException('Agent 列表格式无效');
      final ids = <String>{};
      for (final row in catalog['data'] as List) {
        final id = row is Map ? row['id'] : null;
        if (id is! String || !RegExp(r'^[a-z][a-z0-9_-]{0,31}$').hasMatch(id) || !ids.add(id)) {
          throw const FormatException('Agent 标识无效或重复');
        }
      }
      if (ids.length > 16) throw const FormatException('Agent 列表过大');
      agents..clear()..addAll(ids);
    }
    final rows = <String, Map<String, dynamic>>{};
    for (final agent in agents) {
      String? cursor;
      final seenCursors = <String>{};
      var pages = 0;
      do {
        if (++pages > maxPagesPerAgent) throw StateError('任务列表页数过多，请稍后重试');
        final params = <String, dynamic>{'limit': 200};
        if (agent != null) { params['agentId'] = agent; }
        if (cursor != null) { params['cursor'] = cursor; }
        final result = await read('thread/list', params);
        if (result is! Map || result['data'] is! List) throw const FormatException('任务列表格式无效');
        for (final value in result['data'] as List) {
          if (value is! Map<String, dynamic> || value['id'] is! String || (value['id'] as String).isEmpty) {
            throw const FormatException('任务资料无效');
          }
          if (value['archived'] == true || value['isArchived'] == true || value['archivedAt'] != null) continue;
          if (agent != null && value['agentId'] != null && value['agentId'] != agent) throw const FormatException('任务与 Agent 不匹配');
          final id = value['id'] as String;
          final owner = agent ?? value['agentId'] ?? (id.contains(':') ? id.split(':').first : 'codex');
          if (owner is! String || (owner == 'codex' ? id.contains(':') : !id.startsWith('$owner:') || id.length <= owner.length + 1)) throw const FormatException('任务标识与 Agent 不匹配');
          rows.putIfAbsent('$owner:$id', () => Map.unmodifiable({...value, 'agentId': owner}));
        }
        final next = result['nextCursor'];
        if (next != null && (next is! String || next.isEmpty || !seenCursors.add(next))) {
          throw const FormatException('任务列表分页游标无效');
        }
        cursor = next as String?;
      } while (cursor != null);
    }
    final result = rows.values.toList();
    int updated(Map<String, dynamic> value) => value['updatedAt'] is num ? (value['updatedAt'] as num).toInt() : 0;
    result.sort((left, right) => updated(right).compareTo(updated(left)));
    return List.unmodifiable(result);
  }
}
