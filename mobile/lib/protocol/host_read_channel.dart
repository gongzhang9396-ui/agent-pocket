import 'dart:async';
import 'dart:convert';
import 'package:sodium/sodium_sumo.dart';

import 'relay_phone_channel.dart';
import 'rpc_client.dart';

/// Outer transport is the already-authenticated Relay connection.
abstract interface class HostOuterTransport {
  Stream<Map<String, dynamic>> get events;
  Future<dynamic> call(String method, [Map<String, dynamic> params = const {}]);
}

class RelayOuterAdapter implements HostOuterTransport {
  RelayOuterAdapter(this.client);
  final RpcClient client;
  @override Stream<Map<String, dynamic>> get events => client.events;
  @override Future<dynamic> call(String method, [Map<String, dynamic> params = const {}]) => client.call(method, params);
}

class _Failure {
  _Failure(this.error);
  final Object error;
}
class HostRequestRejected extends RpcException {
  const HostRequestRejected(super.message, [super.code]);
}

/// Serial Host RPC. Reads and explicit writes have separate entry points;
/// neither entry point retries after an ambiguous transport error.
class HostReadChannel {
  HostReadChannel._(this._outer, this._crypto, this.timeout, this.stillCurrent);
  final bool Function()? stillCurrent;
  final HostOuterTransport _outer;
  final RelayPhoneChannel _crypto;
  final Duration timeout;
  late final StreamSubscription<Map<String, dynamic>> _subscription;
  Future<void> _incoming = Future.value();
  Future<void> _serialTail = Future.value();
  Completer<Object?>? _waiter;
  int? _expectedId;
  int _nextId = 2;
  bool _accepted = false;
  bool _closed = false;
  Future<void>? _closeTask;
  Set<String> _capabilities = const {};
  Set<String> get capabilities => _capabilities;

  static const _allowed = {'project/list', 'agent/list', 'model/list', 'host/runtime',
    'thread/list', 'thread/read', 'thread/interactions', 'thread/model-options', 'thread/watch', 'thread/unwatch', 'goal/get', 'artifact/list', 'artifact/read', 'operation/get', 'attachment/status'};
  static const mutations = {'thread/start', 'turn/start', 'turn/steer', 'turn/interrupt', 'thread/handoff',
    'goal/set', 'goal/clear', 'approval/respond', 'question/respond', 'desktop/launch',
    'attachment/begin', 'attachment/write', 'attachment/finish', 'attachment/abort'};

  static Future<HostReadChannel> open(SodiumSumo sodium, HostOuterTransport outer,
      Map<String, dynamic> credentials, Map<String, dynamic> host, String channelId,
      {Duration timeout = const Duration(seconds: 20), bool Function()? stillCurrent}) async {
    final deviceId = credentials['deviceId'];
    final hostId = host['id'];
    if (deviceId is! String || hostId is! String) throw const FormatException('设备或电脑身份无效');
    final first = jsonEncode({'jsonrpc': '2.0', 'id': 1, 'method': 'bridge/hello',
      'params': {'protocolVersion': 1, 'deviceId': deviceId}});
    final opened = await RelayPhoneChannel.open(sodium, credentials, host, channelId, firstMessage: first);
    final result = HostReadChannel._(outer, opened.channel, timeout, stillCurrent);
    result._subscription = outer.events.listen(result._queueEvent, onError: (Object error) => result._fail(error),
      onDone: () => result._fail(const RpcException('Relay 连接已中断', 'CONNECTION_LOST')));
    try {
      final response = result._prepare();
      await outer.call('channel/open', {'envelope': opened.envelope}).timeout(timeout);
      await result._wait(response);
      final firstResponse = result._prepare(expectedId: 1);
      final envelope = await opened.channel.takeFirstEnvelope();
      await outer.call('channel/data', {'envelope': envelope}).timeout(timeout);
      final hello = await result._wait(firstResponse);
      // Bridge's local host ID is generated independently from the Relay host
      // ID. The signed channel handshake already authenticates the Relay host.
      if (hello is! Map || hello['protocolVersion'] != 1 || hello['deviceId'] != deviceId ||
          hello['hostId'] is! String || (hello['hostId'] as String).isEmpty) {
        throw const FormatException('电脑握手身份不匹配');
      }
      final capabilities = hello['capabilities'];
      if (capabilities != null && (capabilities is! List || capabilities.any((value) => value is! String))) {
        throw const FormatException('电脑能力列表无效');
      }
      result._capabilities = Set.unmodifiable((capabilities as List? ?? const []).cast<String>());
      return result;
    } catch (_) { await result.close(); rethrow; }
  }

  Completer<Object?> _prepare({int? expectedId}) {
    if (_closed || _waiter != null) throw StateError('通道状态无效');
    _expectedId = expectedId;
    return _waiter = Completer<Object?>();
  }

  Future<dynamic> _wait(Completer<Object?> waiting) async {
    final value = await waiting.future.timeout(timeout);
    if (value is _Failure) throw value.error;
    return value;
  }

  void _complete(Object? value) {
    final waiter = _waiter;
    _waiter = null;
    _expectedId = null;
    if (waiter != null && !waiter.isCompleted) waiter.complete(value);
  }

  void _fail(Object error) {
    _closed = true;
    _complete(_Failure(error));
    // Cleanup is scheduled outside the event handler so it never waits on
    // itself; close() also remains available for callers to await explicitly.
    scheduleMicrotask(() { unawaited(close().catchError((Object _) {})); });
  }

  void _queueEvent(Map<String, dynamic> event) {
    _incoming = _incoming.then((_) => _handle(event)).catchError((Object error) { _fail(error); });
  }

  Future<void> _handle(Map<String, dynamic> event) async {
    if (_closed) return;
    final method = event['method'];
    final params = event['params'];
    if (params is! Map) return;
    if (method == 'channel/close' && params['channelId'] == _crypto.channelId) {
      _fail(const RpcException('电脑通道已关闭', 'CHANNEL_CLOSED'));
      return;
    }
    if (method != 'channel/open' && method != 'channel/data') return;
    final value = params['envelope'];
    if (value is! Map<String, dynamic> || value['channelId'] != _crypto.channelId) return;
    if (method == 'channel/open' && !_accepted) {
      await _crypto.accept(value);
      _accepted = true;
      _complete(null);
      return;
    }
    if (method != 'channel/data' || !_accepted) throw const FormatException('电脑通道顺序无效');
    final decoded = jsonDecode(await _crypto.decrypt(value));
    if (decoded is! Map || decoded['jsonrpc'] != '2.0' || decoded['id'] != _expectedId || _waiter == null) {
      throw const FormatException('电脑响应与请求不匹配');
    }
    final error = decoded['error'];
    if (error is Map) {
      final data = error['data'];
      final code = data is Map ? (data['name'] ?? error['code']) : error['code'];
      _complete(_Failure(HostRequestRejected(error['message'] is String ? error['message'] as String : '电脑请求失败', code?.toString())));
    } else if (decoded.containsKey('result')) {
      _complete(decoded['result']);
    } else { throw const FormatException('电脑响应格式无效'); }
  }

  Future<dynamic> read(String method, [Map<String, dynamic> params = const {}]) async {
    if (!_allowed.contains(method)) throw ArgumentError('此通道只支持已声明的读取操作');
    return _call(method, params);
  }

  Future<dynamic> execute(String method, Map<String, dynamic> params) async {
    try {
      if (!mutations.contains(method)) throw ArgumentError('未知写入操作');
      if (!method.startsWith('attachment/') && method != 'desktop/launch' &&
          (params['operationId'] is! String || (params['operationId'] as String).isEmpty)) {
        throw ArgumentError('写入操作必须提供持久化操作编号');
      }
      if (method == 'desktop/launch' && (!capabilities.contains('desktop-wake-safe-v2') || !capabilities.contains('desktop-wake-v1'))) {
        throw StateError('请更新电脑端后再使用唤起 Codex');
      }
      _validateCapability(method, params);
    } catch (error) { throw RpcRequestNotSent(error); }
    return _call(method, params, validated: true);
  }

  void _validateCapability(String method, Map<String, dynamic> params) {
    if ((method.startsWith('attachment/') || params.containsKey('attachmentIds')) && !_capabilities.contains('attachments-v2')) {
      throw StateError('20 MiB 附件需要更新电脑端');
    }
    if (method.startsWith('artifact/') && !_capabilities.contains('artifacts-v1')) {
      throw StateError('电脑端不支持文件读取，请先更新电脑端');
    }
    final capability = switch (method) {
      'thread/model-options' => 'model-control-v1',
      'goal/get' => 'goal-v1',
      'goal/set' || 'goal/clear' => 'goal-v1',
      'thread/handoff' => 'handoff-v1',
      'thread/interactions' => 'interaction-snapshot-v1',
      _ => null,
    };
    if (capability != null && !_capabilities.contains(capability)) throw StateError('电脑端未声明此功能');
  }
  Future<dynamic> _call(String method, Map<String, dynamic> params, {bool validated = false}) async {
    if (!validated) _validateCapability(method, params);
    final previous = _serialTail;
    final done = Completer<void>();
    _serialTail = done.future;
    await previous;
    try {
      if (_closed) throw const RpcRequestNotSent(RpcException('电脑通道已关闭', 'CHANNEL_CLOSED'));
      if (stillCurrent?.call() == false) throw const RpcRequestNotSent(RpcException('登录状态已变化，请刷新', 'SESSION_CHANGED'));
      final id = _nextId++;
      final waiting = _prepare(expectedId: id);
      final envelope = await _crypto.encrypt(jsonEncode({'jsonrpc': '2.0', 'id': id, 'method': method, 'params': params}));
      if (stillCurrent?.call() == false) throw const RpcRequestNotSent(RpcException('登录状态已变化，请刷新', 'SESSION_CHANGED'));
      await _outer.call('channel/data', {'envelope': envelope}).timeout(timeout);
      return await _wait(waiting);
    } on HostRequestRejected { rethrow; }
    catch (_) {
      // A lost acknowledgement or response leaves stream ordering uncertain.
      _fail(const RpcException('电脑通道已中断，请重新连接', 'CHANNEL_CLOSED'));
      rethrow;
    } finally { done.complete(); }
  }

  Future<void> close() => _closeTask ??= _close();

  Future<void> _close() async {
    final graceful = !_closed && _accepted && _waiter == null;
    _closed = true;
    _complete(_Failure(const RpcException('电脑通道已关闭', 'CHANNEL_CLOSED')));
    await _serialTail;
    if (graceful) {
      try {
        final envelope = await _crypto.encrypt('', finalMessage: true);
        await _outer.call('channel/close', {'envelope': envelope}).timeout(timeout);
      } catch (_) {
        // The owning Relay connection must be closed if the close is uncertain.
      }
    }
    await _subscription.cancel();
    await _incoming;
    await _crypto.dispose();
  }
}
