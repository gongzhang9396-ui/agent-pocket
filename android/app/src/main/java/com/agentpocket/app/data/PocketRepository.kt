package com.agentpocket.app.data

import com.agentpocket.app.data.model.ApprovalDecision
import com.agentpocket.app.data.model.Device
import com.agentpocket.app.data.model.DiffFile
import com.agentpocket.app.data.model.Host
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

    fun threadDetail(threadId: String): StateFlow<ThreadDetail>
    fun threadDiff(threadId: String): StateFlow<List<DiffFile>>
    fun openNotification(hostId: String, eventId: String, onResolved: (String?) -> Unit)

    fun refreshProjects()
    fun selectHost(hostId: String?)
    fun createTask(projectId: String, modelId: String, reasoningId: String, prompt: String, onCreated: (String) -> Unit)

    /** Appends a user steer message to a running turn. */
    fun sendSteer(threadId: String, text: String)

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
