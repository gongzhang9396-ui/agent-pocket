package com.agentpocket.app.data

import com.agentpocket.app.data.model.MessageStatus
import com.agentpocket.app.data.model.PlanStatus
import com.agentpocket.app.data.model.TimelineItem
import java.io.IOException

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

/** Accept archive markers emitted by both app-server and Desktop task lists. */
internal fun isArchivedThread(archived: Boolean?, isArchived: Boolean?, archivedAtPresent: Boolean): Boolean =
    archived == true || isArchived == true || archivedAtPresent

/** Failures that should be repaired by reconnecting or rebuilding the channel. */
internal fun isTransientConnectionFailure(error: Throwable): Boolean =
    error is IOException || (
        error is BridgeRpcException && error.nameCode in setOf(
            CONNECTION_LOST_CODE,
            CHANNEL_CLOSED_CODE,
            CHANNEL_TIMEOUT_CODE,
            HELLO_REQUIRED_CODE,
        )
    )

/**
 * Replaces the timeline with the server's truth while keeping local-only items
 * the server cannot return yet: unresolved approvals/questions, optimistic or
 * failed user messages, still-streaming messages, and the live plan of the
 * current turn. Server items win on id collision; preserved items keep their
 * relative order after the server items.
 */
internal fun mergeTimelineItems(
    server: List<TimelineItem>,
    existing: List<TimelineItem>,
    baseline: List<TimelineItem>? = null,
): List<TimelineItem> {
    val serverIds = server.mapTo(mutableSetOf()) { it.id }
    val baselineById = baseline?.associateBy { it.id }
    val concurrentById = if (baselineById == null) emptyMap() else existing
        .filter { baselineById[it.id] != it }
        .associateBy { it.id }
    val resolvedServer = server.map { concurrentById[it.id] ?: it }
    val preserved = existing.filter { item ->
        item.id !in serverIds && (
            when (item) {
                is TimelineItem.Approval -> item.decision == null
                is TimelineItem.Question -> item.selectedOption == null
                is TimelineItem.Message -> item.status == MessageStatus.Streaming || item.status == MessageStatus.Failed
                is TimelineItem.Plan -> item.status == PlanStatus.InProgress
                is TimelineItem.Command -> false
            } || baselineById != null && baselineById[item.id] != item
        )
    }
    return resolvedServer + preserved.distinctBy { it.id }
}

/** A latest-page correction retains the already-loaded prefix, without duplicating overlap. */
internal fun mergeTimelinePage(
    server: List<TimelineItem>,
    existing: List<TimelineItem>,
    baseline: List<TimelineItem>,
    earlier: Boolean,
    hasMore: Boolean,
    historyIds: Set<String>,
): List<TimelineItem> {
    if (earlier) {
        val currentIds = existing.mapTo(mutableSetOf()) { it.id }
        val pageById = server.associateBy { it.id }
        val ordered = server.filterNot { it.id in currentIds }.distinctBy { it.id } +
            existing.map { pageById[it.id] ?: it }
        return mergeTimelineItems(ordered, existing, baseline)
    }
    val serverIds = server.mapTo(mutableSetOf()) { it.id }
    val overlap = existing.indexOfFirst { it.id in serverIds }
    val prefix = if (hasMore) {
        (if (overlap >= 0) existing.take(overlap) else existing).filter { it.id in historyIds }
    } else emptyList()
    return mergeTimelineItems(prefix + server, existing, baseline).distinctBy { it.id }
}
