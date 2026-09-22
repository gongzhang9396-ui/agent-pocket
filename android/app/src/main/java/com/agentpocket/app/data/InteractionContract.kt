package com.agentpocket.app.data

import com.agentpocket.app.data.model.ApprovalDecision
import com.agentpocket.app.data.model.TimelineItem
import kotlinx.serialization.json.*

/** Keep both sides Long: a boxed Int zero is not equal to a Long zero. */
internal fun sameThreadVersion(expected: Long, current: Long?): Boolean = expected == (current ?: 0L)

/** A replayed request cannot erase a confirmed response or a submission in flight. */
internal fun mergeInteractionEvent(existing: TimelineItem?, incoming: TimelineItem): TimelineItem = when {
    existing is TimelineItem.Question && incoming is TimelineItem.Question && existing.requestId == incoming.requestId ->
        incoming.copy(selectedOption = existing.selectedOption, available = existing.available,
            unavailableReason = existing.unavailableReason, pendingOption = existing.pendingOption, submitting = existing.submitting)
    existing is TimelineItem.Approval && incoming is TimelineItem.Approval && existing.requestId == incoming.requestId ->
        incoming.copy(decision = existing.decision, available = existing.available,
            unavailableReason = existing.unavailableReason, submitting = existing.submitting)
    else -> incoming
}

internal fun mergeInteractionSnapshot(existing: TimelineItem, incoming: TimelineItem): TimelineItem = when {
    existing is TimelineItem.Question && incoming is TimelineItem.Question -> incoming.copy(
        selectedOption = incoming.selectedOption ?: existing.selectedOption,
        pendingOption = if (incoming.selectedOption == null) existing.pendingOption else null,
        submitting = incoming.selectedOption == null && existing.submitting)
    existing is TimelineItem.Approval && incoming is TimelineItem.Approval -> incoming.copy(
        decision = incoming.decision ?: existing.decision, submitting = incoming.decision == null && existing.submitting)
    else -> incoming
}

internal fun interactionFromJson(item: JsonObject): TimelineItem? {
    fun text(key: String) = (item[key] as? JsonPrimitive)?.contentOrNull
    val id = text("id")?.takeIf { it.isNotBlank() } ?: return null
    val requestId = text("requestId")?.takeIf { it.isNotBlank() } ?: return null
    val available = (item["available"] as? JsonPrimitive)?.booleanOrNull != false
    return when (text("type")) {
        "pocketQuestion" -> TimelineItem.Question(id, requestId, text("questionId") ?: return null,
            text("prompt").orEmpty(), (item["options"] as? JsonArray).orEmpty().mapNotNull {
                (it as? JsonPrimitive)?.contentOrNull ?: ((it as? JsonObject)?.get("label") as? JsonPrimitive)?.contentOrNull
            }, text("selectedOption"), available, text("unavailableReason"))
        "pocketApproval" -> TimelineItem.Approval(id, requestId, text("summary").orEmpty(), text("command").orEmpty(), text("cwd").orEmpty(),
            when (text("decision")) { "allowOnce" -> ApprovalDecision.AllowOnce; "deny" -> ApprovalDecision.Deny; "cancel" -> ApprovalDecision.Cancel; else -> null },
            available, text("unavailableReason"))
        else -> null
    }
}

internal val grokInteractionEventTypes = setOf("approval.request", "sync.required", "turn.status")

internal fun recoverEncryptedGrokApprovals(accountId: String, hostId: String, threadId: String,
    stored: JsonArray, decrypt: (RelayEnvelope) -> String): List<TimelineItem.Approval> {
    val events = stored.mapNotNull { value ->
        val raw = (value as? JsonObject)?.get("envelope") as? JsonObject ?: return@mapNotNull null
        val envelope = RelayProtocolJson.decodeFromJsonElement<RelayEnvelope>(raw)
        if (envelope.accountId != accountId || envelope.hostId != hostId || envelope.kind != "event.append" ||
            envelope.eventType !in setOf("attention", "status", "completed")) return@mapNotNull null
        // Fail the entire recovery on authentication failure. Skipping a
        // resolution event could present an already closed approval as pending.
        val event = RelayProtocolJson.parseToJsonElement(decrypt(envelope)) as JsonObject
        check((event["eventId"] as? JsonPrimitive)?.contentOrNull == envelope.eventId)
        event.takeIf { (it["type"] as? JsonPrimitive)?.contentOrNull in grokInteractionEventTypes }
    }
    return recoverGrokApprovals(threadId, events)
}

/** Only authenticated, ordered events for this thread belong in this reducer. */
internal fun recoverGrokApprovals(threadId: String, events: List<JsonObject>): List<TimelineItem.Approval> {
    if (!threadId.startsWith("grok:")) return emptyList()
    val requests = linkedMapOf<String, Pair<String, TimelineItem.Approval>>()
    for (event in events) {
        fun JsonObject.text(key: String) = (this[key] as? JsonPrimitive)?.contentOrNull
        if (event.text("threadId") != threadId) continue
        val turnId = event.text("turnId") ?: continue
        val payload = event["payload"] as? JsonObject ?: continue
        when (event.text("type")) {
            "approval.request" -> {
                val item = interactionFromJson(payload) as? TimelineItem.Approval ?: continue
                val prior = requests[item.requestId]?.second
                requests[item.requestId] = turnId to (mergeInteractionEvent(prior, item) as TimelineItem.Approval)
                if (requests.size > 100) requests.remove(requests.keys.first())
            }
            "sync.required", "turn.status" -> {
                val resolved = event.text("type") == "sync.required" && payload.text("reason") == "approval-resolved"
                val ended = event.text("type") == "turn.status" && payload.text("status") in setOf("completed", "idle", "failed", "interrupted", "systemError")
                if (!resolved && !ended) continue
                val requestId = if (resolved) payload.text("requestId") else null
                requests.replaceAll { id, entry ->
                    if (entry.first == turnId && (requestId == null || requestId == id))
                        entry.first to closeRecoveredApproval(entry.second, if (resolved) payload.text("decision") else null)
                    else entry
                }
            }
        }
    }
    return requests.values.map { it.second }
}

internal fun closeRecoveredApproval(item: TimelineItem.Approval, decision: String? = null): TimelineItem.Approval = item.copy(
    decision = item.decision ?: when (decision) { "allowOnce" -> ApprovalDecision.AllowOnce; "deny" -> ApprovalDecision.Deny; "cancel" -> ApprovalDecision.Cancel; else -> null },
    available = false, submitting = false, unavailableReason = "这项审批已处理或已结束",
)

/** Restore controls only: do not replay text deltas or reopen a local response. */
internal fun mergeRecoveredGrokApprovals(existing: List<TimelineItem>, recovered: List<TimelineItem.Approval>): List<TimelineItem> {
    val replacements = recovered.associateBy { it.requestId }
    val seen = mutableSetOf<String>()
    val merged = existing.mapNotNull { item ->
        if (item !is TimelineItem.Approval) item
        else if (!seen.add(item.requestId)) null
        else replacements[item.requestId]?.let { mergeInteractionSnapshot(item, it) } ?: item
    }
    return merged + recovered.filter { it.requestId !in seen && it.available && it.decision == null }
}
