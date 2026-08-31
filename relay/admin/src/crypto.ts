import sodium from "libsodium-wrappers-sumo";

const b64 = (value: Uint8Array) => sodium.to_base64(value, sodium.base64_variants.URLSAFE_NO_PADDING);

export type BootstrapCrypto = {
  request: {
    accountSigningPublicKey: string;
    accountEncryptionPublicKey: string;
    deviceSigningPublicKey: string;
    deviceEncryptionPublicKey: string;
    recoveryPublicKey: string;
    escrowCiphertext: string;
    keyPackage: string;
  };
  privateMaterial: Record<string, string | number>;
};

export async function createBootstrapCrypto(recoveryPassphrase: string): Promise<BootstrapCrypto> {
  await sodium.ready;
  const accountSigning = sodium.crypto_sign_keypair();
  const accountEncryption = sodium.crypto_box_keypair();
  const deviceSigning = sodium.crypto_sign_keypair();
  const deviceEncryption = sodium.crypto_box_keypair();
  const recovery = sodium.crypto_box_keypair();
  const contentKey = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
  const accountPackage = sodium.from_string(JSON.stringify({
    version: 1,
    signingPublicKey: b64(accountSigning.publicKey),
    signingPrivateKey: b64(accountSigning.privateKey),
    encryptionPublicKey: b64(accountEncryption.publicKey),
    encryptionPrivateKey: b64(accountEncryption.privateKey),
    contentKey: b64(contentKey),
  }));
  const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const recoveryKey = sodium.crypto_pwhash(
    sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES,
    recoveryPassphrase,
    salt,
    sodium.crypto_pwhash_OPSLIMIT_MODERATE,
    sodium.crypto_pwhash_MEMLIMIT_MODERATE,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
  const privatePayload = sodium.from_string(JSON.stringify({
    version: 1,
    recoveryPrivateKey: b64(recovery.privateKey),
    accountSigningPrivateKey: b64(accountSigning.privateKey),
    accountEncryptionPrivateKey: b64(accountEncryption.privateKey),
    contentKey: b64(contentKey),
    deviceSigningPrivateKey: b64(deviceSigning.privateKey),
    deviceEncryptionPrivateKey: b64(deviceEncryption.privateKey),
  }));
  const encryptedPrivateMaterial = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    privatePayload,
    recovery.publicKey,
    null,
    nonce,
    recoveryKey,
  );
  sodium.memzero(recoveryKey);
  return {
    request: {
      accountSigningPublicKey: b64(accountSigning.publicKey),
      accountEncryptionPublicKey: b64(accountEncryption.publicKey),
      deviceSigningPublicKey: b64(deviceSigning.publicKey),
      deviceEncryptionPublicKey: b64(deviceEncryption.publicKey),
      recoveryPublicKey: b64(recovery.publicKey),
      escrowCiphertext: b64(sodium.crypto_box_seal(accountPackage, recovery.publicKey)),
      keyPackage: b64(sodium.crypto_box_seal(accountPackage, deviceEncryption.publicKey)),
    },
    privateMaterial: {
      version: 1,
      algorithm: "argon2id+xchacha20poly1305",
      publicKey: b64(recovery.publicKey),
      salt: b64(salt),
      nonce: b64(nonce),
      opsLimit: sodium.crypto_pwhash_OPSLIMIT_MODERATE,
      memLimit: sodium.crypto_pwhash_MEMLIMIT_MODERATE,
      ciphertext: b64(encryptedPrivateMaterial),
    },
  };
}

export function downloadRecoveryFile(material: Record<string, unknown>, accountId: string, deviceId: string) {
  const blob = new Blob([JSON.stringify({ ...material, accountId, deviceId }, null, 2)], { type: "application/json" });
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = `agent-pocket-recovery-${accountId}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}
