import 'dart:convert';
import 'package:flutter/services.dart';
import '../tasks/android_operation_journal.dart';
import 'relay_event_feed.dart';

class AndroidFeedCursorStore implements FeedCursorStore {
  static const _legacy = MethodChannel('agent_pocket/cursors');
  @override Future<Map<String, dynamic>> load(String scope, String hostId) async {
    final raw = await AndroidOperationJournal.channel.invokeMethod<String>('read', {'key': 'sync:$scope'});
    if (raw != null) {
      final result = jsonDecode(raw);
      if (result is! Map<String, dynamic> || result['seq'] is! int || (result['seq'] as int) < 0) throw const FormatException('同步游标无效');
      return result;
    }
    return {'seq': await _legacy.invokeMethod<int>('read', {'hostId': hostId}) ?? 0, 'revision': 0};
  }
  @override Future<void> save(String scope, String hostId, Map<String, dynamic> state) async {
    await AndroidOperationJournal.channel.invokeMethod<void>('write', {'key': 'sync:$scope', 'json': jsonEncode(state)});
    await _legacy.invokeMethod<void>('write', {'hostId': hostId, 'seq': state['seq']});
  }
}
