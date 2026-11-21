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
  final pendingWatch = Completer<void>();
  final watches = <Map<String, dynamic>>[];
  @override Future<void> watchTask(HostDirectory directory, RelayHost host, String id, {bool watching = true, required String leaseId}) async {
    watches.add({'id': id, 'watching': watching, 'lease': leaseId});
    if (watching && !pendingWatch.isCompleted) await pendingWatch.future;
  }
  @override Future<Map<String, dynamic>> readTaskSupport(HostDirectory directory, RelayHost host, String id, String method) async => {'items': []};
  @override Future<Map<String, dynamic>> options(HostDirectory directory, RelayHost host, {String? threadId}) async => {'capabilities': <String>{}};
  @override dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
const _host = RelayHost(id: 'host', name: 'QA', online: true, signingPublicKey: 's', encryptionPublicKey: 'e');
final _directory = HostDirectory(SessionRef(1, {'accountId': 'qa'}), [_host]);
Map<String, dynamic> _page({bool live = false}) => {'thread': {'id': 'dsh:one', 'agentId': 'dsh', 'liveItemIds': live ? ['dsh-live-attempt'] : [],
  'turns': [{'id': 'turn', 'items': [if (live) {'id': 'dsh-live-attempt', 'type': 'agentMessage', 'text': 'stale prefix'}]}]}};
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  test('late watch completion releases the closed DSH lease again', () async {
    final service = _Service();
    final controller = WorkspaceController(readDirectory: () async => _directory, readCatalog: (_, _) async => [],
      readTask: (_, _, _) async => _page(), isCurrent: (_) => true, service: service);
    try {
      await controller.refresh(); await controller.openTask('dsh:one');
      await Future<void>.delayed(Duration.zero); controller.closeTask();
      service.pendingWatch.complete(); await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(service.watches.where((row) => row['watching'] == true).length, 1);
      final lease = service.watches.first['lease'];
      expect(service.watches.where((row) => row['watching'] == false && row['lease'] == lease).length, greaterThanOrEqualTo(2));
    } finally { controller.dispose(); await service.feed.bus.close(); }
  });
  test('a late DSH history read cannot resurrect a removed live reply', () async {
    final service = _Service(); service.pendingWatch.complete();
    final staleRead = Completer<Map<String, dynamic>>(); var reads = 0;
    final controller = WorkspaceController(readDirectory: () async => _directory, readCatalog: (_, _) async => [],
      readTask: (_, _, _) async => ++reads == 2 ? staleRead.future : _page(), isCurrent: (_) => true, service: service);
    void emit(String type, Map<String, dynamic> payload) => service.feed.bus.add(FeedUpdate('event', hostId: 'host',
      value: {'threadId': 'dsh:one', 'type': type, 'payload': payload}));
    try {
      await controller.refresh(); await controller.openTask('dsh:one');
      emit('message.delta', {'itemId': 'dsh-live-attempt', 'delta': 'prefix', 'replace': true});
      emit('sync.required', {}); await Future<void>.delayed(const Duration(milliseconds: 750)); expect(reads, 2);
      emit('message.delta', {'itemId': 'dsh-live-attempt', 'delta': '', 'remove': true, 'complete': true});
      staleRead.complete(_page(live: true)); await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(controller.timeline.where((item) => item.id == 'dsh-live-attempt'), isEmpty);
    } finally { controller.dispose(); await service.feed.bus.close(); }
  });
}
