import 'dart:convert';
import 'dart:typed_data';
import 'package:sodium/sodium_sumo.dart';
import 'relay_encoding.dart';

String _encode(List<int> value) => base64Url.encode(value).replaceAll('=', '');
Uint8List _decode(String value) {
  if (!RegExp(r'^[A-Za-z0-9_-]+$').hasMatch(value) || value.length % 4 == 1) {
    throw const FormatException('密钥编码无效');
  }
  final result = Uint8List.fromList(base64Url.decode(base64Url.normalize(value)));
  if (_encode(result) != value) throw const FormatException('密钥编码不规范');
  return result;
}

class DeviceKeys {
  const DeviceKeys({required this.signingPublicKey, required this.signingPrivateKey,
    required this.encryptionPublicKey, required this.encryptionPrivateKey});
  final String signingPublicKey;
  final String signingPrivateKey;
  final String encryptionPublicKey;
  final String encryptionPrivateKey;
}

/// Account encryption matches the installed Android and Host protocol.
/// Callers own persistence and must keep existing device keys on re-login.
class RelayAccountCrypto {
  const RelayAccountCrypto(this.sodium);
  final SodiumSumo sodium;

  DeviceKeys generateDevice() {
    final signing = sodium.crypto.sign.keyPair();
    KeyPair? encryption;
    Uint8List? signSecret;
    Uint8List? boxSecret;
    try {
      encryption = sodium.crypto.box.keyPair();
      signSecret = signing.secretKey.extractBytes();
      boxSecret = encryption.secretKey.extractBytes();
      return DeviceKeys(signingPublicKey: _encode(signing.publicKey), signingPrivateKey: _encode(signSecret),
        encryptionPublicKey: _encode(encryption.publicKey), encryptionPrivateKey: _encode(boxSecret));
    } finally {
      signSecret?.fillRange(0, signSecret.length, 0);
      boxSecret?.fillRange(0, boxSecret.length, 0);
      signing.dispose(); encryption?.dispose();
    }
  }

  /// Creates the initial account package only when activating a new account.
  Map<String, dynamic> createRegistration(String recoveryPublicKey, {DeviceKeys? existingDevice}) {
    final signing = sodium.crypto.sign.keyPair();
    KeyPair? encryption;
    SecureKey? contentKey;
    Uint8List? signingBytes;
    Uint8List? encryptionBytes;
    Uint8List? contentBytes;
    try {
      encryption = sodium.crypto.box.keyPair();
      contentKey = sodium.crypto.aeadXChaCha20Poly1305IETF.keygen();
      final device = existingDevice ?? generateDevice();
      signingBytes = signing.secretKey.extractBytes();
      encryptionBytes = encryption.secretKey.extractBytes();
      contentBytes = contentKey.extractBytes();
      final account = <String, dynamic>{
        'signingPublicKey': _encode(signing.publicKey), 'signingPrivateKey': _encode(signingBytes),
        'encryptionPublicKey': _encode(encryption.publicKey), 'encryptionPrivateKey': _encode(encryptionBytes),
        'contentKey': _encode(contentBytes),
      };
      return {'account': account, 'device': device,
        'escrowCiphertext': sealAccountPackage(recoveryPublicKey, account),
        'keyPackage': sealAccountPackage(device.encryptionPublicKey, account)};
    } finally {
      signingBytes?.fillRange(0, signingBytes.length, 0);
      encryptionBytes?.fillRange(0, encryptionBytes.length, 0);
      contentBytes?.fillRange(0, contentBytes.length, 0);
      signing.dispose(); encryption?.dispose(); contentKey?.dispose();
    }
  }

  String deviceRecoveryProof(DeviceKeys device, String username, int issuedAt) {
    final bytes = _decode(device.signingPrivateKey);
    final secret = SecureKey.fromList(sodium, bytes);
    try {
      return _encode(sodium.crypto.sign.detached(message: Uint8List.fromList(utf8.encode(jsonEncode([
        'agent-pocket-device-login-recovery-v1', username, device.signingPublicKey, device.encryptionPublicKey, issuedAt]))), secretKey: secret));
    } finally { bytes.fillRange(0, bytes.length, 0); secret.dispose(); }
  }

  String sealHostContentKey(String hostEncryptionPublicKey, String contentKey) {
    // Validate before transmitting; the account content key is always 32 bytes.
    final content = _decode(contentKey);
    try {
      if (content.length != sodium.crypto.aeadXChaCha20Poly1305IETF.keyBytes) throw const FormatException('内容密钥无效');
      final payload = Uint8List.fromList(utf8.encode(jsonEncode({'version': 1, 'contentKey': contentKey})));
      try { return _encode(sodium.crypto.box.seal(message: payload, publicKey: _decode(hostEncryptionPublicKey))); }
      finally { payload.fillRange(0, payload.length, 0); }
    } finally { content.fillRange(0, content.length, 0); }
  }

  Map<String, dynamic> openAccountPackage(String package, DeviceKeys device,
      {String? expectedSigningPublicKey, String? expectedEncryptionPublicKey}) {
    final secretBytes = _decode(device.encryptionPrivateKey);
    final secret = SecureKey.fromList(sodium, secretBytes);
    secretBytes.fillRange(0, secretBytes.length, 0);
    Uint8List? plaintext;
    try {
      plaintext = sodium.crypto.box.sealOpen(cipherText: _decode(package),
          publicKey: _decode(device.encryptionPublicKey), secretKey: secret);
      final decoded = jsonDecode(utf8.decode(plaintext));
      if (decoded is! Map<String, dynamic> || decoded['version'] != 1) throw const FormatException('账户密钥包格式无效');
      for (final key in ['signingPublicKey', 'signingPrivateKey', 'encryptionPublicKey', 'encryptionPrivateKey', 'contentKey']) {
        if (decoded[key] is! String || (decoded[key] as String).isEmpty) throw const FormatException('账户密钥包不完整');
      }
      if ((expectedSigningPublicKey != null && decoded['signingPublicKey'] != expectedSigningPublicKey) ||
          (expectedEncryptionPublicKey != null && decoded['encryptionPublicKey'] != expectedEncryptionPublicKey)) {
        throw const FormatException('账户密钥包与当前账户不匹配');
      }
      _verifyAccountKeys(decoded);
      return decoded;
    } finally {
      plaintext?.fillRange(0, plaintext.length, 0);
      secret.dispose();
    }
  }

  void _verifyAccountKeys(Map<String, dynamic> account) {
    Uint8List? signingBytes;
    Uint8List? encryptionBytes;
    Uint8List? contentBytes;
    SecureKey? signKey;
    SecureKey? boxKey;
    try {
      signingBytes = _decode(account['signingPrivateKey'] as String);
      encryptionBytes = _decode(account['encryptionPrivateKey'] as String);
      contentBytes = _decode(account['contentKey'] as String);
      final signPublic = _decode(account['signingPublicKey'] as String);
      final boxPublic = _decode(account['encryptionPublicKey'] as String);
      if (signingBytes.length != sodium.crypto.sign.secretKeyBytes || signPublic.length != sodium.crypto.sign.publicKeyBytes ||
          encryptionBytes.length != sodium.crypto.box.secretKeyBytes || boxPublic.length != sodium.crypto.box.publicKeyBytes ||
          contentBytes.length != sodium.crypto.aeadXChaCha20Poly1305IETF.keyBytes) {
        throw const FormatException('账户密钥长度无效');
      }
      signKey = SecureKey.fromList(sodium, signingBytes);
      boxKey = SecureKey.fromList(sodium, encryptionBytes);
      final challenge = Uint8List.fromList(utf8.encode('agent-pocket-account-key-check-v1'));
      final signature = sodium.crypto.sign.detached(message: challenge, secretKey: signKey);
      if (!sodium.crypto.sign.verifyDetached(message: challenge, signature: signature, publicKey: signPublic) ||
          _encode(sodium.crypto.scalarmult.base(n: boxKey)) != _encode(boxPublic)) {
        throw const FormatException('账户公私钥不匹配');
      }
    } finally {
      signingBytes?.fillRange(0, signingBytes.length, 0);
      encryptionBytes?.fillRange(0, encryptionBytes.length, 0);
      contentBytes?.fillRange(0, contentBytes.length, 0);
      signKey?.dispose(); boxKey?.dispose();
    }
  }

  String sealAccountPackage(String deviceEncryptionPublicKey, Map<String, dynamic> account) {
    final payload = <String, dynamic>{'version': 1};
    for (final key in ['signingPublicKey', 'signingPrivateKey', 'encryptionPublicKey', 'encryptionPrivateKey', 'contentKey']) {
      final value = account[key];
      if (value is! String || value.isEmpty) throw const FormatException('账户密钥不完整');
      payload[key] = value;
    }
    final plain = Uint8List.fromList(utf8.encode(jsonEncode(payload)));
    try { return _encode(sodium.crypto.box.seal(message: plain, publicKey: _decode(deviceEncryptionPublicKey))); }
    finally { plain.fillRange(0, plain.length, 0); }
  }

  String decryptAccountEnvelope(Map<String, dynamic> envelope, String contentKey) {
    final encoded = envelope['ciphertext'];
    if (encoded is! String) throw const FormatException('加密消息无效');
    final data = _decode(encoded);
    final aead = sodium.crypto.aeadXChaCha20Poly1305IETF;
    if (data.length < aead.nonceBytes + aead.aBytes) throw const FormatException('加密消息过短');
    final bytes = _decode(contentKey);
    final key = SecureKey.fromList(sodium, bytes);
    bytes.fillRange(0, bytes.length, 0);
    Uint8List? plaintext;
    try {
      plaintext = aead.decrypt(cipherText: Uint8List.sublistView(data, aead.nonceBytes),
        nonce: Uint8List.sublistView(data, 0, aead.nonceBytes), key: key, additionalData: relayAad(envelope));
      return utf8.decode(plaintext);
    } finally {
      plaintext?.fillRange(0, plaintext.length, 0);
      key.dispose();
    }
  }
}
