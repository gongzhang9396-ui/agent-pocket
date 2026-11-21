import '../protocol/relay_account_crypto.dart';
import 'relay_http.dart';
import 'session_manager.dart';

abstract interface class EnrollmentStore {
  Future<Map<String, dynamic>?> load();
  Future<void> save(Map<String, dynamic> provisional);
}
class DeviceEnrollment {
  DeviceEnrollment(this.crypto, this.sessions, this.store, this.http);
  final RelayAccountCrypto crypto;
  final SessionManager sessions;
  final EnrollmentStore store;
  final RelayHttp http;
  bool _busy = false;
  Future<void> login(String endpoint, String username, String password, String deviceName, {String? inviteId, String? inviteSecret, String? displayName}) async {
    if (_busy) throw StateError('登录正在进行');
    _busy = true;
    try {
      final generation = sessions.generation;
      if (await sessions.store.load() != null) throw StateError('已有设备身份，请使用重新登录，不要创建另一台设备');
      username = username.trim().toLowerCase(); endpoint = endpoint.replaceFirst(RegExp(r'/+$'), '');
      if (!RegExp(r'^[a-z0-9][a-z0-9._-]{2,31}$').hasMatch(username) || password.isEmpty || deviceName.isEmpty) throw const FormatException('请输入账号和密码');
      var draft = await store.load();
      if (draft != null && (draft['endpoint'] != endpoint || draft['username'] != username)) throw StateError('本机仍保存着另一账号的注册身份，请先完成原登录或恢复');
      if (draft == null) {
        final device = crypto.generateDevice();
        draft = {'endpoint': endpoint, 'username': username, 'deviceName': deviceName,
          'deviceSigningPublicKey': device.signingPublicKey, 'deviceSigningPrivateKey': device.signingPrivateKey,
          'deviceEncryptionPublicKey': device.encryptionPublicKey, 'deviceEncryptionPrivateKey': device.encryptionPrivateKey};
        await store.save(draft);
      }
      if (sessions.generation != generation) throw SessionChanged();
      final device = DeviceKeys(signingPublicKey: draft['deviceSigningPublicKey'] as String, signingPrivateKey: draft['deviceSigningPrivateKey'] as String,
        encryptionPublicKey: draft['deviceEncryptionPublicKey'] as String, encryptionPrivateKey: draft['deviceEncryptionPrivateKey'] as String);
      final config = await http.json(endpoint, '/api/public/config');
      if (config['deviceLoginRecovery'] != 1 && draft['attempted'] == true) throw StateError('上次登录结果未知；请先更新服务器以恢复原设备，不能重复注册');
      draft['attempted'] = true; await store.save(draft);
      final issuedAt = DateTime.now().millisecondsSinceEpoch;
      final body = {'username': username, 'password': password, 'deviceName': deviceName,
        'deviceSigningPublicKey': device.signingPublicKey, 'deviceEncryptionPublicKey': device.encryptionPublicKey,
        if (config['deviceLoginRecovery'] == 1) ...{'recoverDeviceKeys': true, 'deviceProofIssuedAt': issuedAt, 'deviceRecoveryProof': crypto.deviceRecoveryProof(device, username, issuedAt)}};
      Map<String, dynamic> result;
      try { result = await http.json(endpoint, '/api/auth/login', method: 'POST', body: body, stillCurrent: () => sessions.generation == generation); }
      on RelayApiException catch (error) {
        final useInvite = inviteId != null && inviteSecret != null && error.code == 'AUTH_FAILED';
        if (error.code != 'ACCOUNT_ACTIVATION_REQUIRED' && !useInvite) {
          if ({'AUTH_FAILED', 'RATE_LIMITED', 'FORBIDDEN', 'INVALID_REQUEST'}.contains(error.code)) { draft['attempted'] = false; await store.save(draft); }
          rethrow;
        }
        if (draft['registration'] == null) {
          final registration = crypto.createRegistration(config['recoveryPublicKey'] as String, existingDevice: device);
          registration.remove('device'); draft['registration'] = registration; await store.save(draft);
        }
        final registration = draft['registration'] as Map;
        final account = registration['account'] as Map;
        draft['attempted'] = true; await store.save(draft);
        result = await http.json(endpoint, useInvite ? '/api/invites/claim' : '/api/auth/activate', method: 'POST', body: {...body,
          if (useInvite) ...{'inviteId': inviteId, 'secret': inviteSecret, 'displayName': displayName?.trim().isNotEmpty == true ? displayName : username},
          'accountSigningPublicKey': account['signingPublicKey'], 'accountEncryptionPublicKey': account['encryptionPublicKey'],
          'escrowCiphertext': registration['escrowCiphertext'], 'keyPackage': registration['keyPackage']}, stillCurrent: () => sessions.generation == generation);
      }
      final account = result['account'], returnedDevice = result['device'], tokens = result['tokens'];
      if (account is! Map || returnedDevice is! Map || tokens is! Map || account['username'] != username ||
          account['id'] is! String || returnedDevice['id'] is! String || !{'approved', 'pending'}.contains(returnedDevice['status']) ||
          account['signingPublicKey'] is! String || account['encryptionPublicKey'] is! String) {
        throw const FormatException('登录返回身份不完整');
      }
      final registration = draft['registration'];
      if (registration is Map && (registration['account'] is! Map || registration['account']['signingPublicKey'] != account['signingPublicKey'] ||
          registration['account']['encryptionPublicKey'] != account['encryptionPublicKey'])) {
        throw const FormatException('激活账户密钥不匹配，请保留本机身份');
      }
      final credentials = {...draft, 'accountId': account['id'], 'deviceId': returnedDevice['id'], 'deviceStatus': returnedDevice['status'],
        'accountSigningPublicKey': account['signingPublicKey'], 'accountEncryptionPublicKey': account['encryptionPublicKey']};
      credentials.remove('registration'); credentials.remove('attempted');
      for (final key in ['accessToken', 'refreshToken']) { if (tokens[key] is! String || (tokens[key] as String).isEmpty) throw const FormatException('登录凭据缺失'); credentials[key] = tokens[key]; }
      for (final key in ['accessExpiresAt', 'refreshExpiresAt']) { if (tokens[key] is! int || (tokens[key] as int) <= DateTime.now().millisecondsSinceEpoch) throw const FormatException('登录期限无效'); credentials[key] = tokens[key]; }
      if (returnedDevice['status'] == 'approved') {
        final package = returnedDevice['keyPackage'];
        if (package is! String) throw const FormatException('缺少设备账户密钥包');
        final secrets = crypto.openAccountPackage(package, device, expectedSigningPublicKey: account['signingPublicKey'] as String,
          expectedEncryptionPublicKey: account['encryptionPublicKey'] as String);
        credentials.addAll({'accountSigningPrivateKey': secrets['signingPrivateKey'], 'accountEncryptionPrivateKey': secrets['encryptionPrivateKey'], 'contentKey': secrets['contentKey']});
      }
      await sessions.replace(generation, credentials); await store.save({});
    } finally { _busy = false; }
  }
}
