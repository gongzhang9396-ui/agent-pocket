package com.agentpocket.app.data

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.goterl.lazysodium.LazySodiumAndroid
import com.goterl.lazysodium.SodiumAndroid
import com.goterl.lazysodium.interfaces.AEAD
import com.goterl.lazysodium.interfaces.Box
import com.goterl.lazysodium.interfaces.SecretStream
import com.goterl.lazysodium.interfaces.Sign
import java.nio.charset.StandardCharsets
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
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

    @Test
    fun repeatedChannelMessagesKeepTheStreamUsable() {
        val device = RelayCrypto.generateDevice()
        val credentials = RelayCredentials(
            endpoint = "https://example.test", accountId = "account", username = "test",
            deviceId = "phone", deviceName = "test", deviceStatus = "approved",
            accessToken = "", refreshToken = "", accessExpiresAt = 0L, refreshExpiresAt = 0L,
            deviceSigningPublicKey = device.signingPublicKey, deviceSigningPrivateKey = device.signingPrivateKey,
            deviceEncryptionPublicKey = device.encryptionPublicKey, deviceEncryptionPrivateKey = device.encryptionPrivateKey,
            accountSigningPublicKey = "", accountEncryptionPublicKey = "",
            contentKey = "test",
        )
        val hostSigningPublic = ByteArray(Sign.PUBLICKEYBYTES)
        val hostSigningPrivate = ByteArray(Sign.SECRETKEYBYTES)
        val hostBoxPublic = ByteArray(Box.PUBLICKEYBYTES)
        val hostBoxPrivate = ByteArray(Box.SECRETKEYBYTES)
        assertTrue(sodium.cryptoSignKeypair(hostSigningPublic, hostSigningPrivate))
        assertTrue(sodium.cryptoBoxKeypair(hostBoxPublic, hostBoxPrivate))
        val host = RelayHostInfo("host", "test", RelayCrypto.b64(hostSigningPublic), RelayCrypto.b64(hostBoxPublic), true, null)
        data class TestPeer(val channel: PhoneChannel, val receive: SecretStream.State, val send: SecretStream.State)

        fun openPeer(id: String): TestPeer {
            val (channel, request) = RelayCrypto.openChannel(credentials, host, id)
            val sealed = RelayCrypto.unb64(request.ciphertext)
            val plain = ByteArray(sealed.size - Box.SEALBYTES)
            assertTrue(sodium.cryptoBoxSealOpen(plain, sealed, sealed.size.toLong(), hostBoxPublic, hostBoxPrivate))
            val open = Json.parseToJsonElement(plain.toString(Charsets.UTF_8)) as JsonObject
            val deviceEphemeral = RelayCrypto.unb64(open.text("ephemeralPublicKey"))
            val transcript = RelayCrypto.transcript(credentials.accountId, host.id, credentials.deviceId, id)
            val receiveKey = RelayCrypto.derive(RelayCrypto.scalar(hostBoxPrivate, deviceEphemeral), transcript, "device-to-host")
            val receive = SecretStream.State()
            assertTrue(sodium.cryptoSecretStreamInitPull(receive, RelayCrypto.unb64(open.text("secretstreamHeader")), receiveKey))

            val hostEphemeralPublic = ByteArray(Box.PUBLICKEYBYTES)
            val hostEphemeralPrivate = ByteArray(Box.SECRETKEYBYTES)
            assertTrue(sodium.cryptoBoxKeypair(hostEphemeralPublic, hostEphemeralPrivate))
            val sendKey = RelayCrypto.derive(
                RelayCrypto.scalar(hostEphemeralPrivate, RelayCrypto.unb64(device.encryptionPublicKey)), transcript, "host-to-device",
            )
            val send = SecretStream.State()
            val header = ByteArray(SecretStream.HEADERBYTES)
            assertTrue(sodium.cryptoSecretStreamInitPush(send, header, sendKey))
            val unsigned = linkedMapOf<String, JsonElement>(
                "version" to JsonPrimitive(2), "accountId" to JsonPrimitive(credentials.accountId),
                "hostId" to JsonPrimitive(host.id), "deviceId" to JsonPrimitive(credentials.deviceId),
                "channelId" to JsonPrimitive(id), "issuedAt" to JsonPrimitive(System.currentTimeMillis()),
                "deviceEphemeralPublicKey" to JsonPrimitive(RelayCrypto.b64(deviceEphemeral)),
                "ephemeralPublicKey" to JsonPrimitive(RelayCrypto.b64(hostEphemeralPublic)),
                "secretstreamHeader" to JsonPrimitive(RelayCrypto.b64(header)),
            )
            val signature = RelayCrypto.b64(RelayCrypto.sign(RelayCrypto.handshake(unsigned), hostSigningPrivate))
            val payload = JsonObject(unsigned + ("signature" to JsonPrimitive(signature))).toString().toByteArray()
            val response = ByteArray(payload.size + Box.SEALBYTES)
            assertTrue(sodium.cryptoBoxSeal(response, payload, payload.size.toLong(), RelayCrypto.unb64(device.encryptionPublicKey)))
            channel.accept(request.copy(ciphertext = RelayCrypto.b64(response)))
            return TestPeer(channel, receive, send)
        }

        val peers = listOf(openPeer("channel-a"), openPeer("channel-b"))
        repeat(1000) { index ->
            peers.forEach { peer ->
                val message = "message-${peer.channel.channelId}-$index"
                val envelope = peer.channel.encrypt(message)
                assertEquals(index + 1L, envelope.counter)
                val ciphertext = RelayCrypto.unb64(envelope.ciphertext)
                val plaintext = ByteArray(ciphertext.size - SecretStream.ABYTES)
                val length = LongArray(1)
                val tag = ByteArray(1)
                val aad = RelayCrypto.aad(envelope)
                assertTrue(sodium.cryptoSecretStreamPull(peer.receive, plaintext, length, tag, ciphertext, ciphertext.size.toLong(), aad, aad.size.toLong()))
                assertEquals(SecretStream.TAG_MESSAGE, tag[0])
                assertEquals(message, plaintext.copyOf(length[0].toInt()).toString(Charsets.UTF_8))

                val reply = "reply-${peer.channel.channelId}-$index"
                val replyBytes = reply.toByteArray()
                val metadata = envelope.copy(ciphertext = "")
                val replyAad = RelayCrypto.aad(metadata)
                val replyCiphertext = ByteArray(replyBytes.size + SecretStream.ABYTES)
                val replyLength = LongArray(1)
                assertTrue(sodium.cryptoSecretStreamPush(peer.send, replyCiphertext, replyLength, replyBytes, replyBytes.size.toLong(), replyAad, replyAad.size.toLong(), SecretStream.TAG_MESSAGE))
                assertEquals(reply, peer.channel.decrypt(metadata.copy(ciphertext = RelayCrypto.b64(replyCiphertext.copyOf(replyLength[0].toInt())))))
            }
        }
    }

    private fun JsonObject.obj(key: String) = this[key] as JsonObject
    private fun JsonObject.text(key: String) = (this[key] as JsonPrimitive).content
    private fun JsonObject.long(key: String) = text(key).toLong()
}
