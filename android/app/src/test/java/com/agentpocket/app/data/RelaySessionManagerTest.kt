package com.agentpocket.app.data

import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.*
import org.junit.Test

class RelaySessionManagerTest {
    private val now = 1_000_000L
    private fun credentials(access: String = "old", expires: Long = now - 1) = RelayCredentials(
        endpoint = "https://relay.example", accountId = "account", username = "user", deviceId = "device",
        deviceName = "phone", deviceStatus = "approved", accessToken = access, refreshToken = "refresh-$access",
        accessExpiresAt = expires, refreshExpiresAt = now + 30_000_000,
        deviceSigningPublicKey = "dsp", deviceSigningPrivateKey = "dsk", deviceEncryptionPublicKey = "dep",
        deviceEncryptionPrivateKey = "dek", accountSigningPublicKey = "asp", accountEncryptionPublicKey = "aep",
        contentKey = "content-key",
    )
    private class Store(var value: RelayCredentials?) : RelayCredentialStore {
        var saves = 0
        override fun load() = value
        override fun save(credentials: RelayCredentials) { value = credentials; saves++ }
        override fun clearCredentials() { value = null }
    }
    private suspend inline fun <reified T : Throwable> fails(crossinline block: suspend () -> Unit): T {
        try { block() } catch (error: Throwable) {
            assertTrue("Expected ${T::class.simpleName}, got ${error.javaClass.simpleName}", error is T)
            return error as T
        }
        throw AssertionError("Expected ${T::class.simpleName}")
    }

    @Test fun startupSocketAndUpdaterShareOneRotation() = runBlocking {
        val store = Store(credentials())
        val entered = CompletableDeferred<Unit>()
        val finish = CompletableDeferred<Unit>()
        var refreshes = 0
        val manager = RelaySessionManager(store, {
            refreshes++; entered.complete(Unit); finish.await(); credentials("new", now + 900_000)
        }, { now })
        val ref = manager.snapshot()
        val socket = async { manager.fresh(ref).accessToken }
        entered.await()
        val updates = (1..8).map { async { manager.read(ref) { it.accessToken } } }
        yield(); finish.complete(Unit)
        assertEquals("new", socket.await())
        assertEquals(List(8) { "new" }, updates.awaitAll())
        assertEquals(1, refreshes)
        assertEquals(1, store.saves)
    }

    @Test fun unauthorizedReadRefreshesLocallyUnexpiredAccessAndRetriesOnce() = runBlocking {
        val store = Store(credentials(expires = now + 900_000))
        var refreshes = 0
        val manager = RelaySessionManager(store, { refreshes++; credentials("new", now + 900_000) }, { now })
        val used = mutableListOf<String>()
        val result = manager.read(manager.snapshot()) {
            used += it.accessToken
            if (it.accessToken == "old") throw AccessRejectedException()
            "latest"
        }
        assertEquals("latest", result)
        assertEquals(listOf("old", "new"), used)
        assertEquals(1, refreshes)
    }

    @Test fun late401UsesAlreadyRotatedAccessWithoutAnotherRefresh() = runBlocking {
        val store = Store(credentials(expires = now + 900_000))
        var refreshes = 0
        val manager = RelaySessionManager(store, { refreshes++; credentials("new", now + 900_000) }, { now })
        val ref = manager.snapshot()
        manager.fresh(ref, "old")
        assertEquals("new", manager.fresh(ref, "old").accessToken)
        assertEquals(1, refreshes)
        fails<SessionChangedException> { manager.rejectAccess(ref, "old") }
        assertFalse(manager.requiresLogin.value)
    }

    @Test fun second401StopsAndPreservesDeviceIdentityAcrossRestart() = runBlocking {
        val store = Store(credentials(expires = now + 900_000))
        var requests = 0
        var refreshes = 0
        val refresh: suspend (RelayCredentials) -> RelayCredentials = { refreshes++; credentials("new", now + 900_000) }
        val manager = RelaySessionManager(store, refresh, { now })
        fails<SignInRequiredException> {
            manager.read(manager.snapshot()) { requests++; throw AccessRejectedException() }
        }
        assertEquals(2, requests)
        assertEquals(1, refreshes)
        assertTrue(manager.requiresLogin.value)
        assertEquals("device", store.value?.deviceId)
        assertEquals("dek", store.value?.deviceEncryptionPrivateKey)
        assertEquals("content-key", store.value?.contentKey)
        val restarted = RelaySessionManager(store, refresh, { now })
        fails<SignInRequiredException> { restarted.fresh(restarted.snapshot()) }
        assertEquals(1, refreshes)
    }

    @Test fun rejectedRefreshIsNotRetriedAndLoginKeepsOriginalDevice() = runBlocking {
        val store = Store(credentials())
        var refreshes = 0
        val manager = RelaySessionManager(store, { refreshes++; throw AccessRejectedException() }, { now })
        val ref = manager.snapshot()
        repeat(3) { fails<SignInRequiredException> { manager.fresh(ref) } }
        assertEquals(1, refreshes)
        val retained = store.value!!
        manager.replace(manager.generation(), retained.copy(accessToken = "login", accessExpiresAt = now + 900_000))
        assertFalse(manager.requiresLogin.value)
        assertEquals("device", manager.fresh(manager.snapshot()).deviceId)
        assertEquals("login", store.value?.accessToken)
    }

    @Test fun networkErrorDoesNotInvalidateSessionOrReplayRead() = runBlocking {
        val original = credentials(expires = now + 900_000)
        val store = Store(original)
        val manager = RelaySessionManager(store, { throw AssertionError("unexpected refresh") }, { now })
        var calls = 0
        fails<IOException> { manager.read(manager.snapshot()) { calls++; throw IOException("offline") } }
        assertEquals(1, calls)
        assertEquals(original, store.value)
        assertFalse(manager.requiresLogin.value)
    }

    @Test fun refreshNetworkFailureCanRecoverLater() = runBlocking {
        val store = Store(credentials())
        var calls = 0
        val manager = RelaySessionManager(store, {
            if (++calls == 1) throw IOException("offline")
            credentials("new", now + 900_000)
        }, { now })
        fails<IOException> { manager.fresh(manager.snapshot()) }
        assertFalse(manager.requiresLogin.value)
        assertEquals("new", manager.fresh(manager.snapshot()).accessToken)
    }

    @Test fun lateRotationCannotResurrectLogout() = runBlocking {
        val store = Store(credentials())
        val finish = CompletableDeferred<Unit>()
        val manager = RelaySessionManager(store, { finish.await(); credentials("new", now + 900_000) }, { now })
        val job = async(start = CoroutineStart.UNDISPATCHED) {
            fails<SessionChangedException> { manager.fresh(manager.snapshot()) }
        }
        manager.clear(); finish.complete(Unit); job.await()
        assertNull(store.value)
        assertEquals(0, store.saves)
    }

    @Test fun lateRotationCannotOverwriteNewLoginOnSameRelay() = runBlocking {
        val store = Store(credentials())
        val finish = CompletableDeferred<Unit>()
        val manager = RelaySessionManager(store, { finish.await(); credentials("rotated", now + 900_000) }, { now })
        val job = async(start = CoroutineStart.UNDISPATCHED) {
            fails<SessionChangedException> { manager.fresh(manager.snapshot()) }
        }
        val login = credentials("login", now + 900_000)
        manager.replace(manager.generation(), login)
        finish.complete(Unit); job.await()
        assertEquals(login, store.value)
    }

    @Test fun rejectedOldRefreshCannotInvalidateNewLogin() = runBlocking {
        val store = Store(credentials())
        val finish = CompletableDeferred<Unit>()
        val manager = RelaySessionManager(store, { finish.await(); throw AccessRejectedException() }, { now })
        val job = async(start = CoroutineStart.UNDISPATCHED) {
            fails<SessionChangedException> { manager.fresh(manager.snapshot()) }
        }
        manager.replace(manager.generation(), credentials("login", now + 900_000))
        finish.complete(Unit); job.await()
        assertFalse(manager.requiresLogin.value)
        assertEquals("login", store.value?.accessToken)
    }

    @Test fun cancelledCallerStillSavesSuccessfulRotation() = runBlocking {
        val store = Store(credentials())
        val finish = CompletableDeferred<Unit>()
        val manager = RelaySessionManager(store, { finish.await(); credentials("new", now + 900_000) }, { now })
        val job = launch(start = CoroutineStart.UNDISPATCHED) { manager.fresh(manager.snapshot()) }
        job.cancel(); finish.complete(Unit); job.join()
        assertEquals("new", store.value?.accessToken)
        assertEquals("refresh-new", store.value?.refreshToken)
    }

    @Test fun approvalDuringRefreshKeepsBothNewKeysAndTokens() = runBlocking {
        val store = Store(credentials().copy(deviceStatus = "pending", contentKey = null))
        val finish = CompletableDeferred<Unit>()
        val manager = RelaySessionManager(store, { finish.await(); it.copy(accessToken = "new", accessExpiresAt = now + 900_000) }, { now })
        val ref = manager.snapshot(approvedOnly = false)
        val job = async(start = CoroutineStart.UNDISPATCHED) { manager.fresh(ref) }
        manager.update(ref) { it.copy(deviceStatus = "approved", contentKey = "approved-key") }
        finish.complete(Unit); job.await()
        assertTrue(store.value!!.approved)
        assertEquals("approved-key", store.value?.contentKey)
        assertEquals("new", store.value?.accessToken)
    }

    @Test fun downloadRefreshesAgainWhenAccessExpiresAfterCheckingLatest() = runBlocking {
        var clock = now
        val store = Store(credentials(expires = now + 60_000))
        var refreshes = 0
        val manager = RelaySessionManager(store, { refreshes++; credentials("download", clock + 900_000) }, { clock })
        val ref = manager.snapshot()
        assertEquals("old", manager.read(ref) { it.accessToken })
        clock += 61_000
        assertEquals("download", manager.read(ref) { it.accessToken })
        assertEquals(1, refreshes)
    }

    @Test fun oldReadResultAndOldLoginCannotApplyAfterLogout() = runBlocking {
        val store = Store(credentials(expires = now + 900_000))
        val manager = RelaySessionManager(store, { throw AssertionError() }, { now })
        val ref = manager.snapshot()
        val loginGeneration = manager.generation()
        fails<SessionChangedException> { manager.read(ref) { manager.clear(); "stale" } }
        fails<SessionChangedException> { manager.replace(loginGeneration, credentials("login")) }
        assertNull(store.value)
    }

    @Test fun expiredRefreshRequiresLoginWithoutNetworkRequest() = runBlocking {
        val store = Store(credentials().copy(refreshExpiresAt = now - 1))
        val manager = RelaySessionManager(store, { throw AssertionError("expired refresh sent") }, { now })
        fails<SignInRequiredException> { manager.fresh(manager.snapshot()) }
        assertTrue(manager.requiresLogin.value)
    }

    @Test fun consumedRefreshWithUnwritableStorageStopsInMemory() = runBlocking {
        val original = credentials()
        val store = object : RelayCredentialStore {
            override fun load() = original
            override fun save(credentials: RelayCredentials) { throw IOException("disk full") }
            override fun clearCredentials() = Unit
        }
        var refreshes = 0
        val manager = RelaySessionManager(store, { refreshes++; credentials("new", now + 900_000) }, { now })
        val ref = manager.snapshot()
        repeat(3) { fails<SignInRequiredException> { manager.fresh(ref) } }
        assertEquals(1, refreshes)
        assertTrue(manager.requiresLogin.value)
        fails<SignInRequiredException> { manager.snapshot() }
        assertEquals(original.deviceId, store.load().deviceId)
    }

    @Test fun malformedSuccessfulRotationAndUnwritableRejectionAreTerminal() = runBlocking {
        for (failure in listOf(RefreshConsumedException(IOException("invalid response")), AccessRejectedException())) {
            val original = credentials()
            val store = object : RelayCredentialStore {
                override fun load() = original
                override fun save(credentials: RelayCredentials) { throw IOException("disk full") }
                override fun clearCredentials() = Unit
            }
            var calls = 0
            val manager = RelaySessionManager(store, { calls++; throw failure }, { now })
            val ref = manager.snapshot()
            repeat(2) { fails<SignInRequiredException> { manager.fresh(ref) } }
            assertEquals(1, calls)
            assertTrue(manager.requiresLogin.value)
        }
    }

    @Test fun failedLoginCommitAndLogoutStillFenceOldRequests() = runBlocking {
        for (clearing in listOf(false, true)) {
            val store = object : RelayCredentialStore {
                var value = credentials(expires = now + 900_000)
                override fun load() = value
                override fun save(credentials: RelayCredentials) { value = credentials; throw IOException("disk full") }
                override fun clearCredentials() { throw IOException("disk full") }
            }
            val manager = RelaySessionManager(store, { throw AssertionError("must not refresh") }, { now })
            val ref = manager.snapshot()
            fails<IOException> {
                if (clearing) manager.clear() else manager.replace(manager.generation(), credentials("login", now + 900_000))
            }
            fails<SessionChangedException> { manager.fresh(ref) }
            fails<SignInRequiredException> { manager.snapshot() }
            assertTrue(manager.requiresLogin.value)
        }
    }
}
