package com.agentpocket.app.data

import com.agentpocket.app.data.model.MessageStatus
import com.agentpocket.app.data.model.PlanStatus
import com.agentpocket.app.data.model.TimelineItem

/** How a stored relay event relates to the host's persisted event cursor. */
internal enum class EventSeqDecision { Skip, Apply, Gap }

/**
 * Pure cursor gating for the per-host event stream. A gap never rewinds the
 * cursor here; the caller schedules a host resync instead, so one missing or
 * broken event cannot wedge every event that follows it.
 */
internal fun eventSeqDecision(lastSeq: Long, seq: Long): EventSeqDecision = when {
    seq <= lastSeq -> EventSeqDecision.Skip
    lastSeq > 0 && seq != lastSeq + 1 -> EventSeqDecision.Gap
    else -> EventSeqDecision.Apply
}

/**
 * Replaces the timeline with the server's truth while keeping local-only items
 * the server cannot return yet: unresolved approvals/questions, optimistic or
 * failed user messages, still-streaming messages, and the live plan of the
 * current turn. Server items win on id collision; preserved items keep their
 * relative order after the server items.
 */
internal fun mergeTimelineItems(server: List<TimelineItem>, existing: List<TimelineItem>): List<TimelineItem> {
    val serverIds = server.mapTo(mutableSetOf()) { it.id }
    val preserved = existing.filter { item ->
        item.id !in serverIds && when (item) {
            is TimelineItem.Approval -> item.decision == null
            is TimelineItem.Question -> item.selectedOption == null
            is TimelineItem.Message -> item.status == MessageStatus.Streaming || item.status == MessageStatus.Failed
            is TimelineItem.Plan -> item.status == PlanStatus.InProgress
            is TimelineItem.Command -> false
        }
    }
    return server + preserved
}
