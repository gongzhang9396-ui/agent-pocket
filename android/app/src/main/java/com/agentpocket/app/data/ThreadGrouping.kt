package com.agentpocket.app.data

import com.agentpocket.app.data.model.Project
import com.agentpocket.app.data.model.ThreadSummary

/** One project group in the inbox, mirroring Codex Desktop's project-based task list. */
internal data class ThreadSection(
    val key: String,
    val title: String,
    val cwd: String,
    val hostName: String?,
    val threads: List<ThreadSummary>,
)

/**
 * Groups threads the way Codex Desktop organizes its task list: one section
 * per project (cwd), newest activity first inside each section and across
 * sections. The Desktop project registry supplies display names when
 * available; otherwise the last path segment stands in.
 */
internal fun threadSections(
    threads: List<ThreadSummary>,
    showHost: Boolean,
    projects: List<Project> = emptyList(),
): List<ThreadSection> {
    val names = projects.associateBy({ cwdKey(it.cwd) }, { it.name })
    return threads
        .groupBy { it.hostId to cwdKey(it.cwd) }
        .map { (groupKey, members) ->
            val (hostId, key) = groupKey
            val ordered = members.sortedByDescending { it.updatedAtEpoch }
            ThreadSection(
                key = "$hostId\u001f$key",
                title = names[key] ?: projectNameFromCwd(members.first().cwd),
                cwd = members.first().cwd,
                hostName = members.first().hostName.takeIf { showHost && it.isNotBlank() },
                threads = ordered,
            )
        }
        .sortedByDescending { section -> section.threads.firstOrNull()?.updatedAtEpoch ?: 0 }
}

internal fun projectNameFromCwd(cwd: String): String {
    val name = cwd.trimEnd('\\', '/').substringAfterLast('\\').substringAfterLast('/')
    return name.ifBlank { "未指定项目" }
}

private fun cwdKey(cwd: String): String = cwd.trimEnd('\\', '/').lowercase()
