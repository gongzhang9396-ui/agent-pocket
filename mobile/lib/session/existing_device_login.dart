import 'dart:convert';
import 'dart:io';

import 'session_manager.dart';

typedef OpenAccountPackage = Map<String, dynamic> Function(
  String package, Map<String, dynamic> device, String accountSigningKey, String accountEncryptionKey);
typedef LoginRequest = Future<Map<String, dynamic>> Function(Uri uri, Map<String, dynamic> body);

/// Re-authenticates an already stored Android device. It never creates a
/// device, replaces its keys, or retries a request with an unknown result.
/// New-device enrollment is deliberately a separate, not-yet-implemented flow.
class ExistingDeviceLogin {
  ExistingDeviceLogin(this.sessions, this.openPackage, {LoginRequest? request, int Function()? now})
      : _request = request ?? RelayLoginHttp().call, _now = now ?? (() => DateTime.now().millisecondsSinceEpoch);
  final SessionManager sessions;
  final OpenAccountPackage openPackage;
  final LoginRequest _request;
  final int Function() _now;
  bool _running = false;

  static String _field(Map<String, dynamic> object, String key) {
    final value = object[key];
    if (value is! String || value.isEmpty) throw FormatException('缺少 $key');
    return value;
  }

  Future<Map<String, dynamic>> login(String password) async {
    if (_running) throw StateError('登录正在进行');
    if (password.isEmpty) throw const FormatException('请输入密码');
    _running = true;
    try {
      final generation = sessions.generation;
      // load() is intentionally allowed while the old access token is blocked:
      // the encrypted device identity must survive an expired session.
      final existing = await sessions.store.load();
      if (existing == null) throw StateError('没有可恢复的设备身份，需要使用新设备配对流程');
      if (sessions.generation != generation) throw SessionChanged();
      final endpoint = Uri.tryParse(_field(existing, 'endpoint'));
      if (endpoint == null || endpoint.scheme != 'https' || endpoint.host.isEmpty ||
          endpoint.userInfo.isNotEmpty || endpoint.hasQuery || endpoint.hasFragment) {
        throw const FormatException('原有服务器地址无效');
      }
      final deviceId = _field(existing, 'deviceId');
      final accountId = _field(existing, 'accountId');
      final username = _field(existing, 'username');
      final deviceName = _field(existing, 'deviceName');
      final signingKey = _field(existing, 'deviceSigningPublicKey');
      final encryptionKey = _field(existing, 'deviceEncryptionPublicKey');
      _field(existing, 'deviceSigningPrivateKey');
      _field(existing, 'deviceEncryptionPrivateKey');
      final accountSigning = _field(existing, 'accountSigningPublicKey');
      final accountEncryption = _field(existing, 'accountEncryptionPublicKey');
      final uri = Uri.parse('${endpoint.toString().replaceFirst(RegExp(r'/+$'), '')}/api/auth/login');
      final result = await _request(uri, {'username': username, 'password': password,
        'deviceId': deviceId, 'deviceName': deviceName,
        'deviceSigningPublicKey': signingKey, 'deviceEncryptionPublicKey': encryptionKey});
      final account = result['account'];
      final device = result['device'];
      final tokens = result['tokens'];
      if (account is! Map<String, dynamic> || device is! Map<String, dynamic> || tokens is! Map<String, dynamic> ||
          account['id'] != accountId || device['id'] != deviceId ||
          account['username'] is! String || (account['username'] as String).toLowerCase() != username.toLowerCase() ||
          account['signingPublicKey'] != accountSigning || account['encryptionPublicKey'] != accountEncryption) {
        throw const FormatException('登录返回的账户或设备身份不匹配');
      }
      final status = _field(device, 'status');
      if (status != 'approved' && status != 'pending') throw const FormatException('设备状态无效');
      final updates = <String, dynamic>{'deviceStatus': status, 'deviceName': _field(device, 'name')};
      for (final key in ['accessToken', 'refreshToken']) { updates[key] = _field(tokens, key); }
      for (final key in ['accessExpiresAt', 'refreshExpiresAt']) {
        final value = tokens[key];
        if (value is! int || value <= _now()) throw const FormatException('登录凭据期限无效');
        updates[key] = value;
      }
      final package = device['keyPackage'];
      if (package != null) {
        if (status != 'approved') throw const FormatException('待批准设备不应收到账户密钥包');
        if (package is! String || package.isEmpty) throw const FormatException('账户密钥包无效');
        final secret = openPackage(package, Map.unmodifiable(existing), accountSigning, accountEncryption);
        for (final entry in {'accountSigningPrivateKey': 'signingPrivateKey',
          'accountEncryptionPrivateKey': 'encryptionPrivateKey', 'contentKey': 'contentKey'}.entries) {
          updates[entry.key] = _field(secret, entry.value);
        }
      }
      final credentials = {...existing, ...updates};
      if (status == 'approved') {
        for (final key in ['accountSigningPrivateKey', 'accountEncryptionPrivateKey', 'contentKey']) {
          _field(credentials, key);
        }
      }
      await sessions.replace(generation, credentials);
      return Map.unmodifiable({...credentials, 'requiresLogin': false});
    } finally { _running = false; }
  }

}

class RelayLoginHttp {
  RelayLoginHttp({HttpClient Function()? clientFactory, this.timeout = const Duration(seconds: 30)})
      : _clientFactory = clientFactory ?? HttpClient.new;
  final HttpClient Function() _clientFactory;
  final Duration timeout;

  Future<Map<String, dynamic>> call(Uri uri, Map<String, dynamic> body) async {
    if (uri.scheme != 'https' || uri.host.isEmpty || uri.userInfo.isNotEmpty || uri.hasQuery || uri.hasFragment) {
      throw const FormatException('服务器地址无效');
    }
    final client = _clientFactory()..connectionTimeout = const Duration(seconds: 20);
    try {
      return await (() async {
        final request = await client.postUrl(uri);
        request.followRedirects = false;
        request.headers.contentType = ContentType.json;
        request.write(jsonEncode(body));
        final response = await request.close();
        if (response.statusCode != HttpStatus.ok) throw HttpException('登录失败 (${response.statusCode})');
        final bytes = <int>[];
        await for (final chunk in response) {
          if (bytes.length + chunk.length > 256 * 1024) throw const FormatException('登录响应过大');
          bytes.addAll(chunk);
        }
        final decoded = jsonDecode(utf8.decode(bytes));
        if (decoded is! Map<String, dynamic>) throw const FormatException('登录响应格式无效');
        return decoded;
      })().timeout(timeout);
    } finally { client.close(force: true); }
  }
}
