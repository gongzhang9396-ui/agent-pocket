import 'dart:async';
import 'dart:convert';
import 'dart:io';

class RpcException implements Exception {
  const RpcException(this.message, [this.code]);
  final String message;
  final String? code;
  @override String toString() => message;
}
/// The transport can prove this request's envelope was never submitted.
class RpcRequestNotSent implements Exception {
  const RpcRequestNotSent(this.cause);
  final Object cause;
  @override String toString() => cause.toString();
}

/// JSON-RPC transport only. Encryption is implemented at the channel layer.
/// Calls that lose their connection are never automatically replayed.
class RpcClient {
  RpcClient.fromSocket(this._socket, {this.timeout = const Duration(seconds: 30)}) {
    _subscription = _socket.listen(_onMessage, onError: (_) => _finish(), onDone: _finish, cancelOnError: true);
  }
  final WebSocket _socket;
  final Duration timeout;
  late final StreamSubscription<dynamic> _subscription;
  final _events = StreamController<Map<String, dynamic>>.broadcast();
  final _pending = <int, Completer<dynamic>>{};
  var _nextId = 1;
  var _closed = false;
  Stream<Map<String, dynamic>> get events => _events.stream;

  static Future<RpcClient> connect(Uri endpoint, {String? token, Duration timeout = const Duration(seconds: 30),
      Future<WebSocket> Function(Uri uri, String? token)? dial}) async {
    if (endpoint.scheme != 'wss' || endpoint.host.isEmpty || endpoint.userInfo.isNotEmpty || endpoint.hasFragment) {
      throw const RpcException('连接地址无效');
    }
    try {
      final socket = await (dial == null ? WebSocket.connect(endpoint.toString(), headers: {
        if (token != null && token.isNotEmpty) HttpHeaders.authorizationHeader: 'Bearer $token',
      }) : dial(endpoint, token)).timeout(timeout);
      return RpcClient.fromSocket(socket, timeout: timeout);
    } on WebSocketException catch (error) {
      if (error.httpStatusCode == HttpStatus.unauthorized) throw const RpcException('Relay 登录已失效', 'AUTH_FAILED');
      rethrow;
    }
  }

  Future<dynamic> call(String method, [Map<String, dynamic> params = const {}]) async {
    if (_closed) throw const RpcException('连接已中断', 'CONNECTION_LOST');
    final id = _nextId++;
    final pending = Completer<dynamic>();
    _pending[id] = pending;
    try {
      try {
        _socket.add(jsonEncode({'jsonrpc': '2.0', 'id': id, 'method': method, 'params': params}));
      } catch (_) {
        _pending.remove(id);
        _finish();
        throw const RpcException('连接已中断，操作结果可能尚未确定', 'CONNECTION_LOST');
      }
      return await pending.future.timeout(timeout, onTimeout: () => throw const RpcException('请求超时，操作结果可能尚未确定', 'CHANNEL_TIMEOUT'));
    } finally {
      _pending.remove(id);
    }
  }

  void _onMessage(dynamic raw) {
    if (_closed || raw is! String) return;
    Map<String, dynamic> message;
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map<String, dynamic> || decoded['jsonrpc'] != '2.0') return;
      message = decoded;
    } on FormatException { return; }
    final method = message['method'];
    if (method is String) {
      _events.add({'method': method, 'params': message['params'] is Map ? message['params'] : <String, dynamic>{}});
      return;
    }
    final id = message['id'];
    if (id is! int) return;
    final request = _pending.remove(id);
    if (request == null) return;
    final error = message['error'];
    if (error is Map) {
      final data = error['data'];
      final code = data is Map ? (data['name'] ?? error['code']) : error['code'];
      request.completeError(RpcException(error['message'] is String ? error['message'] : '请求失败', code?.toString()));
    } else if (message.containsKey('result')) {
      request.complete(message['result']);
    } else {
      request.completeError(const RpcException('返回格式不兼容', 'INVALID_RESPONSE'));
    }
  }

  void _finish() {
    if (_closed) return;
    _closed = true;
    final code = _socket.closeCode == 4003 ? 'AUTH_FAILED' : 'CONNECTION_LOST';
    final error = RpcException(code == 'AUTH_FAILED' ? 'Relay 登录已失效' : '连接已中断，操作结果可能尚未确定', code);
    final requests = _pending.values.toList();
    _pending.clear();
    for (final request in requests) { if (!request.isCompleted) request.completeError(error); }
    unawaited(_events.close());
  }

  Future<void> close() async {
    _finish();
    await _subscription.cancel();
    await _socket.close(WebSocketStatus.normalClosure);
  }
}
