package com.agentpocket.app.data

import java.io.IOException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

internal interface RelayCredentialStore {
    fun load(): RelayCredentials?
    fun save(credentials: RelayCredentials)
    fun clearCredentials()
}

internal class SignInRequiredException : IOException("登录已失效，请重新登录；这部手机的身份已保留")
internal class SessionChangedException : IOException("登录信息已切换，请重试")
internal class AccessRejectedException : IOException("登录凭证已失效")
internal class RefreshConsumedException(cause: Throwable) : IOException("登录续期结果无法保存，请重新登录", cause)
internal class RelaySessionSnapshot(val credentials: RelayCredentials, internal val generation: Long)

/** One instance per application. Rotation is shared by sockets and HTTP consumers. */
internal class RelaySessionManager(
    private val store: RelayCredentialStore,
    private val refresh: suspend (RelayCredentials) -> RelayCredentials,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val gate = Any()
    private val refreshMutex = Mutex()
    private var generation = 0L
    private val _requiresLogin = MutableStateFlow(store.load()?.requiresLogin == true)
    val requiresLogin = _requiresLogin.asStateFlow()

    fun generation(): Long = synchronized(gate) { generation }

    fun snapshot(approvedOnly: Boolean = true): RelaySessionSnapshot = synchronized(gate) {
        val credentials = store.load() ?: throw SignInRequiredException()
        if (_requiresLogin.value || credentials.requiresLogin) throw SignInRequiredException()
        if (approvedOnly && !credentials.approved) throw SignInRequiredException()
        RelaySessionSnapshot(credentials, generation)
    }

    fun replace(expectedGeneration: Long, credentials: RelayCredentials) = synchronized(gate) {
        if (generation != expectedGeneration) throw SessionChangedException()
        generation++
        try {
            store.save(credentials.copy(requiresLogin = false))
        } catch (error: Exception) {
            _requiresLogin.value = true
            runCatching { store.save(credentials.copy(requiresLogin = true)) }
            throw error
        }
        _requiresLogin.value = false
    }

    fun clear() = synchronized(gate) {
        generation++
        try {
            store.clearCredentials()
        } catch (error: Exception) {
            _requiresLogin.value = true
            throw error
        }
        _requiresLogin.value = false
    }

    private fun current(ref: RelaySessionSnapshot): RelayCredentials {
        val value = store.load() ?: throw SessionChangedException()
        if (ref.generation != generation || value.endpoint != ref.credentials.endpoint ||
            value.accountId != ref.credentials.accountId || value.deviceId != ref.credentials.deviceId
        ) throw SessionChangedException()
        if (_requiresLogin.value || value.requiresLogin) throw SignInRequiredException()
        return value
    }

    fun <T> withCurrent(ref: RelaySessionSnapshot, block: (RelayCredentials) -> T): T =
        synchronized(gate) { block(current(ref)) }

    fun update(ref: RelaySessionSnapshot, transform: (RelayCredentials) -> RelayCredentials): RelayCredentials =
        synchronized(gate) { transform(current(ref)).also(store::save) }

    private fun reject(ref: RelaySessionSnapshot, rejectedAccessToken: String): Nothing = synchronized(gate) {
        val value = current(ref)
        // A delayed 401 from a superseded access token must not reject its successor.
        if (value.accessToken != rejectedAccessToken) throw SessionChangedException()
        _requiresLogin.value = true
        runCatching { store.save(value.copy(requiresLogin = true)) }
        throw SignInRequiredException()
    }

    fun rejectAccess(ref: RelaySessionSnapshot, rejectedAccessToken: String): Nothing = reject(ref, rejectedAccessToken)

    private fun consumedButUnsaved(ref: RelaySessionSnapshot): Nothing = synchronized(gate) {
        // A failed disk commit may already have updated SharedPreferences in memory.
        // Fence by login generation here, not by the pre-rotation access token.
        val value = current(ref)
        _requiresLogin.value = true
        runCatching { store.save(value.copy(requiresLogin = true)) }
        throw SignInRequiredException()
    }

    suspend fun fresh(
        ref: RelaySessionSnapshot,
        rejectedAccessToken: String? = null,
    ): RelayCredentials = refreshMutex.withLock {
        // A successful rotation consumes the old refresh token. Finish saving even
        // when the initiating screen/socket is cancelled; login/logout still fences it.
        withContext(NonCancellable) {
            val value = synchronized(gate) { current(ref) }
            if (value.accessExpiresAt > now() + 30_000 && value.accessToken != rejectedAccessToken) {
                return@withContext value
            }
            if (value.refreshExpiresAt <= now()) reject(ref, value.accessToken)
            val rotated = try {
                refresh(value)
            } catch (error: AccessRejectedException) {
                reject(ref, value.accessToken)
            } catch (error: RefreshConsumedException) {
                consumedButUnsaved(ref)
            }
            if (rotated.accessToken.isBlank() || rotated.refreshToken.isBlank() ||
                rotated.accessExpiresAt <= now() || rotated.refreshExpiresAt <= now()) consumedButUnsaved(ref)
            try {
                update(ref) { latest ->
                    latest.copy(
                        accessToken = rotated.accessToken,
                        refreshToken = rotated.refreshToken,
                        accessExpiresAt = rotated.accessExpiresAt,
                        refreshExpiresAt = rotated.refreshExpiresAt,
                    )
                }
            } catch (error: SessionChangedException) {
                throw error
            } catch (error: SignInRequiredException) {
                throw error
            } catch (error: Exception) {
                consumedButUnsaved(ref)
            }
        }
    }

    /** Only use for idempotent reads. Never replay chat sends or account mutations. */
    suspend fun <T> read(ref: RelaySessionSnapshot, request: suspend (RelayCredentials) -> T): T {
        var credentials = fresh(ref)
        repeat(2) { attempt ->
            try {
                currentCoroutineContext().ensureActive()
                val result = request(credentials)
                withCurrent(ref) { }
                return result
            } catch (error: AccessRejectedException) {
                if (attempt == 1) reject(ref, credentials.accessToken)
                credentials = fresh(ref, credentials.accessToken)
            }
        }
        error("Unreachable")
    }
}
