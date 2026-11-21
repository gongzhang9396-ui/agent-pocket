import '../session/session_manager.dart';
import 'rpc_client.dart';

class RelayHost {
  const RelayHost({required this.id, required this.name, required this.online,
    required this.signingPublicKey, required this.encryptionPublicKey, this.lastSeenAt});
  final String id;
  final String name;
  final bool online;
  final String signingPublicKey;
  final String encryptionPublicKey;
  final int? lastSeenAt;
}

abstract interface class HostListConnection {
  Future<dynamic> call(String method, [Map<String, dynamic> params = const {}]);
  Future<void> close();
}

typedef HostListConnect = Future<HostListConnection> Function(Uri uri, String accessToken);

class _RpcConnection implements HostListConnection {
  _RpcConnection(this.rpc);
  final RpcClient rpc;
  @override Future<dynamic> call(String method, [Map<String, dynamic> params = const {}]) => rpc.call(method, params);
  @override Future<void> close() => rpc.close();
}

/// A read-only directory request. A stale account result is discarded by the
/// session manager, and no task or approval write is ever replayed here.
class RelayHosts {
  RelayHosts(this.sessions, {HostListConnect? connect}) : _connect = connect ?? _open;
  final SessionManager sessions;
  final HostListConnect _connect;
  static Future<HostListConnection> _open(Uri uri, String token) async => _RpcConnection(await RpcClient.connect(uri, token: token));

  Future<List<RelayHost>> list(SessionRef session) => sessions.read(session, (credentials) async {
    final base = Uri.tryParse(credentials['endpoint'] as String? ?? '');
    if (base == null || base.scheme != 'https' || base.host.isEmpty || base.userInfo.isNotEmpty ||
        base.hasQuery || base.hasFragment) { throw const FormatException('服务器地址无效'); }
    final uri = base.replace(scheme: 'wss', path: '${base.path.replaceFirst(RegExp(r'/+$'), '')}/ws/device');
    final token = credentials['accessToken'];
    if (token is! String || token.isEmpty) throw SignInRequired();
    HostListConnection? connection;
    try {
      connection = await _connect(uri, token);
      final hello = await connection.call('relay/hello', {'protocolVersion': 2, 'deviceId': credentials['deviceId']});
      if (hello is! Map || hello['protocolVersion'] != 2 || hello['deviceId'] != credentials['deviceId'] ||
          hello['accountId'] != credentials['accountId']) { throw const FormatException('Relay 身份不匹配'); }
      final result = await connection.call('host/list');
      if (result is! List) throw const FormatException('电脑列表格式无效');
      final ids = <String>{};
      final hosts = <RelayHost>[];
      for (final item in result) {
        if (item is! Map) throw const FormatException('电脑资料无效');
        final id = item['id'], name = item['name'], sign = item['signingPublicKey'], box = item['encryptionPublicKey'];
        if (id is! String || id.isEmpty || !ids.add(id) || name is! String || name.isEmpty ||
            sign is! String || sign.isEmpty || box is! String || box.isEmpty || item['online'] is! bool ||
            (item['lastSeenAt'] != null && item['lastSeenAt'] is! int)) { throw const FormatException('电脑资料不完整'); }
        hosts.add(RelayHost(id: id, name: name, online: item['online'] as bool,
          signingPublicKey: sign, encryptionPublicKey: box, lastSeenAt: item['lastSeenAt'] as int?));
      }
      return List.unmodifiable(hosts);
    } on RpcException catch (error) {
      if (error.code == 'AUTH_FAILED') throw AccessRejected();
      rethrow;
    } finally { await connection?.close(); }
  });
}
