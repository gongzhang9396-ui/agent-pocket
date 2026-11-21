// ignore_for_file: avoid_relative_lib_imports, avoid_print
import 'dart:async';
import 'dart:convert';
import '../lib/protocol/relay_event_feed.dart';
import '../lib/protocol/relay_hosts.dart';
import '../lib/session/session_manager.dart';
import 'session_contract_smoke.dart' show MemoryStore, credential;

class Cursors implements FeedCursorStore {
  final data = <String, Map<String, dynamic>>{};
  @override Future<Map<String, dynamic>> load(String scope, String hostId) async => {...?data[scope], 'seq': data[scope]?['seq'] ?? 0};
  @override Future<void> save(String scope, String hostId, Map<String, dynamic> state) async { data[scope] = jsonDecode(jsonEncode(state)) as Map<String, dynamic>; }
}
Map<String, dynamic> event(int seq, {String thread = 'chat', bool corrupt = false}) => {'seq': seq, 'envelope': {
  'accountId': 'account', 'hostId': 'host', 'deviceId': 'host', 'channelId': 'events', 'counter': seq,
  'kind': 'event.append', 'eventId': 'event-$seq', 'eventType': 'status', 'ciphertext': corrupt ? 'corrupt' : jsonEncode({
    'eventId': 'event-$seq', 'threadId': thread, 'turnId': 'turn', 'type': 'message.delta', 'payload': {'itemId': 'reply', 'delta': '$seq'}})}};
class Connection implements FeedConnection {
  final controller = StreamController<Map<String, dynamic>>.broadcast();
  List<Map<String, dynamic>> retained = [];
  int closed = 0;
  int replays = 0;
  @override Stream<Map<String, dynamic>> get events => controller.stream;
  @override Future<dynamic> call(String method, [Map<String, dynamic> params = const {}]) async { if (method == 'event/replay') replays++; return switch (method) {
    'relay/hello' => {'accountId': 'account', 'deviceId': 'device', 'protocolVersion': 2},
    'snapshot/get' => null,
    'event/replay' => retained.where((event) => (event['seq'] as int) > (params['lastSeq'] as int)).take(params['limit'] as int? ?? 100000).toList(), _ => throw StateError(method)}; }
  void emit(Map<String, dynamic> event) => controller.add({'method': 'relay/event', 'params': event});
  @override Future<void> close() async { closed++; if (!controller.isClosed) await controller.close(); }
}
Future<void> tick() => Future<void>.delayed(const Duration(milliseconds: 30));
Future<void> main() async {
  final sessions = SessionManager(MemoryStore(credential(expiry: 100000)), (_) async => throw StateError('refresh'), now: () => 1000);
  final ref = await sessions.snapshot(), cursors = Cursors(), socket = Connection();
  final feed = RelayEventFeed(sessions, cursors, (envelope, _) => envelope['ciphertext'] as String, connect: (_, _) async => socket);
  const host = RelayHost(id: 'host', name: 'Host', online: true, signingPublicKey: 's', encryptionPublicKey: 'e');
  final updates = <FeedUpdate>[]; final listener = feed.updates.listen(updates.add);
  await feed.start(ref, [host]); await tick(); assert(feed.connected);
  socket.retained = [event(1), event(2)]; socket.emit(event(2)); await tick();
  assert(updates.where((update) => update.type == 'event').length == 2);
  assert(updates.where((update) => update.type == 'event').every((update) => update.replayed));
  socket.emit(event(3)); socket.emit(event(3)); await tick();
  assert(updates.where((update) => update.type == 'event' && !update.replayed).length == 1);
  assert(feed.unread('host').contains('chat'));
  feed.view('host', 'chat'); await tick(); assert(!feed.unread('host').contains('chat'));
  socket.emit(event(4, corrupt: true)); await tick(); assert(feed.connected);
  assert(updates.any((update) => update.type == 'syncWarning'));
  assert(cursors.data.values.single['seq'] == 4);
  socket.retained = List.generate(300, (index) => event(index + 1)); socket.emit(event(300)); await tick();
  assert(cursors.data.values.single['seq'] == 300 && socket.replays > 3);
  await sessions.replace(ref.generation, credential(expiry: 100000));
  socket.emit(event(301)); await tick(); assert(cursors.data.values.single['seq'] == 300);
  await feed.stop(); await listener.cancel(); assert(socket.closed == 1);
  print('event feed: gap replay, duplicate, corrupt item, unread, old-session isolation passed');
}
