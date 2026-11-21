import 'dart:convert';
import 'package:crypto/crypto.dart';
import '../protocol/relay_account_crypto.dart';
import '../protocol/rpc_client.dart';
import 'session_manager.dart';

String deviceVerificationCode(String id, String encryptionPublicKey) {
  final hex = sha256.convert(utf8.encode('agent-pocket-device-v1\u0000$id\u0000$encryptionPublicKey')).bytes.take(8)
    .map((byte) => byte.toRadixString(16).padLeft(2, '0')).join().toUpperCase();
  return List.generate(4, (index) => hex.substring(index * 4, index * 4 + 4)).join(' ');
}
class HostPairingCode {
  const HostPairingCode(this.endpoint, this.enrollmentId, this.secret);
  final String endpoint, enrollmentId, secret;
  static HostPairingCode parse(String text) {
    final uri = Uri.parse(text.trim());
    final params = uri.queryParameters;
    final endpoint = params['relay'] ?? (uri.scheme == 'https' ? uri.origin : '');
    final parsed = Uri.tryParse(endpoint), id = params['enrollmentId'], secret = params['secret'];
    if ((uri.scheme != 'agentpocket' && uri.scheme != 'https') || parsed == null || parsed.scheme != 'https' || parsed.host.isEmpty ||
        parsed.userInfo.isNotEmpty || parsed.hasQuery || parsed.hasFragment || id == null || id.length > 64 || secret == null || secret.length > 128 ||
        !RegExp(r'^[A-Za-z0-9_-]+$').hasMatch(id) || !RegExp(r'^[A-Za-z0-9_-]+$').hasMatch(secret)) {
      throw const FormatException('配对码无效');
    }
    return HostPairingCode(endpoint.replaceFirst(RegExp(r'/+$'), ''), id, secret);
  }
}

class AccountDevices {
  AccountDevices(this.sessions, this.crypto);
  final SessionManager sessions;
  final RelayAccountCrypto crypto;
  Future<T> _connection<T>(SessionRef ref, Future<T> Function(RpcClient, Map<String, dynamic>) fn, {bool read = false}) async {
    Future<T> request(Map<String, dynamic> credentials) async {
      final endpoint = Uri.parse(credentials['endpoint'] as String);
      RpcClient? rpc;
      try {
        rpc = await RpcClient.connect(endpoint.replace(scheme: 'wss', path: '${endpoint.path.replaceFirst(RegExp(r'/+$'), '')}/ws/device'), token: credentials['accessToken'] as String);
        final hello = await rpc.call('relay/hello', {'protocolVersion': 2, 'deviceId': credentials['deviceId']});
        if (hello is! Map || hello['accountId'] != credentials['accountId'] || hello['deviceId'] != credentials['deviceId']) throw const FormatException('Relay 身份不匹配');
        if (!sessions.isCurrent(ref)) throw SessionChanged();
        final value = await fn(rpc, credentials);
        if (!sessions.isCurrent(ref)) throw SessionChanged();
        return value;
      } on RpcException catch (error) { if (read && error.code == 'AUTH_FAILED') throw AccessRejected(); rethrow; }
      finally { await rpc?.close(); }
    }
    return read ? sessions.read(ref, request) : request(await sessions.fresh(ref));
  }
  Future<List<Map<String, dynamic>>> devices(SessionRef ref) => _connection(ref, (rpc, _) async => _list(await rpc.call('device/list')), read: true);
  List<Map<String, dynamic>> _list(dynamic response) {
    if (response is! List) throw const FormatException('设备列表无效');
    final ids = <String>{};
    return response.map((item) {
      if (item is! Map<String, dynamic> || item['id'] is! String || !ids.add(item['id'] as String) || item['name'] is! String ||
          !{'pending', 'approved', 'revoked'}.contains(item['status']) || item['encryption_public_key'] is! String || item['signing_public_key'] is! String) {
        throw const FormatException('设备资料不完整');
      }
      return Map<String, dynamic>.unmodifiable(item);
    }).toList();
  }
  Future<void> approve(SessionRef ref, Map<String, dynamic> selected) => _connection(ref, (rpc, credentials) async {
    final current = _list(await rpc.call('device/list')).where((device) => device['id'] == selected['id']).firstOrNull;
    if (current == null || current['status'] != 'pending' || ['name', 'signing_public_key', 'encryption_public_key', 'created_at']
      .any((key) => current[key] != selected[key])) {
      throw StateError('设备资料已变化，请重新核对');
    }
    final keyPackage = crypto.sealAccountPackage(current['encryption_public_key'] as String, {
      'signingPublicKey': credentials['accountSigningPublicKey'], 'signingPrivateKey': credentials['accountSigningPrivateKey'],
      'encryptionPublicKey': credentials['accountEncryptionPublicKey'], 'encryptionPrivateKey': credentials['accountEncryptionPrivateKey'], 'contentKey': credentials['contentKey']});
    if (!sessions.isCurrent(ref)) throw SessionChanged();
    await rpc.call('device/approve', {'deviceId': current['id'], 'keyPackage': keyPackage});
  });
  Future<void> revoke(SessionRef ref, String id) => _connection(ref, (rpc, credentials) async {
    if (id == credentials['deviceId']) throw StateError('不能在此撤销正在使用的设备');
    await rpc.call('device/revoke', {'deviceId': id});
  });
  Future<Map<String, dynamic>> inspectHost(SessionRef ref, HostPairingCode code) => _connection(ref, (rpc, credentials) async {
    if (code.endpoint != (credentials['endpoint'] as String).replaceFirst(RegExp(r'/+$'), '')) throw StateError('配对码的服务器与当前账号不同');
    final value = await rpc.call('host/enroll/inspect', {'enrollmentId': code.enrollmentId, 'secret': code.secret});
    if (value is! Map<String, dynamic> || value['requested_name'] is! String || value['signing_public_key'] is! String || value['encryption_public_key'] is! String ||
        (value['approved_account_id'] != null && value['approved_account_id'] != credentials['accountId'])) {
      throw const FormatException('电脑配对资料无效');
    }
    return value;
  }, read: true);
  Future<void> approveHost(SessionRef ref, HostPairingCode code, Map<String, dynamic> selected, String name) => _connection(ref, (rpc, credentials) async {
    if (code.endpoint != (credentials['endpoint'] as String).replaceFirst(RegExp(r'/+$'), '')) throw StateError('服务器不匹配');
    final current = await rpc.call('host/enroll/inspect', {'enrollmentId': code.enrollmentId, 'secret': code.secret});
    if (current is! Map || ['signing_public_key', 'encryption_public_key', 'requested_name', 'expires_at'].any((key) => current[key] != selected[key]) ||
        current['approved_account_id'] != null) {
      throw StateError('配对码已变化、已批准或已过期，请重新查询');
    }
    final keyPackage = crypto.sealHostContentKey(current['encryption_public_key'] as String, credentials['contentKey'] as String);
    if (!sessions.isCurrent(ref)) throw SessionChanged();
    await rpc.call('host/enroll/approve', {'enrollmentId': code.enrollmentId, 'secret': code.secret, 'name': name, 'keyPackage': keyPackage});
  });
}
