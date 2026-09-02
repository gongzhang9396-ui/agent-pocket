package com.agentpocket.app.data

import android.net.Uri
import com.agentpocket.app.data.model.ApprovalDecision
import com.agentpocket.app.data.model.Device
import com.agentpocket.app.data.model.DiffFile
import com.agentpocket.app.data.model.Host
import com.agentpocket.app.data.model.HostRuntime
import com.agentpocket.app.data.model.ModelOption
import com.agentpocket.app.data.model.Project
import com.agentpocket.app.data.model.ThreadDetail
import com.agentpocket.app.data.model.ThreadSummary
import kotlinx.coroutines.flow.StateFlow

/**
 * Screen-facing contract of the app. The production implementation
 * (RpcPocketRepository, WebSocket JSON-RPC to the desktop Bridge over a
 * secure WSS relay) replaces the offline repository without touching screens.
 */
interface PocketRepository {

    val host: StateFlow<Host>
    val hosts: StateFlow<List<Host>>
    val hostRuntimes: StateFlow<Map<String, HostRuntime>>
    val selectedHostId: StateFlow<String?>
    val device: StateFlow<Device>
    val accountDevices: StateFlow<List<Device>>
    val isPaired: StateFlow<Boolean>
    val authStatus: StateFlow<String>
    val threads: StateFlow<List<ThreadSummary>>

    val projects: StateFlow<List<Project>>
    val projectsLoading: StateFlow<Boolean>
    val projectsError: StateFlow<String?>
    val models: StateFlow<List<ModelOption>>
    val actionError: StateFlow<String?>
    val creatingTask: StateFlow<Boolean>

    /** True while a full relay/host sync (startup or manual refresh) is running. */
    val syncing: StateFlow<Boolean>

    /** Human-readable progress line for the running sync, null when idle. */
    val syncStatus: StateFlow<String?>

    /** Encoded thread refs whose full history is being fetched right now. */
    val refreshingThreads: StateFlow<Set<String>>

    fun threadDetail(threadId: String): StateFlow<ThreadDetail>
    fun threadDiff(threadId: String): StateFlow<List<DiffFile>>
    fun openNotification(hostId: String, eventId: String, onResolved: (String?) -> Unit)

    fun refreshProjects()
    fun refreshHostRuntime(hostId: String)
    fun launchDesktop(hostId: String)
    fun hostSupports(capability: String, hostId: String? = null): Boolean

    /** Manually re-runs the full sync pipeline (hosts, devices, snapshots, events, thread lists). */
    fun refreshAll()

    /** Manually re-reads one thread's full history from its host. */
    fun refreshThread(threadId: String)

    /**
     * Marks the thread the user is currently viewing (null when leaving).
     * New assistant messages for other threads increment their unread badge;
     * entering a thread clears it.
     */
    fun setActiveThread(threadId: String?)

    fun selectHost(hostId: String?)

    /** Last used new-task execution target ("bridge" or "desktop"); initial default is "bridge". */
    fun lastTaskTarget(): String

    /**
     * Creates a new task on the selected host. [target] chooses the writer:
     * "desktop" creates a real Codex Desktop task (requires the official
     * Responses WebSocket v2 channel); "bridge" runs it on the host's own
     * codex app-server, which works on any HTTP model channel and enables
     * approvals/questions/interrupt from the phone. [planMode] runs the
     * first turn in Codex's native Plan collaboration mode (bridge only):
     * the model produces a plan document without touching files.
     */
    fun createTask(projectId: String, modelId: String, reasoningId: String, prompt: String, target: String, planMode: Boolean, goal: String?, images: List<Uri>, files: List<Uri>, onCreated: (String) -> Unit)

    /** Reads the thread's persisted goal objective (bridge tasks only); null when unset. */
    fun threadGoal(threadId: String, onResult: (String?) -> Unit)

    /** Sets/replaces the thread goal objective; [onResult] gets the stored objective. */
    fun setThreadGoal(threadId: String, objective: String, onResult: (String?) -> Unit)

    /** Clears the thread goal; [onResult] always gets null on success. */
    fun clearThreadGoal(threadId: String, onResult: (String?) -> Unit)

    /** Appends a user steer message to a running turn. */
    fun sendSteer(threadId: String, text: String, planMode: Boolean = false, images: List<Uri> = emptyList(), files: List<Uri> = emptyList())

    fun interruptTurn(threadId: String)
    fun resolveApproval(threadId: String, requestId: String, decision: ApprovalDecision)
    fun answerQuestion(threadId: String, requestId: String, questionId: String, option: String)

    fun pairManually(wssUrl: String, pairingCode: String)
    fun pairFromQr(payload: String)
    fun login(relayUrl: String, username: String, password: String)
    fun claimInvite(inviteUrl: String, relayUrl: String, username: String, displayName: String, password: String)
    fun approveHostFromQr(payload: String, name: String? = null)
    fun approveDevice(deviceId: String)
    fun revokeAccountDevice(deviceId: String)
    fun resetPairing()
    fun setNotificationsEnabled(enabled: Boolean)
    fun clearActionError()
}
