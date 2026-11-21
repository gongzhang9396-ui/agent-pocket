import 'dart:math';
import 'dart:io';
import 'dart:async';
import 'package:sodium/sodium_sumo.dart';
import '../protocol/host_read_channel.dart';
import '../protocol/relay_hosts.dart';
import '../protocol/rpc_client.dart';
import '../session/session_manager.dart';
import 'task_catalog.dart';
import 'artifact_reader.dart';

typedef CatalogSocketConnect = Future<RpcClient> Function(Uri uri, String token);
class MutationNotSent extends RpcRequestNotSent { MutationNotSent(super.cause); }

/// Pulls one Host's task catalog using a short-lived Relay connection. Closing
/// the owning socket also clears Relay-side channels after an uncertain error.
class HostCatalogLoader {
  HostCatalogLoader(this.sodium, this.sessions, {CatalogSocketConnect? connect}) : _connect = connect ?? _open;
  final SodiumSumo sodium;
  final SessionManager sessions;
  final CatalogSocketConnect _connect;
  int _activeChannels = 0;
  final List<Completer<void>> _channelQueue = [];
  Future<void> _acquire() async {
    if (_activeChannels < 2) { _activeChannels++; return; }
    final waiting = Completer<void>(); _channelQueue.add(waiting); await waiting.future;
  }
  void _release() {
    if (_channelQueue.isNotEmpty) { _channelQueue.removeAt(0).complete(); }
    else { _activeChannels--; }
  }
  static Future<RpcClient> _open(Uri uri, String token) => RpcClient.connect(uri, token: token);

  Future<List<Map<String, dynamic>>> load(SessionRef ref, RelayHost host) =>
      _withChannel(ref, host, (channel) => TaskCatalog(channel.read).load(channel.capabilities));

  Future<Map<String, dynamic>> readThread(SessionRef ref, RelayHost host, String threadId, {String? cursor}) {
    if (threadId.isEmpty || threadId.length > 100 || (cursor != null && (cursor.trim().isEmpty || cursor.length > 4096))) {
      throw const FormatException('任务或历史游标无效');
    }
    return _withChannel(ref, host, (channel) async {
      final params = <String, dynamic>{'threadId': threadId};
      if (cursor != null) { params['cursor'] = cursor; }
      final result = await channel.read('thread/read', params);
      if (result is! Map<String, dynamic> || result['thread'] is! Map || result['thread']['id'] != threadId) {
        throw const FormatException('电脑返回的任务详情不匹配');
      }
      final page = result['page'];
      if (page != null && page is! Map) throw const FormatException('历史分页格式无效');
      if (page is Map && page['hasMore'] == true &&
          (page['nextCursor'] is! String || (page['nextCursor'] as String).trim().isEmpty || page['nextCursor'] == cursor)) {
        throw const FormatException('历史分页游标无效');
      }
      return Map.unmodifiable(result);
    });
  }

  Future<List<Map<String, dynamic>>> listArtifacts(SessionRef ref, RelayHost host, String threadId, {String? cursor}) =>
      _withChannel(ref, host, (channel) => ArtifactReader(channel.read).list(threadId, cursor: cursor));

  Future<Map<String, dynamic>> readTaskSupport(SessionRef ref, RelayHost host, String threadId, String method) {
    if (threadId.isEmpty || threadId.length > 100 ||
        !{'thread/model-options', 'thread/interactions', 'goal/get'}.contains(method)) {
      throw const FormatException('任务读取请求无效');
    }
    return _withChannel(ref, host, (channel) async {
      final result = await channel.read(method, {'threadId': threadId});
      if (result is! Map<String, dynamic>) throw const FormatException('电脑返回的数据格式无效');
      return Map.unmodifiable(result);
    });
  }

  Future<void> downloadArtifact(SessionRef ref, RelayHost host, String threadId, Map<String, dynamic> artifact,
      RandomAccessFile output, {bool Function()? cancelled, void Function(int bytes, int total)? onProgress}) =>
      _withChannel(ref, host, (channel) => ArtifactReader(channel.read).download(threadId, artifact, output,
        cancelled: cancelled, onProgress: onProgress));

  Future<dynamic> read(SessionRef ref, RelayHost host, String method, [Map<String, dynamic> params = const {}]) =>
    _withChannel(ref, host, (channel) => channel.read(method, params));

  /// Fresh credentials are shared, but a write itself is never enclosed in
  /// sessions.read(), whose 401 handling may repeat an idempotent request.
  Future<dynamic> execute(SessionRef ref, RelayHost host, String method, Map<String, dynamic> params) async {
    var reachedChannel = false;
    try {
      final credentials = await sessions.fresh(ref);
      final result = await _usingCredentials(credentials, host, (channel) async {
        if (!sessions.isCurrent(ref)) throw SessionChanged();
        // Check local capability restrictions before calling the transport.
        if ((method.startsWith('attachment/') || params.containsKey('attachmentIds')) && !channel.capabilities.contains('attachments-v2')) {
          throw StateError('大附件需要先更新电脑端');
        }
        reachedChannel = true;
        return channel.execute(method, params);
      }, stillCurrent: () => sessions.isCurrent(ref));
      if (!sessions.isCurrent(ref)) throw SessionChanged();
      return result;
    } catch (error) { if (!reachedChannel) throw MutationNotSent(error); rethrow; }
  }

  Future<Set<String>> capabilities(SessionRef ref, RelayHost host) => _withChannel(ref, host, (channel) async => channel.capabilities);

  /// A batch upload uses one handshake/channel for all 192 KiB chunks. A
  /// failure exits the batch; the caller explicitly resumes with status later.
  Future<T> transfer<T>(SessionRef ref, RelayHost host, Future<T> Function(HostReadChannel) action) async {
    final credentials = await sessions.fresh(ref);
    return _usingCredentials(credentials, host, (channel) async {
      if (!sessions.isCurrent(ref)) throw SessionChanged();
      final result = await action(channel);
      if (!sessions.isCurrent(ref)) throw SessionChanged();
      return result;
    }, stillCurrent: () => sessions.isCurrent(ref));
  }

  Future<T> _withChannel<T>(SessionRef ref, RelayHost host, Future<T> Function(HostReadChannel) read) =>
    sessions.read(ref, (credentials) => _usingCredentials(credentials, host, read, stillCurrent: () => sessions.isCurrent(ref)));

  Future<T> _usingCredentials<T>(Map<String, dynamic> credentials, RelayHost host, Future<T> Function(HostReadChannel) read, {bool Function()? stillCurrent}) async {
    await _acquire();
    try { return await _runUsingCredentials(credentials, host, read, stillCurrent: stillCurrent); }
    finally { _release(); }
  }
  Future<T> _runUsingCredentials<T>(Map<String, dynamic> credentials, RelayHost host, Future<T> Function(HostReadChannel) read, {bool Function()? stillCurrent}) async {
    if (stillCurrent?.call() == false) throw const RpcRequestNotSent(RpcException('登录状态已变化', 'SESSION_CHANGED'));
    if (!host.online) throw const RpcException('电脑当前离线', 'HOST_OFFLINE');
    final endpoint = Uri.tryParse(credentials['endpoint'] as String? ?? '');
    if (endpoint == null || endpoint.scheme != 'https' || endpoint.host.isEmpty || endpoint.userInfo.isNotEmpty ||
        endpoint.hasQuery || endpoint.hasFragment) { throw const FormatException('服务器地址无效'); }
    final token = credentials['accessToken'];
    if (token is! String || token.isEmpty) throw SignInRequired();
    final uri = endpoint.replace(scheme: 'wss', path: '${endpoint.path.replaceFirst(RegExp(r'/+$'), '')}/ws/device');
    RpcClient rpc;
    try { rpc = await _connect(uri, token); }
    on RpcException catch (error) {
      if (error.code == 'AUTH_FAILED') throw AccessRejected();
      rethrow;
    }
    HostReadChannel? channel;
    try {
      dynamic hello;
      try { hello = await rpc.call('relay/hello', {'protocolVersion': 2, 'deviceId': credentials['deviceId']}); }
      on RpcException catch (error) {
        if (error.code == 'AUTH_FAILED') throw AccessRejected();
        rethrow;
      }
      if (hello is! Map || hello['protocolVersion'] != 2 || hello['accountId'] != credentials['accountId'] ||
          hello['deviceId'] != credentials['deviceId']) { throw const FormatException('Relay 身份不匹配'); }
      final random = Random.secure();
      final channelId = List.generate(16, (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
      channel = await HostReadChannel.open(sodium, RelayOuterAdapter(rpc), credentials,
        {'id': host.id, 'signingPublicKey': host.signingPublicKey, 'encryptionPublicKey': host.encryptionPublicKey}, channelId, stillCurrent: stillCurrent);
      return await read(channel);
    } finally {
      try { await channel?.close(); } finally { await rpc.close(); }
    }
  }
}
