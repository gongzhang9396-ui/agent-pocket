// ignore_for_file: avoid_relative_lib_imports, avoid_print
import 'dart:async';
import '../lib/protocol/relay_hosts.dart';
import '../lib/protocol/rpc_client.dart';
import '../lib/session/session_manager.dart';
import 'session_contract_smoke.dart' show MemoryStore, credential;

class FakeConnection implements HostListConnection {
  FakeConnection({this.gate});
  final Completer<dynamic>? gate;
  bool closed = false;
  final calls = <String>[];
  @override Future<dynamic> call(String method, [Map<String, dynamic> params = const {}]) async {
    calls.add(method);
    if (method == 'relay/hello') return {'protocolVersion': 2, 'accountId': 'account', 'deviceId': 'device'};
    if (gate != null) return gate!.future;
    return [{'id': 'host', 'name': '电脑', 'online': true, 'signingPublicKey': 'sign', 'encryptionPublicKey': 'box'}];
  }
  @override Future<void> close() async { closed = true; }
}

Future<void> main() async {
  final store = MemoryStore(credential(expiry: 100000));
  final sessions = SessionManager(store, (_) async => throw StateError('unexpected refresh'), now: () => 1000);
  final session = await sessions.snapshot();
  final connection = FakeConnection();
  final directory = RelayHosts(sessions, connect: (uri, token) async {
    assert(uri.toString() == 'wss://example.invalid/ws/device' && token == 'old');
    return connection;
  });
  final hosts = await directory.list(session);
  assert(hosts.single.name == '电脑' && hosts.single.online && connection.closed);
  assert(connection.calls.join(',') == 'relay/hello,host/list');

  final gate = Completer<dynamic>();
  final slow = FakeConnection(gate: gate);
  final pending = RelayHosts(sessions, connect: (_, _) async => slow).list(session);
  await Future<void>.delayed(Duration.zero);
  await sessions.clear();
  gate.complete([]);
  try { await pending; throw StateError('stale account data accepted'); }
  on SessionChanged { assert(slow.closed); }

  final refreshStore = MemoryStore(credential(expiry: 100000));
  var rotations = 0;
  final rotating = SessionManager(refreshStore, (_) async {
    rotations++;
    return {'accessToken': 'new', 'refreshToken': 'next', 'accessExpiresAt': 100000, 'refreshExpiresAt': 900000};
  }, now: () => 1000);
  final rotatingRef = await rotating.snapshot();
  final recovered = RelayHosts(rotating, connect: (_, token) async {
    if (token == 'old') throw const RpcException('expired', 'AUTH_FAILED');
    return FakeConnection();
  });
  assert((await recovered.list(rotatingRef)).single.id == 'host' && rotations == 1);
  print('relay hosts contract passed');
}
