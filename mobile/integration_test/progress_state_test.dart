import 'dart:async';
import 'package:app/protocol/relay_event_feed.dart';
import 'package:app/protocol/relay_hosts.dart';
import 'package:app/session/pocket_session_service.dart';
import 'package:app/session/session_manager.dart';
import 'package:app/tasks/workspace_controller.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

class _Feed implements RelayEventFeed {
  final bus = StreamController<FeedUpdate>.broadcast(sync: true);
  @override Stream<FeedUpdate> get updates => bus.stream;
  @override Future<void> start(SessionRef session, List<RelayHost> hosts) async {}
  @override void view(String? hostId, String? threadId) {}
  @override dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
class _Service implements PocketSessionService {
  @override final _Feed feed = _Feed();
  @override Future<List<Map<String, dynamic>>> pendingOperations(HostDirectory directory, RelayHost host) async => [];
  @override Future<Map<String, dynamic>> readTaskSupport(HostDirectory directory, RelayHost host, String id, String method) async => {'items': []};
  @override Future<Map<String, dynamic>> options(HostDirectory directory, RelayHost host, {String? threadId}) async => {'capabilities': <String>{}};
  @override dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
  void emit(String type, Map<String, dynamic> payload) => feed.bus.add(FeedUpdate('event', hostId: 'host', sessionGeneration: 1,
    value: {'threadId': 'task', 'turnId': 'turn', 'type': type, 'payload': payload}));
}
const _host = RelayHost(id: 'host', name: 'QA', online: true, signingPublicKey: 's', encryptionPublicKey: 'e');
final _directory = HostDirectory(SessionRef(1, {'accountId': 'qa'}), [_host]);
Map<String, dynamic> _page(String summary) => {'thread': {'id': 'task', 'status': 'active',
  'turns': [{'id': 'turn', 'status': 'inProgress', 'items': [{'id': 'r', 'type': 'reasoning', 'summary': [summary]}]}]}};
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  test('terminal events clear progress even if the next history snapshot is stale', () async {
    final service = _Service();
    final controller = WorkspaceController(readDirectory: () async => _directory, readCatalog: (_, _) async => [],
      readTask: (_, _, _) async => _page('检查入口'), isCurrent: (_) => true, service: service);
    try {
      await controller.refresh(); await controller.openTask('task');
      expect(controller.progress?.title, '思考摘要');
      service.emit('turn.status', {'status': 'completed'});
      expect(controller.activeTurnId, isNull); expect(controller.progress, isNull);
      await Future<void>.delayed(const Duration(milliseconds: 800));
      expect(controller.progress, isNull);
    } finally { controller.dispose(); await service.feed.bus.close(); }
  });
  test('a slow history read preserves newer public summary snapshots', () async {
    final service = _Service(); final slow = Completer<Map<String, dynamic>>(); var reads = 0;
    final controller = WorkspaceController(readDirectory: () async => _directory, readCatalog: (_, _) async => [],
      readTask: (_, _, _) async => ++reads == 2 ? slow.future : _page('检查'), isCurrent: (_) => true, service: service);
    try {
      await controller.refresh(); await controller.openTask('task');
      service.emit('sync.required', {}); await Future<void>.delayed(const Duration(milliseconds: 800));
      expect(reads, 2);
      service.emit('activity.updated', {'item': {'id': 'r', 'type': 'reasoning', 'summary': ['检查入口与更新请求'], 'status': 'inProgress'}});
      slow.complete(_page('检查')); await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(controller.timeline.single.text, '检查入口与更新请求');
      controller.closeTask(); expect(controller.progress, isNull); expect(controller.timeline, isEmpty);
    } finally { controller.dispose(); await service.feed.bus.close(); }
  });
}
