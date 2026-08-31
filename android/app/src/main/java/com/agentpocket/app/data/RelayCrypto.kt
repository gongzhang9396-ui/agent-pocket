package com.agentpocket.app.data

import android.util.Base64
import com.goterl.lazysodium.LazySodiumAndroid
import com.goterl.lazysodium.SodiumAndroid
import com.goterl.lazysodium.interfaces.AEAD
import com.goterl.lazysodium.interfaces.Box
import com.goterl.lazysodium.interfaces.SecretStream
import com.goterl.lazysodium.interfaces.Sign
import java.nio.charset.StandardCharsets
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

@Serializable
internal data class RelayEnvelope(
    val accountId: String,
    val hostId: String,
    val deviceId: String,
    val channelId: String,
    val counter: Long,
    val kind: String,
    val ciphertext: String,
    val eventId: String? = null,
    val eventType: String? = null,
)

internal val RelayProtocolJson = Json {
    ignoreUnknownKeys = true
    encodeDefaults = true
    explicitNulls = false
}

internal data class RelayHostInfo(
    val id: String,
    val name: String,
    val signingPublicKey: String,
    val encryptionPublicKey: String,
    val online: Boolean,
    val lastSeenAt: Long?,
)

internal data class DeviceKeyMaterial(
    val signingPublicKey: String,
    val signingPrivateKey: String,
    val encryptionPublicKey: String,
    val encryptionPrivateKey: String,
)

internal data class AccountSecret(
    val signingPrivateKey: String,
    val encryptionPrivateKey: String,
    val contentKey: String,
)

internal data class RegistrationMaterial(
    val accountSigningPublicKey: String,
    val accountEncryptionPublicKey: String,
    val device: DeviceKeyMaterial,
    val accountSecret: AccountSecret,
    val escrowCiphertext: String,
    val keyPackage: String,
)

internal object RelayCrypto {
    private val native = SodiumAndroid()
    private val sodium = LazySodiumAndroid(native, StandardCharsets.UTF_8)
    private val json = RelayProtocolJson

    fun generateDevice(): DeviceKeyMaterial {
        val signPublic = ByteArray(Sign.PUBLICKEYBYTES)
        val signPrivate = ByteArray(Sign.SECRETKEYBYTES)
        check(sodium.cryptoSignKeypair(signPublic, signPrivate))
        val boxPublic = ByteArray(Box.PUBLICKEYBYTES)
        val boxPrivate = ByteArray(Box.SECRETKEYBYTES)
        check(sodium.cryptoBoxKeypair(boxPublic, boxPrivate))
        return DeviceKeyMaterial(b64(signPublic), b64(signPrivate), b64(boxPublic), b64(boxPrivate))
    }

    fun createRegistration(recoveryPublicKey: String): RegistrationMaterial {
        val accountSigning = generateSignPair()
        val accountEncryption = generateBoxPair()
        val device = generateDevice()
        val contentKey = random(AEAD.XCHACHA20POLY1305_IETF_KEYBYTES)
        val accountSecret = AccountSecret(
            signingPrivateKey = b64(accountSigning.second),
            encryptionPrivateKey = b64(accountEncryption.second),
            contentKey = b64(contentKey),
        )
        val accountPackage = JsonObject(
            mapOf(
                "version" to JsonPrimitive(1),
                "signingPublicKey" to JsonPrimitive(b64(accountSigning.first)),
                "signingPrivateKey" to JsonPrimitive(accountSecret.signingPrivateKey),
                "encryptionPublicKey" to JsonPrimitive(b64(accountEncryption.first)),
                "encryptionPrivateKey" to JsonPrimitive(accountSecret.encryptionPrivateKey),
                "contentKey" to JsonPrimitive(accountSecret.contentKey),
            ),
        ).toString().toByteArray()
        return RegistrationMaterial(
            accountSigningPublicKey = b64(accountSigning.first),
            accountEncryptionPublicKey = b64(accountEncryption.first),
            device = device,
            accountSecret = accountSecret,
            escrowCiphertext = b64(seal(accountPackage, unb64(recoveryPublicKey))),
            keyPackage = b64(seal(accountPackage, unb64(device.encryptionPublicKey))),
        )
    }

    fun openAccountPackage(keyPackage: String, device: DeviceKeyMaterial): AccountSecret {
        val plain = openSeal(
            unb64(keyPackage),
            unb64(device.encryptionPublicKey),
            unb64(device.encryptionPrivateKey),
        )
        val value = json.parseToJsonElement(plain.toString(Charsets.UTF_8)) as JsonObject
        return AccountSecret(
            signingPrivateKey = value.string("signingPrivateKey"),
            encryptionPrivateKey = value.string("encryptionPrivateKey"),
            contentKey = value.string("contentKey"),
        )
    }

    fun sealHostContentKey(hostEncryptionPublicKey: String, contentKey: String): String {
        val payload = JsonObject(mapOf("version" to JsonPrimitive(1), "contentKey" to JsonPrimitive(contentKey)))
        return b64(seal(payload.toString().toByteArray(), unb64(hostEncryptionPublicKey)))
    }

    fun sealAccountPackage(deviceEncryptionPublicKey: String, credentials: RelayCredentials): String {
        val payload = JsonObject(
            mapOf(
                "version" to JsonPrimitive(1),
                "signingPublicKey" to JsonPrimitive(credentials.accountSigningPublicKey),
                "signingPrivateKey" to JsonPrimitive(credentials.accountSigningPrivateKey ?: error("账户签名私钥缺失")),
                "encryptionPublicKey" to JsonPrimitive(credentials.accountEncryptionPublicKey),
                "encryptionPrivateKey" to JsonPrimitive(credentials.accountEncryptionPrivateKey ?: error("账户加密私钥缺失")),
                "contentKey" to JsonPrimitive(credentials.contentKey ?: error("账户内容密钥缺失")),
            ),
        )
        return b64(seal(payload.toString().toByteArray(), unb64(deviceEncryptionPublicKey)))
    }

    fun decryptAccountEnvelope(envelope: RelayEnvelope, contentKey: String): String {
        val combined = unb64(envelope.ciphertext)
        require(combined.size >= AEAD.XCHACHA20POLY1305_IETF_NPUBBYTES + AEAD.XCHACHA20POLY1305_IETF_ABYTES)
        val nonce = combined.copyOfRange(0, AEAD.XCHACHA20POLY1305_IETF_NPUBBYTES)
        val cipher = combined.copyOfRange(AEAD.XCHACHA20POLY1305_IETF_NPUBBYTES, combined.size)
        val output = ByteArray(cipher.size - AEAD.XCHACHA20POLY1305_IETF_ABYTES)
        val length = LongArray(1)
        check(
            sodium.cryptoAeadXChaCha20Poly1305IetfDecrypt(
                output,
                length,
                null,
                cipher,
                cipher.size.toLong(),
                aad(envelope),
                aad(envelope).size.toLong(),
                nonce,
                unb64(contentKey),
            ),
        )
        return output.copyOf(length[0].toInt()).toString(Charsets.UTF_8)
    }

    fun openChannel(credentials: RelayCredentials, host: RelayHostInfo, channelId: String): Pair<PhoneChannel, RelayEnvelope> {
        require(credentials.approved)
        val ephemeral = generateBoxPair()
        val transcript = transcript(credentials.accountId, host.id, credentials.deviceId, channelId)
        val deviceShared = scalar(ephemeral.second, unb64(host.encryptionPublicKey))
        val deviceToHost = derive(deviceShared, transcript, "device-to-host")
        val pushState = SecretStream.State()
        val pushHeader = ByteArray(SecretStream.HEADERBYTES)
        check(sodium.cryptoSecretStreamInitPush(pushState, pushHeader, deviceToHost))
        val unsigned = linkedMapOf<String, JsonElement>(
            "version" to JsonPrimitive(2),
            "accountId" to JsonPrimitive(credentials.accountId),
            "hostId" to JsonPrimitive(host.id),
            "deviceId" to JsonPrimitive(credentials.deviceId),
            "channelId" to JsonPrimitive(channelId),
            "issuedAt" to JsonPrimitive(System.currentTimeMillis()),
            "ephemeralPublicKey" to JsonPrimitive(b64(ephemeral.first)),
            "secretstreamHeader" to JsonPrimitive(b64(pushHeader)),
        )
        val signature = sign(handshake(unsigned), unb64(credentials.deviceSigningPrivateKey))
        val payload = JsonObject(unsigned + ("signature" to JsonPrimitive(b64(signature))))
        val envelope = RelayEnvelope(
            accountId = credentials.accountId,
            hostId = host.id,
            deviceId = credentials.deviceId,
            channelId = channelId,
            counter = 0,
            kind = "channel.open",
            ciphertext = b64(seal(payload.toString().toByteArray(), unb64(host.encryptionPublicKey))),
        )
        return PhoneChannel(credentials, host, channelId, ephemeral.first, pushState) to envelope
    }

    private fun generateSignPair(): Pair<ByteArray, ByteArray> {
        val publicKey = ByteArray(Sign.PUBLICKEYBYTES)
        val privateKey = ByteArray(Sign.SECRETKEYBYTES)
        check(sodium.cryptoSignKeypair(publicKey, privateKey))
        return publicKey to privateKey
    }

    private fun generateBoxPair(): Pair<ByteArray, ByteArray> {
        val publicKey = ByteArray(Box.PUBLICKEYBYTES)
        val privateKey = ByteArray(Box.SECRETKEYBYTES)
        check(sodium.cryptoBoxKeypair(publicKey, privateKey))
        return publicKey to privateKey
    }

    private fun seal(message: ByteArray, publicKey: ByteArray): ByteArray {
        val output = ByteArray(message.size + Box.SEALBYTES)
        check(sodium.cryptoBoxSeal(output, message, message.size.toLong(), publicKey))
        return output
    }

    private fun openSeal(ciphertext: ByteArray, publicKey: ByteArray, privateKey: ByteArray): ByteArray {
        require(ciphertext.size >= Box.SEALBYTES)
        val output = ByteArray(ciphertext.size - Box.SEALBYTES)
        check(sodium.cryptoBoxSealOpen(output, ciphertext, ciphertext.size.toLong(), publicKey, privateKey))
        return output
    }

    internal fun aad(envelope: RelayEnvelope): ByteArray = JsonArray(
        listOf(
            JsonPrimitive(envelope.accountId),
            JsonPrimitive(envelope.hostId),
            JsonPrimitive(envelope.deviceId),
            JsonPrimitive(envelope.channelId),
            JsonPrimitive(envelope.counter),
            JsonPrimitive(envelope.kind),
            envelope.eventId?.let(::JsonPrimitive) ?: JsonNull,
            envelope.eventType?.let(::JsonPrimitive) ?: JsonNull,
        ),
    ).toString().toByteArray()

    internal fun handshake(value: Map<String, JsonElement>): ByteArray = JsonArray(
        value.toSortedMap().map { (key, item) -> JsonArray(listOf(JsonPrimitive(key), item)) },
    ).toString().toByteArray()

    internal fun sign(message: ByteArray, privateKey: ByteArray): ByteArray {
        val signature = ByteArray(Sign.BYTES)
        check(sodium.cryptoSignDetached(signature, message, message.size.toLong(), privateKey))
        return signature
    }

    internal fun verify(signature: ByteArray, message: ByteArray, publicKey: ByteArray): Boolean =
        sodium.cryptoSignVerifyDetached(signature, message, message.size, publicKey)

    internal fun scalar(privateKey: ByteArray, publicKey: ByteArray): ByteArray {
        val output = ByteArray(32)
        check(native.crypto_scalarmult(output, privateKey, publicKey) == 0)
        return output
    }

    internal fun derive(shared: ByteArray, transcript: ByteArray, direction: String): ByteArray {
        val input = transcript + "\u0000$direction".toByteArray()
        val output = ByteArray(32)
        check(native.crypto_generichash(output, output.size, input, input.size.toLong(), shared, shared.size) == 0)
        return output
    }

    internal fun transcript(accountId: String, hostId: String, deviceId: String, channelId: String) =
        "agent-pocket-relay-v2\u0000$accountId\u0000$hostId\u0000$deviceId\u0000$channelId".toByteArray()

    internal fun b64(value: ByteArray): String = Base64.encodeToString(value, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    internal fun unb64(value: String): ByteArray = Base64.decode(value, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    private fun random(size: Int) = ByteArray(size).also { native.randombytes_buf(it, size) }
    private fun JsonObject.string(key: String) = (this[key] as? JsonPrimitive)?.content ?: error("密钥包缺少 $key")
}

internal class PhoneChannel(
    private val credentials: RelayCredentials,
    val host: RelayHostInfo,
    val channelId: String,
    private val deviceEphemeralPublicKey: ByteArray,
    private val pushState: SecretStream.State,
) {
    private var pullState: SecretStream.State? = null
    private var deviceCounter = 0L
    private var hostCounter = 0L

    fun accept(envelope: RelayEnvelope) {
        require(envelope.accountId == credentials.accountId && envelope.hostId == host.id && envelope.deviceId == credentials.deviceId)
        require(envelope.channelId == channelId && envelope.kind == "channel.open" && envelope.counter == 0L)
        val cipher = RelayCrypto.unb64(envelope.ciphertext)
        val output = ByteArray(cipher.size - Box.SEALBYTES)
        val sodium = LazySodiumAndroid(SodiumAndroid(), StandardCharsets.UTF_8)
        check(
            sodium.cryptoBoxSealOpen(
                output,
                cipher,
                cipher.size.toLong(),
                RelayCrypto.unb64(credentials.deviceEncryptionPublicKey),
                RelayCrypto.unb64(credentials.deviceEncryptionPrivateKey),
            ),
        )
        val payload = Json.parseToJsonElement(output.toString(Charsets.UTF_8)) as JsonObject
        val signature = (payload["signature"] as JsonPrimitive).content
        val unsigned = payload - "signature"
        require(payload.string("accountId") == credentials.accountId && payload.string("hostId") == host.id)
        require(payload.string("deviceId") == credentials.deviceId && payload.string("channelId") == channelId)
        require(payload.string("deviceEphemeralPublicKey") == RelayCrypto.b64(deviceEphemeralPublicKey))
        require(kotlin.math.abs(System.currentTimeMillis() - payload.long("issuedAt")) <= 5 * 60 * 1000)
        require(RelayCrypto.verify(RelayCrypto.unb64(signature), RelayCrypto.handshake(unsigned), RelayCrypto.unb64(host.signingPublicKey)))
        val hostEphemeral = RelayCrypto.unb64(payload.string("ephemeralPublicKey"))
        val shared = RelayCrypto.scalar(RelayCrypto.unb64(credentials.deviceEncryptionPrivateKey), hostEphemeral)
        val key = RelayCrypto.derive(
            shared,
            RelayCrypto.transcript(credentials.accountId, host.id, credentials.deviceId, channelId),
            "host-to-device",
        )
        pullState = SecretStream.State().also {
            check(sodium.cryptoSecretStreamInitPull(it, RelayCrypto.unb64(payload.string("secretstreamHeader")), key))
        }
    }

    fun encrypt(text: String, final: Boolean = false): RelayEnvelope {
        val counter = deviceCounter + 1
        val metadata = RelayEnvelope(
            accountId = credentials.accountId,
            hostId = host.id,
            deviceId = credentials.deviceId,
            channelId = channelId,
            counter = counter,
            kind = if (final) "channel.close" else "channel.data",
            ciphertext = "",
        )
        val message = text.toByteArray()
        val output = ByteArray(message.size + SecretStream.ABYTES)
        val length = LongArray(1)
        val sodium = LazySodiumAndroid(SodiumAndroid(), StandardCharsets.UTF_8)
        check(
            sodium.cryptoSecretStreamPush(
                pushState,
                output,
                length,
                message,
                message.size.toLong(),
                RelayCrypto.aad(metadata),
                RelayCrypto.aad(metadata).size.toLong(),
                if (final) SecretStream.TAG_FINAL else SecretStream.TAG_MESSAGE,
            ),
        )
        deviceCounter = counter
        return metadata.copy(ciphertext = RelayCrypto.b64(output.copyOf(length[0].toInt())))
    }

    fun decrypt(envelope: RelayEnvelope): String {
        require(envelope.kind == "channel.data" && envelope.counter == hostCounter + 1)
        require(envelope.accountId == credentials.accountId && envelope.hostId == host.id && envelope.deviceId == credentials.deviceId && envelope.channelId == channelId)
        val cipher = RelayCrypto.unb64(envelope.ciphertext)
        val output = ByteArray(cipher.size - SecretStream.ABYTES)
        val length = LongArray(1)
        val tag = ByteArray(1)
        val sodium = LazySodiumAndroid(SodiumAndroid(), StandardCharsets.UTF_8)
        check(
            sodium.cryptoSecretStreamPull(
                pullState ?: error("Host 通道握手尚未完成"),
                output,
                length,
                tag,
                cipher,
                cipher.size.toLong(),
                RelayCrypto.aad(envelope),
                RelayCrypto.aad(envelope).size.toLong(),
            ),
        )
        require(tag[0] == SecretStream.TAG_MESSAGE)
        hostCounter = envelope.counter
        return output.copyOf(length[0].toInt()).toString(Charsets.UTF_8)
    }

    private fun JsonObject.string(key: String) = (this[key] as JsonPrimitive).content
    private fun JsonObject.long(key: String) = (this[key] as JsonPrimitive).content.toLong()
}
