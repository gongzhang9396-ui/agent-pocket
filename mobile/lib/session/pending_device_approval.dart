import 'dart:convert';
import 'dart:io';
import 'existing_device_login.dart';
import 'session_manager.dart';

typedef DeviceStatusRequest = Future<Map<String, dynamic>> Function(Uri uri, String token);

/// One polling step for an already-persisted pending device. This cannot
/// approve a device; it only consumes a package approved elsewhere.
class PendingDeviceApproval {
  PendingDeviceApproval(this.sessions, this.openPackage, {DeviceStatusRequest? request})
      : _request = request ?? _get;
  final SessionManager sessions;
  final OpenAccountPackage openPackage;
  final DeviceStatusRequest _request;

  Future<bool> poll(SessionRef ref) async {
    final response = await sessions.read(ref, (credentials) async {
      if (credentials['deviceStatus'] != 'pending') throw StateError('设备不在待批准状态');
      final endpoint = Uri.tryParse(credentials['endpoint'] as String? ?? '');
      if (endpoint == null || endpoint.scheme != 'https' || endpoint.host.isEmpty || endpoint.userInfo.isNotEmpty ||
          endpoint.hasQuery || endpoint.hasFragment) { throw const FormatException('服务器地址无效'); }
      final token = credentials['accessToken'];
      if (token is! String || token.isEmpty) throw SignInRequired();
      final uri = Uri.parse('${endpoint.toString().replaceFirst(RegExp(r'/+$'), '')}/api/device/status');
      final result = await _request(uri, token);
      final account = result['account'];
      final device = result['device'];
      if (account is! Map || device is! Map || account['id'] != credentials['accountId'] ||
          device['id'] != credentials['deviceId'] || account['signingPublicKey'] != credentials['accountSigningPublicKey'] ||
          account['encryptionPublicKey'] != credentials['accountEncryptionPublicKey']) {
        throw const FormatException('设备状态与原有身份不匹配');
      }
      final status = device['status'];
      if (status == 'pending') return <String, dynamic>{'approved': false};
      if (status != 'approved' || device['keyPackage'] is! String || (device['keyPackage'] as String).isEmpty) {
        throw const FormatException('设备批准结果无效');
      }
      final sign = credentials['accountSigningPublicKey'];
      final encryption = credentials['accountEncryptionPublicKey'];
      if (sign is! String || encryption is! String) throw const FormatException('账户公钥缺失');
      final secret = openPackage(device['keyPackage'] as String, credentials, sign, encryption);
      return <String, dynamic>{'approved': true, 'secret': secret};
    });
    if (response['approved'] != true) return false;
    final secret = response['secret'] as Map<String, dynamic>;
    await sessions.markApproved(ref, {'accountSigningPrivateKey': secret['signingPrivateKey'],
      'accountEncryptionPrivateKey': secret['encryptionPrivateKey'], 'contentKey': secret['contentKey']});
    return true;
  }

  static Future<Map<String, dynamic>> _get(Uri uri, String token) async {
    final client = HttpClient()..connectionTimeout = const Duration(seconds: 20);
    try {
      return await (() async {
        final request = await client.getUrl(uri);
        request.followRedirects = false;
        request.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
        final response = await request.close();
        if (response.statusCode == HttpStatus.unauthorized) throw AccessRejected();
        if (response.statusCode != HttpStatus.ok) throw HttpException('设备状态读取失败 (${response.statusCode})');
        final bytes = <int>[];
        await for (final chunk in response) {
          if (bytes.length + chunk.length > 256 * 1024) throw const FormatException('设备状态响应过大');
          bytes.addAll(chunk);
        }
        final decoded = jsonDecode(utf8.decode(bytes));
        if (decoded is! Map<String, dynamic>) throw const FormatException('设备状态格式无效');
        return decoded;
      })().timeout(const Duration(seconds: 30));
    } finally { client.close(force: true); }
  }
}
