import 'dart:convert';
import 'dart:typed_data';
import 'package:app/protocol/relay_account_crypto.dart';
import 'package:app/protocol/relay_encoding.dart';
import 'package:app/session/existing_device_login.dart';
import 'package:app/session/pending_device_approval.dart';
import 'package:app/session/session_manager.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:sodium/sodium_sumo.dart';

Uint8List bytes(String value) => Uint8List.fromList(base64Url.decode(base64Url.normalize(value)));
String encoded(List<int> value) => base64Url.encode(value).replaceAll('=', '');

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  late SodiumSumo sodium;
  setUpAll(() async { sodium = await SodiumSumoInit.init(); });
  const metadata = <String, dynamic>{
    'accountId': '00000000-0000-4000-8000-000000000001',
    'hostId': '00000000-0000-4000-8000-000000000002',
    'deviceId': '00000000-0000-4000-8000-000000000003',
    'channelId': '00000000-0000-4000-8000-000000000004',
    'counter': 7, 'kind': 'event.append', 'eventId': 'evt-fixed-1', 'eventType': 'completed',
  };

  test('account envelope matches Node and Kotlin vector', () {
    const key = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
    final nonce = bytes('ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3');
    final cipher = bytes('Zns5sgtSNrEayiXPJmlypVwhpE_9vyTGlQAoXHwb0CBSLk0yrYZSazaGSJxqqZFyJq-cS8dT4QdmdpY');
    final envelope = {...metadata, 'ciphertext': encoded([...nonce, ...cipher])};
    final crypto = RelayAccountCrypto(sodium);
    expect(crypto.decryptAccountEnvelope(envelope, key), '{"type":"turn.status","status":"completed"}');
    expect(() => crypto.decryptAccountEnvelope({...envelope, 'counter': 8}, key), throwsA(anything));
  });

  test('sealed box and signature match Node and Kotlin vectors', () {
    final secret = SecureKey.fromList(sodium, bytes('P678W9-e3uDVqcXBRBPsFEYWKwx-pC0lvjTmXaeZKuI'));
    try {
      final plain = sodium.crypto.box.sealOpen(
        cipherText: bytes('8Xcf6O4t5HGIejWlQHrKAi-aXUX-BQTa7G46Uzxm3CHcxmJMvicLzCKnZSrudt2zA_ffSVtTGMYCIplJ7MxBbisg86eBbTQcW-I'),
        publicKey: bytes('kjdZZ00a9DxSLojIyhEb6L0CmMwXB0KKjN49XVtODFo'), secretKey: secret);
      expect(encoded(plain), 'c2VhbGVkIGFjY291bnQga2V5IHBhY2thZ2U');
      const handshake = <String, dynamic>{
        'version': 2, 'accountId': '00000000-0000-4000-8000-000000000001',
        'hostId': '00000000-0000-4000-8000-000000000002', 'deviceId': '00000000-0000-4000-8000-000000000003',
        'channelId': '00000000-0000-4000-8000-000000000004', 'issuedAt': 1700000000000,
        'ephemeralPublicKey': 'B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9_AsrhtHHw',
        'secretstreamHeader': 'oaKjpKWmp6ipqqusra6vsLGys7S1tre4',
      };
      expect(sodium.crypto.sign.verifyDetached(message: handshakeBytes(handshake),
        signature: bytes('ciSGzGpwWyJpbPbWWBIu2usNX3b66JoUvTScWE6lAyWdLPcpCKnLbIGE9i3JT2p728h-lUUL-Fb3r3itmp2xAg'),
        publicKey: bytes('rcFAEfgtHFbZVqpPnXPYhYNhpgYEhSXg0Ixjjcdd2Mc')), isTrue);
    } finally { secret.dispose(); }
  });

  test('secretstream consumes the existing protocol vector', () async {
    final key = SecureKey.fromList(sodium, bytes('gYKDhIWGh4iJiouMjY6PkJGSk5SVlpeYmZqbnJ2en6A'));
    try {
      final messages = Stream<SecretStreamCipherMessage>.fromIterable([
        SecretStreamCipherMessage(bytes('PlQ7KEtfFz1GloCdYn9WMF5zQ9hSNF47')),
        SecretStreamCipherMessage(bytes('snDgJvRq5-Ye26gBzVNrbM0bgpvXEOafzSK0pVy50c8Ze9MHPwWecmrvgQ'), additionalData: relayAad(metadata)),
      ]).transform(sodium.crypto.secretStream.createPullEx(key, requireFinalized: false));
      final plain = await messages.toList();
      expect(plain.single.tag, SecretStreamMessageTag.message);
      expect(utf8.decode(plain.single.message), 'fixed secretstream payload');
    } finally { key.dispose(); }
  });

  test('generated account package can only be opened for its own device', () {
    final crypto = RelayAccountCrypto(sodium);
    final recovery = sodium.crypto.box.keyPair();
    try {
      final registration = crypto.createRegistration(encoded(recovery.publicKey));
      final account = registration['account'] as Map<String, dynamic>;
      final device = registration['device'] as DeviceKeys;
      final package = registration['keyPackage'] as String;
      final opened = crypto.openAccountPackage(package, device,
        expectedSigningPublicKey: account['signingPublicKey'] as String,
        expectedEncryptionPublicKey: account['encryptionPublicKey'] as String);
      expect(opened['contentKey'], account['contentKey']);
      expect(() => crypto.openAccountPackage(package, crypto.generateDevice()), throwsA(anything));
      expect(() => crypto.openAccountPackage(package, device, expectedSigningPublicKey: 'wrong'), throwsFormatException);
      final other = (crypto.createRegistration(encoded(recovery.publicKey))['account'] as Map<String, dynamic>);
      for (final key in ['signingPrivateKey', 'encryptionPrivateKey']) {
        final inconsistent = crypto.sealAccountPackage(device.encryptionPublicKey, {...account, key: other[key]});
        expect(() => crypto.openAccountPackage(inconsistent, device), throwsFormatException);
      }
      final shortContent = crypto.sealAccountPackage(device.encryptionPublicKey, {...account, 'contentKey': encoded(List.filled(31, 0))});
      expect(() => crypto.openAccountPackage(shortContent, device), throwsFormatException);
    } finally { recovery.dispose(); }
  });

  test('existing device login opens its real sodium account package', () async {
    final crypto = RelayAccountCrypto(sodium);
    final recovery = sodium.crypto.box.keyPair();
    try {
      final registration = crypto.createRegistration(encoded(recovery.publicKey));
      final account = registration['account'] as Map<String, dynamic>;
      final device = registration['device'] as DeviceKeys;
      final store = _MemoryStore({
        'endpoint': 'https://example.invalid', 'accountId': 'account', 'username': 'admin',
        'deviceId': 'device', 'deviceName': 'phone', 'deviceStatus': 'pending',
        'deviceSigningPublicKey': device.signingPublicKey, 'deviceSigningPrivateKey': device.signingPrivateKey,
        'deviceEncryptionPublicKey': device.encryptionPublicKey, 'deviceEncryptionPrivateKey': device.encryptionPrivateKey,
        'accountSigningPublicKey': account['signingPublicKey'], 'accountEncryptionPublicKey': account['encryptionPublicKey'],
      });
      final sessions = SessionManager(store, (_) async => {});
      final pendingStore = _MemoryStore({...store.value!, 'accessToken': 'old', 'refreshToken': 'old-refresh',
        'accessExpiresAt': 100000, 'refreshExpiresAt': 200000});
      final pendingSessions = SessionManager(pendingStore, (_) async => {}, now: () => 500);
      final pendingRef = await pendingSessions.snapshot(approvedOnly: false);
      final poller = PendingDeviceApproval(pendingSessions, (package, _, signing, encryption) =>
        crypto.openAccountPackage(package, device, expectedSigningPublicKey: signing, expectedEncryptionPublicKey: encryption),
        request: (_, _) async => {
          'account': {'id': 'account', 'signingPublicKey': account['signingPublicKey'],
            'encryptionPublicKey': account['encryptionPublicKey']},
          'device': {'id': 'device', 'status': 'approved', 'keyPackage': registration['keyPackage']},
        });
      expect(await poller.poll(pendingRef), isTrue);
      expect(pendingStore.value!['contentKey'], account['contentKey']);
      final login = ExistingDeviceLogin(sessions, (package, _, signing, encryption) =>
        crypto.openAccountPackage(package, device, expectedSigningPublicKey: signing, expectedEncryptionPublicKey: encryption),
        now: () => 500, request: (_, body) async => {
          'account': {'id': 'account', 'username': 'admin', 'signingPublicKey': account['signingPublicKey'],
            'encryptionPublicKey': account['encryptionPublicKey']},
          'device': {'id': body['deviceId'], 'name': 'phone', 'status': 'approved', 'keyPackage': registration['keyPackage']},
          'tokens': {'accessToken': 'access', 'refreshToken': 'refresh', 'accessExpiresAt': 1000, 'refreshExpiresAt': 2000},
        });
      final result = await login.login('test-password');
      expect(result['contentKey'], account['contentKey']);
      expect(store.value!['deviceId'], 'device');
      expect((await sessions.snapshot()).credentials['deviceStatus'], 'approved');
    } finally { recovery.dispose(); }
  });
}

class _MemoryStore implements CredentialStore {
  _MemoryStore(this.value);
  Map<String, dynamic>? value;
  bool blocked = false;
  @override Future<Map<String, dynamic>?> load() async => value == null ? null : {...value!};
  @override Future<bool> isBlocked() async => blocked;
  @override Future<void> block() async { blocked = true; }
  @override Future<void> save(Map<String, dynamic> credentials) async { value = {...credentials}; blocked = false; }
  @override Future<void> clearCredentials() async { value = null; blocked = true; }
}
