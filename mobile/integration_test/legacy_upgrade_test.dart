import 'dart:convert';
import 'package:app/session/android_credential_store.dart';
import 'package:app/protocol/relay_account_crypto.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:sodium/sodium_sumo.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  test('legacy package upgrade retains the same device, key material, cursor, pairing and settings', () async {
    final data = await AndroidCredentialStore().load();
    expect(data?['accountId'], 'migration-fixture-account'); expect(data?['deviceId'], 'migration-fixture-device');
    expect(data?['accessToken'], 'fixture-access'); expect(data?['refreshToken'], 'fixture-refresh');
    expect(data?['deviceStatus'], 'approved'); expect(data?['requiresLogin'], false);
    expect((await AndroidCredentialStore.readPendingHost())?['enrollmentId'], 'migration-fixture-enrollment');
    expect(await const MethodChannel('agent_pocket/cursors').invokeMethod<int>('read', {'hostId': 'migration-fixture-host'}), 7429);
    expect(await const MethodChannel('agent_pocket/appearance').invokeMethod<String>('read'), 'pixel');
    expect((await const MethodChannel('agent_pocket/settings').invokeMapMethod<String, dynamic>('read'))?['notifications'], false);
    final installation = await const MethodChannel('agent_pocket/credential_store').invokeMethod<String>('installationId');
    expect(installation, matches(RegExp(r'^[a-f0-9-]{36}$')));
    final sodium = await SodiumSumoInit.init(), crypto = RelayAccountCrypto(await SodiumSumoInit.init());
    final keys = DeviceKeys(signingPublicKey: data!['deviceSigningPublicKey'] as String, signingPrivateKey: data['deviceSigningPrivateKey'] as String,
      encryptionPublicKey: data['deviceEncryptionPublicKey'] as String, encryptionPrivateKey: data['deviceEncryptionPrivateKey'] as String);
    final package = crypto.sealAccountPackage(keys.encryptionPublicKey, {'signingPublicKey': data['accountSigningPublicKey'], 'signingPrivateKey': data['accountSigningPrivateKey'],
      'encryptionPublicKey': data['accountEncryptionPublicKey'], 'encryptionPrivateKey': data['accountEncryptionPrivateKey'], 'contentKey': data['contentKey']});
    final opened = crypto.openAccountPackage(package, keys, expectedSigningPublicKey: data['accountSigningPublicKey'] as String,
      expectedEncryptionPublicKey: data['accountEncryptionPublicKey'] as String);
    expect(opened['contentKey'], data['contentKey']); expect(base64Url.decode(base64Url.normalize(opened['contentKey'] as String)).length, sodium.crypto.aeadXChaCha20Poly1305IETF.keyBytes);
  });
}
