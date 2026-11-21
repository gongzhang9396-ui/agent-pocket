import 'package:sodium/sodium_sumo.dart';

import '../protocol/relay_account_crypto.dart';
import 'existing_device_login.dart';
import 'pending_device_approval.dart';
import 'session_manager.dart';

/// Wires the device login to the same sealed account package used by Android.
ExistingDeviceLogin existingDeviceLogin(SodiumSumo sodium, SessionManager sessions) {
  return ExistingDeviceLogin(sessions, accountPackageOpener(sodium));
}

PendingDeviceApproval pendingDeviceApproval(SodiumSumo sodium, SessionManager sessions) {
  return PendingDeviceApproval(sessions, accountPackageOpener(sodium));
}

OpenAccountPackage accountPackageOpener(SodiumSumo sodium) {
  final crypto = RelayAccountCrypto(sodium);
  return (package, device, accountSigning, accountEncryption) {
    final keys = DeviceKeys(
      signingPublicKey: device['deviceSigningPublicKey'] as String,
      signingPrivateKey: device['deviceSigningPrivateKey'] as String,
      encryptionPublicKey: device['deviceEncryptionPublicKey'] as String,
      encryptionPrivateKey: device['deviceEncryptionPrivateKey'] as String,
    );
    return crypto.openAccountPackage(package, keys,
      expectedSigningPublicKey: accountSigning, expectedEncryptionPublicKey: accountEncryption);
  };
}
