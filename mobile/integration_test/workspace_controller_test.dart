import 'dart:async';
import 'package:app/protocol/relay_hosts.dart';
import 'package:app/protocol/relay_event_feed.dart';
import 'package:app/protocol/rpc_client.dart';
import 'package:app/session/pocket_session_service.dart';
import 'package:app/session/session_manager.dart';
import 'package:app/tasks/workspace_controller.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

class _RecoveryFeed implements RelayEventFeed {
  @override Stream<FeedUpdate> get updates => const Stream.empty();
  @override Future<void> start(SessionRef session, List<RelayHost> hosts) async {}
  @override void view(String? host, String? thread) {}
  @override dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
class _RecoveryService implements PocketSessionService {
  @override final RelayEventFeed feed = _RecoveryFeed();
  bool recovered = false;
  @override Future<List<Map<String, dynamic>>> pendingOperations(HostDirectory directory, RelayHost host) async => recovered ? []
    : [{'operationId': 'create-once', 'method': 'thread/start'}];
  @override Future<dynamic> recoverOperation(HostDirectory directory, RelayHost host, Map<String, dynamic> record) async {
    recovered = true; return {'thread': {'id': 'created-task'}};
  }
  @override Future<Map<String, dynamic>> options(HostDirectory directory, RelayHost host, {String? threadId}) async => {'capabilities': <String>{}};
  @override Future<Map<String, dynamic>> readTaskSupport(HostDirectory directory, RelayHost host, String threadId, String method) async => {'items': []};
  @override dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  test('first load prefers an online Host and preserves an explicitly selected offline Host', () async {
    const offline = RelayHost(id: 'offline', name: '2021NICO', online: false, signingPublicKey: 's', encryptionPublicKey: 'e');
    const online = RelayHost(id: 'online', name: 'QA', online: true, signingPublicKey: 's', encryptionPublicKey: 'e');
    final directory = HostDirectory(SessionRef(1, {'accountId': 'account'}), [offline, online]);
    final reads = <String>[];
    final controller = WorkspaceController(readDirectory: () async => directory,
      readCatalog: (_, host) async { reads.add(host.id); return []; }, readTask: (_, _, _) async => {}, isCurrent: (_) => true);
    try {
      await controller.refresh();
      expect(controller.selectedHost?.id, 'online'); expect(controller.error, isNull);
      await controller.selectHost(offline); await controller.refresh();
      expect(controller.selectedHost?.id, 'offline');
      expect(controller.error, contains('2021NICO')); expect(controller.error, contains('当前离线'));
      expect(reads, ['online']); expect(controller.loading, isFalse); expect(controller.sessionExpired, isFalse);
    } finally { controller.dispose(); }
  });
  test('an account with only an offline Host keeps its directory without requesting tasks', () async {
    const host = RelayHost(id: 'offline', name: '2021NICO', online: false, signingPublicKey: 's', encryptionPublicKey: 'e');
    final directory = HostDirectory(SessionRef(1, {'accountId': 'account'}), [host]);
    final controller = WorkspaceController(readDirectory: () async => directory,
      readCatalog: (_, _) async => throw StateError('offline catalog must not be requested'), readTask: (_, _, _) async => {}, isCurrent: (_) => true);
    try {
      await controller.refresh();
      expect(controller.hosts, [host]); expect(controller.selectedHost, host);
      expect(controller.error, contains('2021NICO')); expect(controller.error, contains('当前离线'));
      expect(controller.loading, isFalse); expect(controller.sessionExpired, isFalse);
    } finally { controller.dispose(); }
  });
  test('a Host disconnecting after discovery produces its own offline message', () async {
    const host = RelayHost(id: 'host', name: '2021NICO', online: true, signingPublicKey: 's', encryptionPublicKey: 'e');
    final directory = HostDirectory(SessionRef(1, {'accountId': 'account'}), [host]);
    final controller = WorkspaceController(readDirectory: () async => directory,
      readCatalog: (_, _) async => throw const RpcException('目标电脑当前离线', 'HOST_OFFLINE'), readTask: (_, _, _) async => {}, isCurrent: (_) => true);
    try {
      await controller.refresh(); expect(controller.error, contains('2021NICO')); expect(controller.loading, isFalse);
      await controller.selectHost(host); expect(controller.error, contains('2021NICO')); expect(controller.loading, isFalse);
    } finally { controller.dispose(); }
  });
  test('a recovered creation opens that task even when another conversation was selected', () async {
    const host = RelayHost(id: 'a', name: 'A', online: true, signingPublicKey: 's', encryptionPublicKey: 'e');
    final directory = HostDirectory(SessionRef(1, {'accountId': 'account'}), [host]);
    final service = _RecoveryService();
    final controller = WorkspaceController(readDirectory: () async => directory, readCatalog: (_, _) async => [],
      readTask: (_, _, id) async => {'thread': {'id': id, 'turns': []}}, isCurrent: (_) => true, service: service);
    await controller.refresh(); await controller.openTask('previous-task');
    expect(controller.creationPending, true);
    await controller.recoverPending();
    expect(controller.selectedTaskId, 'created-task'); expect(controller.pending, isEmpty);
    controller.dispose();
  });
  test('late results cannot overwrite another Host or task', () async {
    const first = RelayHost(id: 'a', name: 'A', online: true, signingPublicKey: 's', encryptionPublicKey: 'e');
    const second = RelayHost(id: 'b', name: 'B', online: true, signingPublicKey: 's', encryptionPublicKey: 'e');
    final directory = HostDirectory(SessionRef(1, {'accountId': 'account', 'endpoint': 'https://example.invalid'}), [first, second]);
    final slowList = Completer<List<Map<String, dynamic>>>();
    final slowDetail = Completer<Map<String, dynamic>>();
    final controller = WorkspaceController(readDirectory: () async => directory,
      readCatalog: (_, host) async => host.id == 'b' ? slowList.future : [{'id': 'first-task'}],
      readTask: (_, _, _) => slowDetail.future, isCurrent: (_) => true);
    await controller.refresh();
    expect(controller.tasks.single['id'], 'first-task');
    final oldList = controller.selectHost(second);
    await Future<void>.delayed(Duration.zero);
    await controller.selectHost(first);
    slowList.complete([{'id': 'wrong-task'}]);
    await oldList;
    expect(controller.selectedHost?.id, 'a');
    expect(controller.tasks.single['id'], 'first-task');
    final oldDetail = controller.openTask('first-task');
    await Future<void>.delayed(Duration.zero);
    controller.closeTask();
    slowDetail.complete({'thread': {'id': 'first-task'}});
    await oldDetail;
    expect(controller.detail, isNull);
    expect(controller.loadingTask, isFalse);
    controller.dispose();
  });

  test('authentication change clears previously visible tasks', () async {
    const host = RelayHost(id: 'a', name: 'A', online: true, signingPublicKey: 's', encryptionPublicKey: 'e');
    final directory = HostDirectory(SessionRef(1, {'accountId': 'account', 'endpoint': 'https://example.invalid'}), [host]);
    var expired = false;
    final controller = WorkspaceController(readDirectory: () async {
      if (expired) throw SignInRequired();
      return directory;
    }, readCatalog: (_, _) async => [{'id': 'task'}], readTask: (_, _, _) async => {}, isCurrent: (_) => true);
    await controller.refresh();
    expired = true;
    await controller.refresh();
    expect(controller.hosts, isEmpty);
    expect(controller.tasks, isEmpty);
    expect(controller.loading, isFalse);
    expect(controller.error, isNotNull);
    controller.dispose();
  });

  test('session changes after a read starts do not reveal old results', () async {
    const host = RelayHost(id: 'a', name: 'A', online: true, signingPublicKey: 's', encryptionPublicKey: 'e');
    final directory = HostDirectory(SessionRef(1, {'accountId': 'account', 'endpoint': 'https://example.invalid'}), [host]);
    final pending = Completer<List<Map<String, dynamic>>>();
    var current = true;
    final controller = WorkspaceController(readDirectory: () async => directory,
      readCatalog: (_, _) => pending.future, readTask: (_, _, _) async => {}, isCurrent: (_) => current);
    final refresh = controller.refresh();
    await Future<void>.delayed(Duration.zero);
    current = false;
    pending.complete([{'id': 'old-account-task'}]);
    await refresh;
    expect(controller.tasks, isEmpty);
    expect(controller.hosts, isEmpty);
    expect(controller.loading, isFalse);
    controller.dispose();
  });

  test('late artifact list cannot appear in another task', () async {
    const host = RelayHost(id: 'a', name: 'A', online: true, signingPublicKey: 's', encryptionPublicKey: 'e');
    final directory = HostDirectory(SessionRef(1, {'accountId': 'account', 'endpoint': 'https://example.invalid'}), [host]);
    final artifacts = Completer<List<Map<String, dynamic>>>();
    final controller = WorkspaceController(readDirectory: () async => directory,
      readCatalog: (_, _) async => [{'id': 'task'}],
      readTask: (_, _, id) async => {'thread': {'id': id, 'turns': []}},
      readArtifacts: (_, _, _, {cursor}) => artifacts.future, isCurrent: (_) => true);
    await controller.refresh();
    await controller.openTask('task');
    controller.closeTask();
    artifacts.complete([{'id': 'old-file'}]);
    await Future<void>.delayed(Duration.zero);
    expect(controller.artifacts, isEmpty);
    controller.dispose();
  });

  test('loads earlier history without replacing newer overlapping messages', () async {
    const host = RelayHost(id: 'a', name: 'A', online: true, signingPublicKey: 's', encryptionPublicKey: 'e');
    final directory = HostDirectory(SessionRef(1, {'accountId': 'account', 'endpoint': 'https://example.invalid'}), [host]);
    Map<String, dynamic> response(List<Map<String, dynamic>> items, bool more, String? cursor) => {
      'thread': {'id': 'task', 'turns': [{'id': 'turn', 'items': items}]},
      'page': {'hasMore': more, 'nextCursor': cursor, 'revision': 'rev'},
    };
    final controller = WorkspaceController(readDirectory: () async => directory,
      readCatalog: (_, _) async => [{'id': 'task'}],
      readTask: (_, _, _) async => response([{'id': 'shared', 'type': 'agentMessage', 'text': '最新'}], true, 'older'),
      readEarlier: (_, _, _, cursor) async => response([
        {'id': 'first', 'type': 'agentMessage', 'text': '更早'},
        {'id': 'shared', 'type': 'agentMessage', 'text': '旧版本'},
      ], false, null), isCurrent: (_) => true);
    await controller.refresh();
    await controller.openTask('task');
    expect(controller.hasEarlier, isTrue);
    await controller.loadEarlier();
    expect(controller.hasEarlier, isFalse);
    expect(controller.timeline.map((item) => item.text).toList(), ['更早', '最新']);
    controller.dispose();
  });

  test('latest artifact grant wins even when an older page finishes later', () async {
    const host = RelayHost(id: 'a', name: 'A', online: true, signingPublicKey: 's', encryptionPublicKey: 'e');
    final directory = HostDirectory(SessionRef(1, {'accountId': 'account', 'endpoint': 'https://example.invalid'}), [host]);
    final latest = Completer<List<Map<String, dynamic>>>();
    final older = Completer<List<Map<String, dynamic>>>();
    final controller = WorkspaceController(readDirectory: () async => directory, readCatalog: (_, _) async => [{'id': 'task'}],
      readTask: (_, _, _) async => {'thread': {'id': 'task', 'turns': []}, 'page': {'hasMore': true, 'nextCursor': 'older'}},
      readEarlier: (_, _, _, _) async => {'thread': {'id': 'task', 'turns': []}, 'page': {'hasMore': false}},
      readArtifacts: (_, _, _, {cursor}) => cursor == null ? latest.future : older.future, isCurrent: (_) => true);
    await controller.refresh();
    await controller.openTask('task');
    await controller.loadEarlier();
    latest.complete([{'messageId': 'turn:item', 'source': 'file', 'id': 'new'}]);
    await Future<void>.delayed(Duration.zero);
    older.complete([{'messageId': 'turn:item', 'source': 'file', 'id': 'old'}]);
    await Future<void>.delayed(Duration.zero);
    expect(controller.artifacts.single['id'], 'new');
    controller.dispose();
  });
}
