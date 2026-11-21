// ignore_for_file: avoid_relative_lib_imports, avoid_print
import '../lib/tasks/operation_runner.dart';

class MemoryJournal implements OperationJournal {
  final values = <String, List<Map<String, dynamic>>>{};
  bool failRemoval = false;
  @override Future<List<Map<String, dynamic>>> load(String scope) async => List.of(values[scope] ?? []);
  @override Future<void> save(String scope, List<Map<String, dynamic>> operations) async {
    if (failRemoval && operations.isEmpty) throw StateError('disk unavailable');
    values[scope] = List.of(operations);
  }
}
Future<void> main() async {
  final journal = MemoryJournal(), runner = OperationRunner(MemoryJournal());
  final checked = OperationRunner(journal); var sends = 0;
  final result = await checked.run('account-host', 'thread/start', {'text': 'test'}, (method, params) async {
    sends++; assert((await journal.load('account-host')).single['operationId'] == params['operationId']); throw StateError('lost response');
  }, (method, params) async => {'operationId': params['operationId'], 'status': 'succeeded', 'result': {'thread': {'id': 'created-once'}}});
  assert(result['thread']['id'] == 'created-once' && sends == 1 && (await journal.load('account-host')).isEmpty);
  try {
    await checked.run('account-host', 'turn/start', {'threadId': 'chat'}, (_, _) async { sends++; throw StateError('lost'); },
      (_, params) async => {'operationId': params['operationId'], 'status': 'missing'});
    throw StateError('unknown result accepted');
  } on OperationUncertain { assert((await journal.load('account-host')).length == 1); }
  try { await checked.run('account-host', 'turn/start', {'threadId': 'chat'}, (_, _) async { sends++; }, (_, _) async {}); }
  on OperationUncertain { assert(sends == 2); }
  final restarted = OperationRunner(journal);
  final pending = (await restarted.pending('account-host')).single;
  try { await restarted.recover('account-host', pending, (_, params) async => {'operationId': params['operationId'], 'status': 'unknown'}); }
  on OperationUncertain { assert(sends == 2); }
  await restarted.recover('account-host', pending, (_, params) async => {'operationId': params['operationId'], 'status': 'succeeded', 'result': 'done'});
  assert((await journal.load('account-host')).isEmpty);
  assert((await runner.pending('other-account')).isEmpty);
  final delivered = await checked.run('batch', 'turn/start', {'threadId': 'batch-chat'}, (_, _) async => 'done', (_, _) async {}, retainSuccess: true);
  assert(delivered == 'done' && (await checked.pending('batch')).length == 1);
  await checked.confirm('batch', (await checked.pending('batch')).single['operationId'] as String);
  assert((await checked.pending('batch')).isEmpty);
  try {
    await checked.run('failed', 'turn/start', {'threadId': 'chat'}, (_, _) async { throw StateError('lost'); },
      (_, params) async => {'operationId': params['operationId'], 'status': 'failed', 'error': {'message': 'confirmed failure'}});
    throw StateError('failed receipt accepted');
  } on OperationFailed catch (error) { assert(error.message == 'confirmed failure' && (await journal.load('failed')).isEmpty); }
  journal.failRemoval = true;
  try {
    await checked.run('disk-error', 'turn/start', {'threadId': 'chat'}, (_, _) async => 'sent',
      (_, params) async => {'operationId': params['operationId'], 'status': 'succeeded', 'result': 'sent'});
    throw StateError('lost journal cleanup accepted');
  } on OperationUncertain { assert((await journal.load('disk-error')).length == 1); }
  print('operation journal: lost reply, restart recovery, no automatic resend passed');
}
