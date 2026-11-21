// ignore_for_file: avoid_relative_lib_imports, avoid_print
import '../lib/tasks/task_catalog.dart';

Future<void> main() async {
  final requests = <Map<String, dynamic>>[];
  final catalog = TaskCatalog((method, [params = const {}]) async {
    if (method == 'agent/list') return {'data': [{'id': 'codex'}, {'id': 'grok'}, {'id': 'dsh'}]};
    assert(method == 'thread/list');
    requests.add({...params});
    if (params['agentId'] == 'grok') { return {'data': [{'id': 'grok:test', 'updatedAt': 3}], 'nextCursor': null}; }
    if (params['agentId'] == 'dsh') { return {'data': [{'id': 'dsh:test', 'updatedAt': 4}], 'nextCursor': null}; }
    if (params['cursor'] == null) { return {'data': [{'id': 'codex', 'updatedAt': 2},
      {'id': 'archived', 'archivedAt': 1}], 'nextCursor': 'older'}; }
    return {'data': [{'id': 'old', 'updatedAt': 1}], 'nextCursor': null};
  });
  final result = await catalog.load({'agents-v1'});
  assert(result.map((item) => item['id']).join(',') == 'dsh:test,grok:test,codex,old');
  assert(requests.length == 4 && requests[0]['agentId'] == 'codex' && requests[2]['agentId'] == 'grok' && requests[3]['agentId'] == 'dsh');
  assert(result.first['agentId'] == 'dsh');
  final legacyRequests = <Map<String, dynamic>>[];
  final legacy = TaskCatalog((_, [params = const {}]) async { legacyRequests.add({...params}); return {'data': [], 'nextCursor': null}; });
  await legacy.load({});
  assert(!legacyRequests.single.containsKey('agentId'));
  final loop = TaskCatalog((_, [params = const {}]) async => {'data': [], 'nextCursor': 'same'});
  try { await loop.load({}); throw StateError('repeated cursor accepted'); }
  on FormatException { /* A repeated cursor must never spin indefinitely. */ }
  final mismatch = TaskCatalog((method, [params = const {}]) async => method == 'agent/list'
    ? {'data': [{'id': 'codex'}, {'id': 'dsh'}]} : {'data': [{'id': 'same'}]});
  try { await mismatch.load({'agents-v1'}); throw StateError('namespace mismatch accepted'); } on FormatException { /* Fail visibly before merging agents. */ }
  print('task catalog contract passed');
}
