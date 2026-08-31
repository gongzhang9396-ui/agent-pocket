package com.agentpocket.app.data

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.goterl.lazysodium.LazySodiumAndroid
import com.goterl.lazysodium.SodiumAndroid
import com.goterl.lazysodium.interfaces.AEAD
import com.goterl.lazysodium.interfaces.Box
import com.goterl.lazysodium.interfaces.SecretStream
import java.nio.charset.StandardCharsets
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RelayCryptoVectorTest {
    private val native = SodiumAndroid()
    private val sodium = LazySodiumAndroid(native, StandardCharsets.UTF_8)
    private val vector: JsonObject by lazy {
        val context = InstrumentationRegistry.getInstrumentation().context
        context.assets.open("crypto-vectors.json").bufferedReader().use {
            Json.parseToJsonElement(it.readText()) as JsonObject
        }
    }

    @Test
    fun fixedVectorsMatchBridgeProtocol() {
        val metadata = vector.obj("metadata")
        val envelope = RelayEnvelope(
            accountId = metadata.text("accountId"),
            hostId = metadata.text("hostId"),
            deviceId = metadata.text("deviceId"),
            channelId = metadata.text("channelId"),
            counter = metadata.long("counter"),
            kind = metadata.text("kind"),
            ciphertext = "",
            eventId = metadata.text("eventId"),
            eventType = metadata.text("eventType"),
        )
        assertEquals(vector.text("aad"), RelayCrypto.b64(RelayCrypto.aad(envelope)))

        val aead = vector.obj("aead")
        val message = RelayCrypto.unb64(aead.text("message"))
        val aad = RelayCrypto.aad(envelope)
        val ciphertext = ByteArray(message.size + AEAD.XCHACHA20POLY1305_IETF_ABYTES)
        val ciphertextLength = LongArray(1)
        assertTrue(
            sodium.cryptoAeadXChaCha20Poly1305IetfEncrypt(
                ciphertext,
                ciphertextLength,
                message,
                message.size.toLong(),
                aad,
                aad.size.toLong(),
                null,
                RelayCrypto.unb64(aead.text("nonce")),
                RelayCrypto.unb64(aead.text("key")),
            ),
        )
        val exactCiphertext = ciphertext.copyOf(ciphertextLength[0].toInt())
        assertEquals(aead.text("ciphertext"), RelayCrypto.b64(exactCiphertext))
        val combined = RelayCrypto.unb64(aead.text("nonce")) + exactCiphertext
        assertEquals(
            message.toString(Charsets.UTF_8),
            RelayCrypto.decryptAccountEnvelope(envelope.copy(ciphertext = RelayCrypto.b64(combined)), aead.text("key")),
        )

        val x25519 = vector.obj("x25519")
        val publicA = ByteArray(32)
        val publicB = ByteArray(32)
        assertEquals(0, native.crypto_scalarmult_base(publicA, RelayCrypto.unb64(x25519.text("privateA"))))
        assertEquals(0, native.crypto_scalarmult_base(publicB, RelayCrypto.unb64(x25519.text("privateB"))))
        assertEquals(x25519.text("publicA"), RelayCrypto.b64(publicA))
        assertEquals(x25519.text("publicB"), RelayCrypto.b64(publicB))
        val shared = RelayCrypto.scalar(RelayCrypto.unb64(x25519.text("privateA")), publicB)
        assertEquals(x25519.text("shared"), RelayCrypto.b64(shared))
        assertEquals(
            x25519.text("derivedKey"),
            RelayCrypto.b64(
                RelayCrypto.derive(shared, RelayCrypto.unb64(x25519.text("transcript")), x25519.text("direction")),
            ),
        )

        val ed25519 = vector.obj("ed25519")
        assertArrayEquals(
            RelayCrypto.unb64(ed25519.text("handshakeBytes")),
            RelayCrypto.handshake(ed25519.obj("handshake")),
        )
        assertTrue(
            RelayCrypto.verify(
                RelayCrypto.unb64(ed25519.text("signature")),
                RelayCrypto.unb64(ed25519.text("handshakeBytes")),
                RelayCrypto.unb64(ed25519.text("publicKey")),
            ),
        )

        val sealed = vector.obj("sealedBox")
        val sealedCiphertext = RelayCrypto.unb64(sealed.text("ciphertext"))
        val unsealed = ByteArray(sealedCiphertext.size - Box.SEALBYTES)
        assertTrue(
            sodium.cryptoBoxSealOpen(
                unsealed,
                sealedCiphertext,
                sealedCiphertext.size.toLong(),
                RelayCrypto.unb64(sealed.text("publicKey")),
                RelayCrypto.unb64(sealed.text("privateKey")),
            ),
        )
        assertEquals(sealed.text("message"), RelayCrypto.b64(unsealed))

        val stream = vector.obj("secretstream")
        val state = SecretStream.State()
        assertTrue(
            sodium.cryptoSecretStreamInitPull(
                state,
                RelayCrypto.unb64(stream.text("header")),
                RelayCrypto.unb64(stream.text("key")),
            ),
        )
        val streamCiphertext = RelayCrypto.unb64(stream.text("ciphertext"))
        val streamMessage = ByteArray(streamCiphertext.size - SecretStream.ABYTES)
        val streamLength = LongArray(1)
        val streamTag = ByteArray(1)
        val streamAad = RelayCrypto.unb64(stream.text("aad"))
        assertTrue(
            sodium.cryptoSecretStreamPull(
                state,
                streamMessage,
                streamLength,
                streamTag,
                streamCiphertext,
                streamCiphertext.size.toLong(),
                streamAad,
                streamAad.size.toLong(),
            ),
        )
        assertEquals(SecretStream.TAG_MESSAGE, streamTag[0])
        assertEquals(stream.text("message"), RelayCrypto.b64(streamMessage.copyOf(streamLength[0].toInt())))
    }

    private fun JsonObject.obj(key: String) = this[key] as JsonObject
    private fun JsonObject.text(key: String) = (this[key] as JsonPrimitive).content
    private fun JsonObject.long(key: String) = text(key).toLong()
}
