import 'dart:async';
import 'dart:convert';
import '../session/session_manager.dart';
import 'relay_hosts.dart';
import 'rpc_client.dart';

abstract interface class FeedCursorStore {
  Future<Map<String, dynamic>> load(String scope, String hostId);
  Future<void> save(String scope, String hostId, Map<String, dynamic> state);
}
abstract interface class FeedConnection {
  Stream<Map<String, dynamic>> get events;
  Future<dynamic> call(String method, [Map<String, dynamic> params = const {}]);
  Future<void> close();
}
class RpcFeedConnection implements FeedConnection {
  RpcFeedConnection(this.rpc);
  final RpcClient rpc;
  @override Stream<Map<String, dynamic>> get events => rpc.events;
  @override Future<dynamic> call(String method, [Map<String, dynamic> params = const {}]) => rpc.call(method, params);
  @override Future<void> close() => rpc.close();
}
class FeedUpdate {
  const FeedUpdate(this.type, {this.hostId, this.value, this.replayed = false, this.sessionGeneration});
  final int? sessionGeneration;
  final String type;
  final String? hostId;
  final Map<String, dynamic>? value;
  final bool replayed;
}

/// One app-level Relay event connection. Reconnects rebuild secretstream RPC
/// channels separately; no mutation is held/replayed by this feed.
class RelayEventFeed {
  RelayEventFeed(this.sessions, this.store, this.decrypt, {Future<FeedConnection> Function(Uri, String)? connect})
    : connect = connect ?? _connect;
  final SessionManager sessions;
  final FeedCursorStore store;
  final String Function(Map<String, dynamic>, String) decrypt;
  final Future<FeedConnection> Function(Uri, String) connect;
  static Future<FeedConnection> _connect(Uri uri, String token) async => RpcFeedConnection(await RpcClient.connect(uri, token: token));
  final _updates = StreamController<FeedUpdate>.broadcast();
  Stream<FeedUpdate> get updates => _updates.stream;
  final Map<String, Map<String, dynamic>> _cursors = {};
  final Map<String, RelayHost> _hosts = {};
  SessionRef? _session;
  String? _viewedHost, _viewedThread;
  FeedConnection? _connection;
  StreamSubscription<Map<String, dynamic>>? _subscription;
  Future<void> _tail = Future.value();
  Timer? _retry, _renewal;
  int _generation = 0, _attempt = 0;
  bool _wanted = false, _opening = false;
  bool get connected => _connection != null && !_opening;
  void _emit(FeedUpdate update) {
    if (!_updates.isClosed) {
      _updates.add(FeedUpdate(update.type, hostId: update.hostId, value: update.value,
        replayed: update.replayed, sessionGeneration: _session?.generation));
    }
  }
  String _scope(String host) => jsonEncode([_session!.credentials['endpoint'], _session!.credentials['accountId'], _session!.credentials['deviceId'], host]);
  bool _valid(int generation) => _wanted && generation == _generation && _session != null && sessions.isCurrent(_session!);

  Future<void> start(SessionRef session, List<RelayHost> hosts) async {
    final identity = jsonEncode([session.generation, session.credentials['endpoint'], session.credentials['deviceId'],
      hosts.map((host) => [host.id, host.signingPublicKey, host.encryptionPublicKey]).toList()]);
    final previous = _session == null ? '' : jsonEncode([_session!.generation, _session!.credentials['endpoint'], _session!.credentials['deviceId'],
      _hosts.values.map((host) => [host.id, host.signingPublicKey, host.encryptionPublicKey]).toList()]);
    if (_wanted && identity == previous) return;
    await stop();
    _tail = Future.value();
    _session = session; _hosts..clear()..addEntries(hosts.map((host) => MapEntry(host.id, host))); _cursors.clear();
    _wanted = true; _attempt = 0;
    await _open();
  }
  Future<void> _open() async {
    if (!_wanted || _opening || _session == null) return;
    _opening = true; final generation = _generation;
    final ready = Completer<void>();
    try {
      final connection = await sessions.read(_session!, (credentials) async {
        final endpoint = Uri.parse(credentials['endpoint'] as String);
        final uri = endpoint.replace(scheme: 'wss', path: '${endpoint.path.replaceFirst(RegExp(r'/+$'), '')}/ws/device');
        FeedConnection? socket;
        try {
          socket = await connect(uri, credentials['accessToken'] as String);
          final hello = await socket.call('relay/hello', {'protocolVersion': 2, 'deviceId': credentials['deviceId']});
          if (hello is! Map || hello['accountId'] != credentials['accountId'] || hello['deviceId'] != credentials['deviceId'] || hello['protocolVersion'] != 2) {
            throw const FormatException('Relay 身份不匹配');
          }
          return socket;
        } on RpcException catch (error) { await socket?.close(); if (error.code == 'AUTH_FAILED') throw AccessRejected(); rethrow; }
        catch (_) { await socket?.close(); rethrow; }
      });
      if (!_valid(generation)) { await connection.close(); return; }
      _connection = connection;
      _subscription = connection.events.listen((event) {
        _tail = _tail.then((_) async {
          await ready.future; if (!_valid(generation)) return;
          final method = event['method'], params = event['params'];
          if (method == 'relay/event' && params is Map<String, dynamic>) {
            await _event(params, generation);
          } else if (method == 'snapshot/updated' && params is Map && _hosts.containsKey(params['hostId'])) {
            await _snapshot(params['hostId'] as String, generation);
          } else if (method == 'host/status' || method == 'host/updated') { _emit(const FeedUpdate('directory')); }
        }).catchError((Object error) {
          if (!_valid(generation)) return;
          if (error is FormatException) { _emit(const FeedUpdate('syncWarning')); }
          else { _lost(generation, error); }
        });
      }, onDone: () => _lost(generation, const RpcException('连接已断开')), onError: (Object error) => _lost(generation, error));
      for (final host in _hosts.keys) {
        _cursors[host] ??= await store.load(_scope(host), host);
        if (!_valid(generation)) return;
        try { await _snapshot(host, generation); await _recover(host, generation); }
        on FormatException { _emit(FeedUpdate('syncWarning', hostId: host)); _emit(FeedUpdate('resync', hostId: host)); }
      }
      if (!_valid(generation)) return;
      _attempt = 0; _emit(const FeedUpdate('connected'));
      _renewal = Timer(const Duration(minutes: 8), () { _lost(generation, StateError('定期刷新连接')); });
    } catch (error) {
      if (_valid(generation)) {
        _lost(generation, error);
      } else if (_wanted && generation == _generation && (error is SignInRequired || error is SessionChanged)) { _wanted = false; _emit(const FeedUpdate('loginRequired')); }
    } finally { if (!ready.isCompleted) ready.complete(); if (generation == _generation) _opening = false; }
  }
  Future<Map<String, dynamic>> _decode(Map<String, dynamic> envelope, String host, String kind) async {
    final session = _session;
    if (session == null || !sessions.isCurrent(session)) throw SessionChanged();
    final credentials = session.credentials;
    if (envelope['accountId'] != credentials['accountId'] || envelope['hostId'] != host || envelope['deviceId'] != host ||
        envelope['kind'] != kind || envelope['channelId'] != (kind == 'event.append' ? 'events' : 'snapshot') ||
        envelope['counter'] is! int || (envelope['counter'] as int) < 0) {
      throw const FormatException('同步消息身份无效');
    }
    try {
      final decoded = jsonDecode(decrypt(envelope, credentials['contentKey'] as String));
      if (decoded is! Map<String, dynamic>) throw const FormatException('同步消息格式无效');
      return decoded;
    } catch (_) { throw const FormatException('同步消息未通过解密或内容校验'); }
  }
  Future<void> _snapshot(String host, int generation) async {
    final result = await _connection!.call('snapshot/get', {'hostId': host});
    if (!_valid(generation) || result == null) return;
    if (result is! Map || result['envelope'] is! Map<String, dynamic>) throw const FormatException('快照格式无效');
    final envelope = result['envelope'] as Map<String, dynamic>;
    final value = await _decode(envelope, host, 'snapshot.put');
    if (!_valid(generation)) return;
    final cursor = _cursors[host]!;
    if ((envelope['counter'] as int) < (cursor['revision'] as int? ?? 0)) throw const FormatException('电脑快照版本倒退');
    cursor['revision'] = envelope['counter']; await store.save(_scope(host), host, cursor);
    if (_valid(generation)) _emit(FeedUpdate('snapshot', hostId: host, value: value));
  }
  Future<void> _recover(String host, int generation) async {
    final cursor = _cursors[host]!;
    var allowGap = (cursor['seq'] as int? ?? 0) == 0, from = cursor['seq'] as int? ?? 0;
    for (var page = 0; page < 1000; page++) {
      dynamic events;
      try { events = await _connection!.call('event/replay', {'hostId': host, 'lastSeq': from, 'limit': 128}); }
      on RpcException catch (error) {
        if (error.code != 'EVENT_GAP' || from == 0) rethrow;
        await _snapshot(host, generation); from = 0; allowGap = true;
        events = await _connection!.call('event/replay', {'hostId': host, 'lastSeq': 0, 'limit': 128});
      }
      if (!_valid(generation)) return;
      if (events is! List) throw const FormatException('事件回放格式无效');
      if (events.isEmpty) { _emit(FeedUpdate('resync', hostId: host)); return; }
      final before = cursor['seq'] as int? ?? 0;
      for (final event in events) {
        if (!_valid(generation)) return;
        if (event is! Map<String, dynamic>) throw const FormatException('事件格式无效');
        await _event(event, generation, replayed: true, allowGap: allowGap); allowGap = false;
      }
      from = cursor['seq'] as int? ?? 0;
      if (from <= before) throw const FormatException('事件回放没有取得进展');
      await store.save(_scope(host), host, cursor);
    }
    throw const FormatException('回放超出合理页数，请刷新电脑状态');
  }
  Future<void> _event(Map<String, dynamic> event, int generation, {bool replayed = false, bool allowGap = false}) async {
    final envelope = event['envelope'], seq = event['seq'];
    if (envelope is! Map<String, dynamic> || seq is! int || seq < 1 || !_hosts.containsKey(envelope['hostId'])) throw const FormatException('事件来源无效');
    final host = envelope['hostId'] as String;
    final cursor = _cursors[host];
    if (cursor == null) return; // Initial snapshots will recover this host.
    final previous = cursor['seq'] as int? ?? 0;
    if (seq <= previous) return;
    if (seq != previous + 1 && !allowGap) {
      if (!replayed) { await _snapshot(host, generation); await _recover(host, generation); return; }
      _emit(FeedUpdate('syncWarning', hostId: host));
    }
    Map<String, dynamic> value;
    try {
      value = await _decode(envelope, host, 'event.append');
      if (value['eventId'] != envelope['eventId'] || value['type'] is! String) throw const FormatException('事件内容与信封不匹配');
      if ((envelope['counter'] as int) <= (cursor['eventCounter'] as int? ?? -1)) throw const FormatException('事件计数器重复或倒退');
    } on FormatException {
      // Never apply unverified data. Skip a corrupt cached envelope and read
      // authoritative Host history rather than reconnecting in a loop.
      if (_valid(generation)) {
        cursor['seq'] = seq; if (!replayed) await store.save(_scope(host), host, cursor);
        _emit(FeedUpdate('syncWarning', hostId: host)); _emit(FeedUpdate('resync', hostId: host));
      }
      return;
    }
    if (!_valid(generation)) return;
    final unread = (cursor['unread'] as List? ?? []).whereType<String>().toSet();
    if (value['threadId'] is String && !(_viewedHost == host && _viewedThread == value['threadId'])) unread.add(value['threadId'] as String);
    cursor['unread'] = unread.toList().reversed.take(500).toList().reversed.toList();
    cursor['eventCounter'] = envelope['counter'];
    cursor['seq'] = seq; if (!replayed) await store.save(_scope(host), host, cursor);
    if (_valid(generation)) _emit(FeedUpdate('event', hostId: host, value: value, replayed: replayed));
  }
  Set<String> unread(String hostId) => (_cursors[hostId]?['unread'] as List? ?? []).whereType<String>().toSet();
  void view(String? host, String? thread) {
    _viewedHost = host; _viewedThread = thread;
    if (host == null || thread == null || _session == null) return;
    final generation = _generation;
    _tail = _tail.then((_) async {
      if (!_valid(generation)) return;
      final cursor = _cursors[host]; if (cursor == null) return;
      cursor['unread'] = (cursor['unread'] as List? ?? []).where((id) => id != thread).toList();
      await store.save(_scope(host), host, cursor);
    }).catchError((Object _) {});
  }
  void _lost(int generation, Object error) {
    if (!_valid(generation)) return;
    _generation++; _opening = false; _renewal?.cancel(); _retry?.cancel();
    final connection = _connection; _connection = null;
    final subscription = _subscription; _subscription = null;
    unawaited(subscription?.cancel()); unawaited(connection?.close());
    _emit(const FeedUpdate('disconnected'));
    _retry = Timer(Duration(seconds: (1 << (_attempt++).clamp(0, 5)).clamp(1, 30)), () => unawaited(_open()));
  }
  Future<void> stop() async {
    _wanted = false; _generation++; _retry?.cancel(); _renewal?.cancel();
    _opening = false; final connection = _connection; _connection = null;
    final subscription = _subscription; _subscription = null;
    await subscription?.cancel(); await connection?.close(); _emit(const FeedUpdate('disconnected'));
  }
  Future<void> forget() async { await stop(); _session = null; _hosts.clear(); _cursors.clear(); _viewedHost = _viewedThread = null; }
}
