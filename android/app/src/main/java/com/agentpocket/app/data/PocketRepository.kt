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
    val device: StateFlow<Device>
    val isPaired: StateFlow<Boolean>
    val threads: StateFlow<List<ThreadSummary>>

    val projects: StateFlow<List<Project>>
    val models: StateFlow<List<ModelOption>>
    val actionError: StateFlow<String?>
    val creatingTask: StateFlow<Boolean>

    fun threadDetail(threadId: String): StateFlow<ThreadDetail>
    fun threadDiff(threadId: String): StateFlow<List<DiffFile>>

    fun createTask(projectId: String, modelId: String, reasoningId: String, prompt: String, onCreated: (String) -> Unit)

    /** Appends a user steer message to a running turn. */
    fun sendSteer(threadId: String, text: String)

    fun interruptTurn(threadId: String)
    fun resolveApproval(threadId: String, requestId: String, decision: ApprovalDecision)
    fun answerQuestion(threadId: String, requestId: String, questionId: String, option: String)

    fun pairManually(wssUrl: String, pairingCode: String)
    fun pairFromQr(payload: String)
    fun resetPairing()
    fun setNotificationsEnabled(enabled: Boolean)
    fun clearActionError()
}
