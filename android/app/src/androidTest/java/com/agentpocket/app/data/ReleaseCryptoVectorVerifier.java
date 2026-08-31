package com.agentpocket.app.data;

import android.content.Context;
import android.util.Base64;
import com.goterl.lazysodium.LazySodiumAndroid;
import com.goterl.lazysodium.SodiumAndroid;
import com.goterl.lazysodium.interfaces.AEAD;
import com.goterl.lazysodium.interfaces.Box;
import com.goterl.lazysodium.interfaces.SecretStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import org.json.JSONArray;
import org.json.JSONObject;

final class ReleaseCryptoVectorVerifier {
    private ReleaseCryptoVectorVerifier() {}

    static void verify(Context context, LazySodiumAndroid sodium) throws Exception {
        SodiumAndroid nativeSodium = new SodiumAndroid();
        JSONObject vector = new JSONObject(readAsset(context, "crypto-vectors.json"));

        byte[] aad = canonicalAad(vector.getJSONObject("metadata"));
        assertEquals("AAD", vector.getString("aad"), b64(aad));

        JSONObject aead = vector.getJSONObject("aead");
        byte[] message = unb64(aead.getString("message"));
        byte[] ciphertext = new byte[message.length + AEAD.XCHACHA20POLY1305_IETF_ABYTES];
        long[] ciphertextLength = new long[1];
        assertTrue(
                "XChaCha20-Poly1305 encryption",
                sodium.cryptoAeadXChaCha20Poly1305IetfEncrypt(
                        ciphertext,
                        ciphertextLength,
                        message,
                        message.length,
                        aad,
                        aad.length,
                        null,
                        unb64(aead.getString("nonce")),
                        unb64(aead.getString("key"))));
        assertEquals("XChaCha20-Poly1305 ciphertext", aead.getString("ciphertext"), b64(exact(ciphertext, ciphertextLength[0])));

        JSONObject x25519 = vector.getJSONObject("x25519");
        byte[] publicA = new byte[32];
        byte[] publicB = new byte[32];
        assertEquals("X25519 public A status", 0, nativeSodium.crypto_scalarmult_base(publicA, unb64(x25519.getString("privateA"))));
        assertEquals("X25519 public B status", 0, nativeSodium.crypto_scalarmult_base(publicB, unb64(x25519.getString("privateB"))));
        assertEquals("X25519 public A", x25519.getString("publicA"), b64(publicA));
        assertEquals("X25519 public B", x25519.getString("publicB"), b64(publicB));
        byte[] shared = new byte[32];
        assertEquals("X25519 shared status", 0, nativeSodium.crypto_scalarmult(shared, unb64(x25519.getString("privateA")), publicB));
        assertEquals("X25519 shared secret", x25519.getString("shared"), b64(shared));
        byte[] direction = x25519.getString("direction").getBytes(StandardCharsets.UTF_8);
        byte[] transcript = unb64(x25519.getString("transcript"));
        byte[] deriveInput = new byte[transcript.length + 1 + direction.length];
        System.arraycopy(transcript, 0, deriveInput, 0, transcript.length);
        System.arraycopy(direction, 0, deriveInput, transcript.length + 1, direction.length);
        byte[] derived = new byte[32];
        assertEquals("BLAKE2b derive status", 0, nativeSodium.crypto_generichash(derived, derived.length, deriveInput, deriveInput.length, shared, shared.length));
        assertEquals("BLAKE2b derived key", x25519.getString("derivedKey"), b64(derived));

        JSONObject ed25519 = vector.getJSONObject("ed25519");
        byte[] handshake = canonicalHandshake(ed25519.getJSONObject("handshake"));
        assertEquals("handshake canonicalization", ed25519.getString("handshakeBytes"), b64(handshake));
        assertTrue(
                "Ed25519 signature",
                sodium.cryptoSignVerifyDetached(
                        unb64(ed25519.getString("signature")),
                        handshake,
                        handshake.length,
                        unb64(ed25519.getString("publicKey"))));

        JSONObject sealedBox = vector.getJSONObject("sealedBox");
        byte[] sealedCiphertext = unb64(sealedBox.getString("ciphertext"));
        byte[] unsealed = new byte[sealedCiphertext.length - Box.SEALBYTES];
        assertTrue(
                "sealed box",
                sodium.cryptoBoxSealOpen(
                        unsealed,
                        sealedCiphertext,
                        sealedCiphertext.length,
                        unb64(sealedBox.getString("publicKey")),
                        unb64(sealedBox.getString("privateKey"))));
        assertEquals("sealed box plaintext", sealedBox.getString("message"), b64(unsealed));

        JSONObject stream = vector.getJSONObject("secretstream");
        SecretStream.State state = new SecretStream.State();
        assertTrue(
                "secretstream init",
                sodium.cryptoSecretStreamInitPull(state, unb64(stream.getString("header")), unb64(stream.getString("key"))));
        byte[] streamCiphertext = unb64(stream.getString("ciphertext"));
        byte[] streamMessage = new byte[streamCiphertext.length - SecretStream.ABYTES];
        long[] streamLength = new long[1];
        byte[] streamTag = new byte[1];
        byte[] streamAad = unb64(stream.getString("aad"));
        assertTrue(
                "secretstream pull",
                sodium.cryptoSecretStreamPull(
                        state,
                        streamMessage,
                        streamLength,
                        streamTag,
                        streamCiphertext,
                        streamCiphertext.length,
                        streamAad,
                        streamAad.length));
        assertEquals("secretstream tag", SecretStream.TAG_MESSAGE, streamTag[0]);
        assertEquals("secretstream plaintext", stream.getString("message"), b64(exact(streamMessage, streamLength[0])));
    }

    private static byte[] canonicalAad(JSONObject metadata) throws Exception {
        JSONArray values = new JSONArray();
        values.put(metadata.getString("accountId"));
        values.put(metadata.getString("hostId"));
        values.put(metadata.getString("deviceId"));
        values.put(metadata.getString("channelId"));
        values.put(metadata.getLong("counter"));
        values.put(metadata.getString("kind"));
        values.put(metadata.opt("eventId"));
        values.put(metadata.opt("eventType"));
        return values.toString().getBytes(StandardCharsets.UTF_8);
    }

    private static byte[] canonicalHandshake(JSONObject value) throws Exception {
        ArrayList<String> keys = new ArrayList<>();
        Iterator<String> iterator = value.keys();
        while (iterator.hasNext()) keys.add(iterator.next());
        Collections.sort(keys);
        JSONArray pairs = new JSONArray();
        for (String key : keys) {
            pairs.put(new JSONArray().put(key).put(value.get(key)));
        }
        return pairs.toString().getBytes(StandardCharsets.UTF_8);
    }

    private static String readAsset(Context context, String name) throws Exception {
        try (InputStream input = context.getAssets().open(name); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    private static byte[] exact(byte[] value, long length) {
        byte[] output = new byte[(int) length];
        System.arraycopy(value, 0, output, 0, output.length);
        return output;
    }

    private static String b64(byte[] value) {
        return Base64.encodeToString(value, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }

    private static byte[] unb64(String value) {
        return Base64.decode(value, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }

    private static void assertTrue(String name, boolean value) {
        if (!value) throw new AssertionError(name + " failed");
    }

    private static void assertEquals(String name, String expected, String actual) {
        if (!expected.equals(actual)) throw new AssertionError(name + " mismatch");
    }

    private static void assertEquals(String name, int expected, int actual) {
        if (expected != actual) throw new AssertionError(name + " mismatch: " + actual);
    }
}
