// ignore_for_file: avoid_relative_lib_imports, avoid_print
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import '../lib/protocol/rpc_client.dart';

class FakeSocket extends Stream<dynamic> implements WebSocket {
  final incoming = StreamController<dynamic>();
  final sent = <Map<String, dynamic>>[];
  @override int? closeCode;
  @override void add(dynamic data) { sent.add(jsonDecode(data as String) as Map<String, dynamic>); }
  @override Future close([int? code, String? reason]) async { closeCode = code; await incoming.close(); }
  @override StreamSubscription<dynamic> listen(void Function(dynamic)? onData,
      {Function? onError, void Function()? onDone, bool? cancelOnError}) =>
      incoming.stream.listen(onData, onError: onError, onDone: onDone, cancelOnError: cancelOnError);
  @override dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

Future<void> main() async {
  final socket = FakeSocket();
  final rpc = RpcClient.fromSocket(socket, timeout: const Duration(milliseconds: 40));
  final events = <Map<String, dynamic>>[];
  final listener = rpc.events.listen(events.add);
  final first = rpc.call('one');
  final second = rpc.call('two');
  assert(socket.sent.length == 2 && socket.sent[0]['id'] != socket.sent[1]['id']);
  socket.incoming.add(jsonEncode({'jsonrpc': '2.0', 'id': socket.sent[1]['id'], 'result': 'second'}));
  socket.incoming.add(jsonEncode({'jsonrpc': '2.0', 'method': 'event', 'params': {'x': 1}}));
  socket.incoming.add(jsonEncode({'jsonrpc': '2.0', 'id': socket.sent[0]['id'], 'result': 'first'}));
  assert(await first == 'first' && await second == 'second');
  await Future<void>.delayed(Duration.zero);
  assert(events.single['method'] == 'event');
  final errorFuture = rpc.call('bad');
  socket.incoming.add(jsonEncode({'jsonrpc': '2.0', 'id': socket.sent.last['id'], 'error': {'message': 'failed', 'data': {'name': 'DENIED'}}}));
  try { await errorFuture; throw StateError('RPC error accepted'); }
  on RpcException catch (error) { assert(error.code == 'DENIED'); }
  try { await rpc.call('timeout'); throw StateError('timeout accepted'); }
  on RpcException catch (error) { assert(error.code == 'CHANNEL_TIMEOUT'); }
  final disconnected = rpc.call('mutation');
  socket.closeCode = 4003;
  await socket.incoming.close();
  try { await disconnected; throw StateError('disconnected call accepted'); }
  on RpcException catch (error) { assert(error.code == 'AUTH_FAILED'); }
  assert(socket.sent.where((message) => message['method'] == 'mutation').length == 1);
  await listener.cancel();
  try { await RpcClient.connect(Uri.parse('ws://example.invalid')); throw StateError('insecure endpoint accepted'); }
  on RpcException { /* Production connections require TLS. */ }
  try {
    await RpcClient.connect(Uri.parse('wss://example.invalid'), dial: (_, _) async => throw const WebSocketException('rejected', 401));
    throw StateError('401 accepted');
  } on RpcException catch (error) { assert(error.code == 'AUTH_FAILED'); }
  try {
    await RpcClient.connect(Uri.parse('wss://example.invalid'), dial: (_, _) async => throw const WebSocketException('forbidden', 403));
    throw StateError('403 accepted');
  } on WebSocketException { /* Only an actual 401 triggers token recovery. */ }
  print('RPC transport contract passed');
}
