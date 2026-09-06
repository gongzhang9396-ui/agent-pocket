package com.agentpocket.app.data

import com.agentpocket.app.data.model.ThreadExecution
import com.agentpocket.app.data.model.ThreadStatus
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

internal fun threadExecution(thread: JsonObject): ThreadExecution {
    val execution = thread["execution"] as? JsonObject
    val source = (thread["source"] as? JsonPrimitive)?.contentOrNull
    val backend = (execution?.get("backend") as? JsonPrimitive)?.contentOrNull
        ?: when (source) { "desktop" -> "desktop"; "grok" -> "grok"; else -> "bridge" }
    val owner = (execution?.get("owner") as? JsonPrimitive)?.contentOrNull
    val caps = (execution?.get("capabilities") ?: thread["capabilities"]) as? JsonObject
    val legacy = if (backend == "desktop") ThreadExecution.desktop(owner) else ThreadExecution(owner = owner)
    if (caps == null && execution == null && backend != "grok") return legacy
    fun allowed(name: String) = (caps?.get(name) as? JsonPrimitive)?.booleanOrNull == true
    return ThreadExecution(backend, owner, allowed("send"), allowed("interrupt"), allowed("approval"),
        allowed("question"), allowed("plan"), allowed("goal"), allowed("handoff"),
        if (caps?.containsKey("steer") == true) allowed("steer") else backend != "grok",
        if (caps?.containsKey("attachments") == true) allowed("attachments") else backend != "grok",
        (execution?.get("readOnlyReason") as? JsonPrimitive)?.contentOrNull?.take(1000),
        (execution?.get("statusMessage") as? JsonPrimitive)?.contentOrNull?.take(500))
}

internal fun threadLifecycle(status: JsonObject?, hasInProgressTurn: Boolean = false): ThreadStatus {
    val flags = status?.get("activeFlags")?.toString().orEmpty()
    if ("waitingOnApproval" in flags || "waitingOnUserInput" in flags) return ThreadStatus.NeedsAttention
    if (hasInProgressTurn) return ThreadStatus.Active
    return when ((status?.get("type") as? JsonPrimitive)?.contentOrNull) {
        "active" -> ThreadStatus.Active
        "systemError" -> ThreadStatus.NeedsAttention
        "completed" -> ThreadStatus.Completed
        else -> ThreadStatus.Idle
    }
}
